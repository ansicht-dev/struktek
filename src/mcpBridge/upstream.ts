/**
 * Keeps a live MCP client to the extension host, across the host's whole lifecycle.
 *
 * Port and token rotate on every restart — window reload, workspace change,
 * a bind retry — so a one-shot connect goes stale. This treats the discovery
 * file as LIVE state: every attempt re-reads it, so a reconnect always picks up
 * the current url and token. `resolve()` returning undefined means "no host
 * right now", which for struktek is a normal state, not a failure.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DiscoveryDocument } from '../shared/discoveryContract';
import { BRIDGE_NAME, BRIDGE_VERSION } from './meta';

const DEFAULT_RETRY_MS = 2000;
const DEFAULT_MAX_RETRY_MS = 30000;

export interface UpstreamOptions {
  /** Resolve the current discovery document; undefined means unavailable. */
  resolve: () => Promise<DiscoveryDocument | undefined>;
  /** Fired on each disconnected-to-connected transition. */
  onConnected?: (document: DiscoveryDocument) => void;
  retryMs?: number;
  maxRetryMs?: number;
}

export class Upstream {
  private client: Client | undefined;
  private connecting: Promise<Client | undefined> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backoff: number;
  private closed = false;
  /** The live connection's URL (token-free); undefined when disconnected. */
  url: string | undefined;
  /** The discovery document behind the current or last attempted connection. */
  document: DiscoveryDocument | undefined;

  constructor(private readonly options: UpstreamOptions) {
    this.backoff = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  /** A live client, attempting a single de-duplicated connect if needed. */
  async ensure(): Promise<Client | undefined> {
    if (this.client) return this.client;
    if (this.closed) return undefined;
    this.connecting ??= this.attempt();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  /** Evict `client` if it is the current one — its connection just failed. */
  drop(client: Client): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.url = undefined;
    client.onclose = undefined;
    void client.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const client = this.client;
    this.client = undefined;
    this.url = undefined;
    if (client) {
      client.onclose = undefined;
      await client.close().catch(() => undefined);
    }
  }

  private async attempt(): Promise<Client | undefined> {
    const document = await this.options.resolve();
    this.document = document;
    if (!document || this.closed) {
      this.scheduleRetry();
      return undefined;
    }

    const client = new Client({ name: BRIDGE_NAME, version: BRIDGE_VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(document.url), {
      requestInit: { headers: { Authorization: 'Bearer ' + document.token } },
    });
    try {
      await client.connect(transport);
    } catch {
      await client.close().catch(() => undefined);
      this.scheduleRetry();
      return undefined;
    }
    // A close() raced this connect. Drop the fresh client and do NOT retry —
    // asymmetric with the failure paths above on purpose: closed means closed.
    if (this.closed) {
      await client.close().catch(() => undefined);
      return undefined;
    }

    client.onclose = () => this.handleDrop();
    this.client = client;
    this.url = document.url;
    this.backoff = this.options.retryMs ?? DEFAULT_RETRY_MS;
    this.options.onConnected?.(document);
    return client;
  }

  /** The transport closed under us — the host went away or rotated. */
  private handleDrop(): void {
    if (!this.client) return;
    this.client = undefined;
    this.url = undefined;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.closed || this.timer || this.client) return;
    const delay = this.backoff;
    this.backoff = Math.min(delay * 2, this.options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ensure();
    }, delay);
    // A pending retry must never hold the process open on its own.
    this.timer.unref?.();
  }
}
