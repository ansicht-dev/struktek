/**
 * The agent bridge: a stdio MCP server that prefers the live extension host and
 * falls back to reading the library off disk.
 *
 * The bridge is an MCP **server** to the agent over stdio, and an MCP **client**
 * to the running extension host. When the host is up everything is forwarded to
 * it, so there is exactly one writer for usage stats and sticky values. When it
 * is not — VS Code closed, a terminal-only session — the same templates are
 * served straight from disk, because templates are files and composing one has
 * never actually needed an editor.
 *
 * That fallback is the whole reason struktek's bridge differs from the usual
 * proxy shape: `/mcp__struktek__code-review` should work at 2am in a bare
 * terminal, not fail because a GUI is not running.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type GetPromptResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ReadResourceResult,
  type ListPromptsResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as path from 'node:path';
import {
  callToolDirect,
  promptDefinitions,
  promptMessages,
  toolDefinitionsFor,
  readResource,
  resourceEntries,
  RESOURCE_SCHEME,
  SERVER_INSTRUCTIONS,
  type LibraryView,
} from '../shared/mcpSurface';
import { DiskLibrary } from './diskLibrary';
import { BRIDGE_NAME, BRIDGE_VERSION } from './meta';
import { tryReadDiscovery } from './readDiscovery';
import { resolveWorkspaceRoot, type ResolveOptions } from './resolveWorkspace';
import { Upstream } from './upstream';

export { BRIDGE_NAME, BRIDGE_VERSION } from './meta';

export interface BridgeOptions extends ResolveOptions {
  retryMs?: number;
  maxRetryMs?: number;
  /** Skip the upstream entirely and always read from disk (tests). */
  offlineOnly?: boolean;
}

export interface BridgeHandle {
  /** Upstream URL when connected (token-free); undefined when serving from disk. */
  readonly url: string | undefined;
  readonly connected: boolean;
  readonly workspaceRoot: string;
  close(): Promise<void>;
}

export async function connectBridge(
  downstream: Transport,
  options: BridgeOptions = {},
): Promise<BridgeHandle> {
  const workspaceRoot = resolveWorkspaceRoot(options);
  const server = new Server(
    { name: BRIDGE_NAME, version: BRIDGE_VERSION },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  const upstream = new Upstream({
    resolve: () => tryReadDiscovery(workspaceRoot),
    onConnected: () => {
      // The live host may expose a different set than disk did — tell the agent
      // to refetch rather than leave it holding the offline list.
      void server.sendToolListChanged().catch(() => undefined);
      void server.sendPromptListChanged().catch(() => undefined);
    },
    ...(options.retryMs !== undefined ? { retryMs: options.retryMs } : {}),
    ...(options.maxRetryMs !== undefined ? { maxRetryMs: options.maxRetryMs } : {}),
  });

  /**
   * The disk view, built lazily against whichever library root we know about.
   *
   * The discovery document carries the resolved library path because
   * `struktek.libraryPath` is configurable; with no document to consult, the
   * default location is the only reasonable guess.
   */
  let disk: DiskLibrary | undefined;
  let diskRoot: string | undefined;
  const diskView = (): LibraryView => {
    const root = upstream.document?.library ?? path.join(workspaceRoot, '.struktek');
    if (!disk || diskRoot !== root) {
      diskRoot = root;
      disk = new DiskLibrary({ root });
    }
    return disk;
  };

  /**
   * Run against the live host, or fall back to disk.
   *
   * A transport-level failure mid-call means the host rotated or died, so the
   * client is dropped and the call retried once against fresh discovery. Tool
   * errors come back as results rather than throws, so they do not trigger this.
   * The retry assumes the operation is idempotent, which composing a prompt is.
   */
  async function serve<T>(viaHost: (client: Client) => Promise<T>, fromDisk: () => T): Promise<T> {
    if (options.offlineOnly) return fromDisk();
    let client = await upstream.ensure();
    if (!client) return fromDisk();
    try {
      return await viaHost(client);
    } catch {
      upstream.drop(client);
      client = await upstream.ensure();
      if (!client) return fromDisk();
      try {
        return await viaHost(client);
      } catch {
        return fromDisk();
      }
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    serve<ListToolsResult>(
      (client) => client.listTools(request.params) as Promise<ListToolsResult>,
      // What the DISK view can run, which is the read-only pair: with VS Code
      // closed there is nothing watching for a write.
      () => ({ tools: toolDefinitionsFor(diskView()).map((tool) => ({ ...tool })) }),
    ),
  );

  server.setRequestHandler(ListResourcesRequestSchema, (request) =>
    serve<ListResourcesResult>(
      (client) => client.listResources(request.params) as Promise<ListResourcesResult>,
      () => ({ resources: resourceEntries(diskView()) }),
    ),
  );

  // Templates rather than fixed uris, so a client can see the shape of what
  // is addressable even before the list is fetched.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) =>
    serve<ListResourceTemplatesResult>(
      (client) =>
        client.listResourceTemplates(request.params) as Promise<ListResourceTemplatesResult>,
      () => ({
        resourceTemplates: [
          {
            uriTemplate: RESOURCE_SCHEME + 'template/{name}',
            name: 'template',
            description: 'A prompt template as written, frontmatter included.',
            mimeType: 'text/markdown',
          },
          {
            uriTemplate: RESOURCE_SCHEME + 'block/{type}/{instance}',
            name: 'block',
            description: 'One value of a block type, as written.',
            mimeType: 'text/markdown',
          },
        ],
      }),
    ),
  );

  server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    serve<ReadResourceResult>(
      (client) => client.readResource(request.params) as Promise<ReadResourceResult>,
      () => {
        const contents = readResource(diskView(), request.params.uri);
        if (!contents) {
          throw new Error('No such struktek resource: ' + request.params.uri);
        }
        return { contents: [contents] };
      },
    ),
  );

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    serve<CallToolResult>(
      (client) => client.callTool(request.params) as Promise<CallToolResult>,
      () =>
        callToolDirect(
          diskView(),
          request.params.name,
          (request.params.arguments ?? {}) as Record<string, unknown>,
        ) as CallToolResult,
    ),
  );

  server.setRequestHandler(ListPromptsRequestSchema, (request) =>
    serve<ListPromptsResult>(
      (client) => client.listPrompts(request.params) as Promise<ListPromptsResult>,
      () => ({ prompts: promptDefinitions(diskView()).map((prompt) => ({ ...prompt })) }),
    ),
  );

  server.setRequestHandler(GetPromptRequestSchema, (request) =>
    serve<GetPromptResult>(
      (client) => client.getPrompt(request.params) as Promise<GetPromptResult>,
      () =>
        promptMessages(
          diskView(),
          request.params.name,
          (request.params.arguments ?? {}) as Record<string, string | undefined>,
        ) as GetPromptResult,
    ),
  );

  await server.connect(downstream);
  // Best-effort initial connect; being offline is a supported state, not an error.
  if (!options.offlineOnly) await upstream.ensure();

  return {
    get url() {
      return upstream.url;
    },
    get connected() {
      return upstream.connected;
    },
    workspaceRoot,
    close: async () => {
      await server.close().catch(() => undefined);
      await upstream.close();
    },
  };
}
