/**
 * The live MCP server: a loopback HTTP endpoint plus its discovery file.
 *
 * Agents spawn stdio MCP servers, but the useful state — the watched library,
 * the usage stats — lives in this extension host. So the host listens on HTTP
 * and a tiny published bridge proxies stdio to it, finding the ephemeral
 * port + token through `.struktek/.runtime/mcp.json`. That keeps the agent's
 * config STATIC: no port, no token, nothing that goes stale across restarts.
 *
 * Several details here are load-bearing and were learned the hard way in the
 * sibling implementation:
 *   - assign `httpServer` BEFORE awaiting the bind, so a racing `close()` can
 *     find and destroy it;
 *   - re-check `closing` after every await, and delete the discovery file again
 *     on the abort path — otherwise a file written after teardown survives on
 *     disk carrying a live token;
 *   - call `closeAllConnections()` before `close()`, or a held-open SSE stream
 *     makes shutdown hang forever.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  DISCOVERY_SCHEMA,
  discoveryFilePath,
  type DiscoveryDocument,
} from '../shared/discoveryContract';
import { createStruktekServer, type LibraryView, type StruktekServer } from '../shared/mcpSurface';
import { log } from './log';

export const MCP_ENDPOINT = '/mcp';

export interface McpContext {
  readonly workspaceRoot: string;
  readonly libraryRoot: string;
  readonly version: string;
  /** Read per request, never snapshotted — the library is watched and mutates. */
  readonly view: () => LibraryView;
  /**
   * Called when an agent connects or disconnects.
   *
   * A callback rather than an event emitter because this module deliberately
   * imports no `vscode` — it is the one host module that is pure node, and the
   * status bar can adapt rather than the server reaching for the workbench.
   */
  readonly onSessionsChanged?: () => void;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly struktek: StruktekServer;
}

export class McpServerHost {
  private httpServer: http.Server | undefined;
  private token: string | undefined;
  private closing = false;
  private readonly sessions = new Map<string, Session>();
  private listeningUrl: string | undefined;

  constructor(private readonly context: McpContext) {}

  get url(): string | undefined {
    return this.listeningUrl;
  }

  /** How many agents are attached right now. */
  get agents(): number {
    return this.sessions.size;
  }

  /** Tell every live session the prompt list changed. */
  refreshPrompts(): void {
    for (const session of this.sessions.values()) {
      try {
        session.struktek.refreshPrompts();
        session.struktek.server.sendPromptListChanged();
      } catch (err) {
        log.debug('Could not refresh prompts on a session', { error: String(err) });
      }
    }
  }

  async listen(): Promise<string> {
    this.closing = false;
    this.token = randomBytes(32).toString('hex');

    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    // Assigned before the await so a concurrent close() has something to destroy.
    this.httpServer = server;

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('MCP server bound to an unexpected address'));
      });
    });
    await this.abortIfClosing();

    this.listeningUrl = 'http://127.0.0.1:' + String(port) + MCP_ENDPOINT;
    await this.writeDiscovery(this.listeningUrl, this.token);
    await this.abortIfClosing();

    log('MCP server listening', { url: this.listeningUrl });
    return this.listeningUrl;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.teardown();
  }

  /**
   * Unwind a listen that a close() raced.
   *
   * The discovery file is deleted using the context's stable root rather than
   * any field teardown may have already nulled — a token file left behind is
   * the one failure here that actually matters.
   */
  private async abortIfClosing(): Promise<void> {
    if (!this.closing) return;
    await this.teardown();
    await this.deleteDiscovery();
    throw new Error('MCP listen() aborted by a concurrent close()');
  }

  private async teardown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.transport.close().catch(() => undefined);
      await session.struktek.server.close().catch(() => undefined);
    }
    this.sessions.clear();

    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) {
      // Without this an open SSE stream keeps the server alive indefinitely.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.deleteDiscovery();
    this.token = undefined;
    this.listeningUrl = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // Authorisation first, unconditionally. A session id is not a credential.
      if (!this.isAuthorized(req)) {
        respond(res, 401, { error: 'unauthorized' });
        return;
      }
      const url = req.url ?? '';
      if (!url.startsWith(MCP_ENDPOINT)) {
        respond(res, 404, { error: 'not found' });
        return;
      }

      const body = await readJsonBody(req);
      const sessionId = headerValue(req, 'mcp-session-id');

      let transport: StreamableHTTPServerTransport;
      const existing = sessionId ? this.sessions.get(sessionId) : undefined;
      if (existing) {
        transport = existing.transport;
      } else if (!sessionId && isInitializeRequest(body)) {
        transport = await this.openSession();
      } else {
        respond(res, 400, { error: 'no valid session — initialize first' });
        return;
      }

      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error('MCP request failed', { error: String(err) });
      if (!res.headersSent) respond(res, 500, { error: 'internal error' });
    }
  }

  /**
   * Stand up a server for a new session.
   *
   * The connect MUST complete before the initialize request is handed to the
   * transport — handing a request to a server that has not finished connecting
   * fails the handshake with an opaque internal error.
   */
  private async openSession(): Promise<StreamableHTTPServerTransport> {
    const struktek = createStruktekServer(this.context.view, this.context.version);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(16).toString('hex'),
      onsessioninitialized: (id) => {
        // Do not repopulate a map teardown has already cleared.
        if (this.closing || !this.httpServer) {
          void transport.close();
          return;
        }
        this.sessions.set(id, { transport, struktek });
        this.context.onSessionsChanged?.();
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
        this.context.onSessionsChanged?.();
      }
    };
    await struktek.server.connect(transport);
    return transport;
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    if (!this.token) return false;
    const header = headerValue(req, 'authorization');
    const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
    if (!match?.[1]) return false;
    const presented = Buffer.from(match[1]);
    const expected = Buffer.from(this.token);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  private async writeDiscovery(url: string, token: string): Promise<void> {
    const file = discoveryFilePath(this.context.workspaceRoot);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    await ensureSelfIgnore(dir);
    const document: DiscoveryDocument = {
      url,
      token,
      workspace: this.context.workspaceRoot,
      library: this.context.libraryRoot,
      pid: process.pid,
      schema: DISCOVERY_SCHEMA,
    };
    await fs.writeFile(file, JSON.stringify(document, null, 2) + '\n', 'utf8');
  }

  /**
   * Remove the discovery file, but only if it is still ours.
   *
   * Two windows on the same folder share one discovery path, and the last to
   * start owns it. Deleting unconditionally meant closing EITHER window made
   * the other undiscoverable while its server was still listening — the agent
   * would quietly drop to offline mode with a perfectly good host running.
   */
  private async deleteDiscovery(): Promise<void> {
    const file = discoveryFilePath(this.context.workspaceRoot);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const owner = (JSON.parse(raw) as Partial<DiscoveryDocument>).pid;
      // Unparseable or PID-less: ours by default, since nothing else claims it.
      if (typeof owner === 'number' && owner !== process.pid) return;
    } catch {
      // Absent, or unreadable — fall through and try the unlink anyway.
    }
    try {
      await fs.unlink(file);
    } catch {
      // Never written, or already gone — either way there is nothing to do.
    }
  }
}

/**
 * Make the runtime directory ignore itself.
 *
 * The discovery file carries a live bearer token and lands inside the user's
 * repository, so it must not be committable even if their root `.gitignore`
 * says nothing about it. Only this directory is touched, and an existing
 * ignore file is appended to rather than replaced.
 */
async function ensureSelfIgnore(dir: string): Promise<void> {
  const gitignore = path.join(dir, '.gitignore');
  let existing: string | undefined;
  try {
    existing = await fs.readFile(gitignore, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing === undefined) {
    await fs.writeFile(gitignore, '*\n', 'utf8');
    return;
  }
  const covered = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === '*' || line === 'mcp.json' || line === '/mcp.json');
  if (covered) return;
  await fs.writeFile(gitignore, existing + (existing.endsWith('\n') ? '' : '\n') + 'mcp.json\n', 'utf8');
}

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function respond(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
