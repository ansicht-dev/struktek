/**
 * Generating the MCP config an agent needs, and merging it into their file.
 *
 * The emitted config launches the published bridge via `npx -y`, so it carries
 * no machine-absolute path to the extension and no token. That is what makes it
 * STATIC: it survives extension updates, it is safe to commit and share, and it
 * keeps working across restarts because the bridge discovers the rotating
 * url + token itself.
 *
 * Pure string and path logic, no `vscode`, so it unit-tests directly.
 */

import * as path from 'node:path';

export type AgentClient = 'claude-code' | 'codex';

export const MCP_SERVER_KEY = 'struktek';
export const BRIDGE_PACKAGE = '@struktek/mcp-bridge';

export interface AgentConfigInput {
  /** Workspace root the bridge resolves the discovery file under. */
  readonly workspaceRoot: string;
}

export function agentClientLabel(client: AgentClient): string {
  return client === 'codex' ? 'Codex' : 'Claude Code';
}

/** The agent's project-scoped config file, relative to the workspace root. */
export function projectConfigRelPath(client: AgentClient): string {
  return client === 'codex' ? path.join('.codex', 'config.toml') : '.mcp.json';
}

export function projectConfigPath(client: AgentClient, workspaceRoot: string): string {
  return path.join(workspaceRoot, projectConfigRelPath(client));
}

/**
 * The stdio launch, shared by every shape.
 *
 * The package version deliberately floats: npx resolves a published version, and
 * the bridge validates the discovery `schema` and fails clearly on a mismatch,
 * which is the real compatibility boundary. Pinning here would only add a number
 * to keep in step.
 */
function serverEntry(input: AgentConfigInput): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', BRIDGE_PACKAGE, '--workspace', input.workspaceRoot] };
}

function claudeDocument(input: AgentConfigInput): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: serverEntry(input) } }, null, 2) + '\n';
}

function codexTable(input: AgentConfigInput): string {
  const { command, args } = serverEntry(input);
  const list = args.map((arg) => JSON.stringify(arg)).join(', ');
  return (
    '[mcp_servers.' + MCP_SERVER_KEY + ']\n' +
    'command = ' + JSON.stringify(command) + '\n' +
    'args = [' + list + ']\n'
  );
}

/** The clipboard form: a complete document holding just our server. */
export function buildAgentConfig(client: AgentClient, input: AgentConfigInput): string {
  return client === 'codex' ? codexTable(input) : claudeDocument(input);
}

/**
 * Merge our server into the agent's existing project config.
 *
 * Throws only when `existing` is present but unparseable — the caller then
 * declines to clobber and falls back to the clipboard. Silently overwriting
 * someone's other MCP servers because we could not read their file would be
 * unforgivable for a convenience command.
 */
export function mergeProjectConfig(
  client: AgentClient,
  existing: string | undefined,
  input: AgentConfigInput,
): string {
  return client === 'codex' ? mergeCodex(existing, input) : mergeClaude(existing, input);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeClaude(existing: string | undefined, input: AgentConfigInput): string {
  let document: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim().length > 0) {
    const parsed: unknown = JSON.parse(existing);
    if (!isPlainObject(parsed)) throw new Error('.mcp.json is not a JSON object');
    document = parsed;
  }
  const servers = isPlainObject(document['mcpServers']) ? document['mcpServers'] : {};
  document['mcpServers'] = { ...servers, [MCP_SERVER_KEY]: serverEntry(input) };
  return JSON.stringify(document, null, 2) + '\n';
}

/**
 * TOML merge by table replacement.
 *
 * A full TOML parser would be a dependency for one command; instead the existing
 * `[mcp_servers.struktek]` table is located and replaced verbatim, and anything
 * else in the file is left untouched byte for byte.
 */
function mergeCodex(existing: string | undefined, input: AgentConfigInput): string {
  const table = codexTable(input);
  if (existing === undefined || existing.trim().length === 0) return table;

  const header = '[mcp_servers.' + MCP_SERVER_KEY + ']';
  const start = existing.indexOf(header);
  if (start === -1) {
    return existing + (existing.endsWith('\n') ? '' : '\n') + '\n' + table;
  }
  // Replace through to the next table header, or to end of file.
  const rest = existing.slice(start + header.length);
  const nextHeader = /\n\s*\[/.exec(rest);
  const end = nextHeader ? start + header.length + nextHeader.index + 1 : existing.length;
  return existing.slice(0, start) + table + existing.slice(end);
}
