/**
 * Read and validate the MCP discovery file.
 *
 * `tryReadDiscovery` is non-throwing on purpose: for struktek, "no live host" is
 * a normal, fully-supported state — the bridge serves templates from disk
 * instead. Absent, malformed, schema-mismatched, and stale-PID all collapse to
 * the same `undefined`, because the caller's response to each is identical.
 */

import * as fs from 'node:fs/promises';
import {
  DISCOVERY_SCHEMA,
  discoveryFilePath,
  type DiscoveryDocument,
} from '../shared/discoveryContract';
import { isProcessAlive } from './processAlive';

export async function tryReadDiscovery(workspaceRoot: string): Promise<DiscoveryDocument | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(discoveryFilePath(workspaceRoot), 'utf8');
  } catch {
    return undefined;
  }

  let document: DiscoveryDocument;
  try {
    document = JSON.parse(raw) as DiscoveryDocument;
  } catch {
    return undefined;
  }

  if (document.schema !== DISCOVERY_SCHEMA) return undefined;
  if (!document.url || !document.token) return undefined;
  // A file whose owning host is gone points at a dead port.
  if (typeof document.pid === 'number' && !isProcessAlive(document.pid)) return undefined;
  return document;
}
