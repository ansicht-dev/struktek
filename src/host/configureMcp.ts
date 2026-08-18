/**
 * The "Configure MCP for Agent" command.
 *
 * Two questions — which agent, and write-or-copy — then either merge our server
 * into their project config or hand it over on the clipboard. The generated
 * entry is static and token-free, so the confirmation can honestly say it is
 * safe to commit.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from './log';
import {
  agentClientLabel,
  buildAgentConfig,
  mergeProjectConfig,
  projectConfigPath,
  projectConfigRelPath,
  type AgentClient,
} from './mcpAgentConfig';

export async function configureMcpCommand(workspaceRoot: string): Promise<void> {
  const client = await pickClient();
  if (!client) return;

  const action = await pickAction(client);
  if (!action) return;

  const input = { workspaceRoot };

  if (action === 'clipboard') {
    await vscode.env.clipboard.writeText(buildAgentConfig(client, input));
    void vscode.window.showInformationMessage(
      'Struktek: MCP config for ' + agentClientLabel(client) + ' copied to the clipboard.',
    );
    return;
  }

  const target = projectConfigPath(client, workspaceRoot);
  const relative = projectConfigRelPath(client);

  let existing: string | undefined;
  try {
    existing = await fs.readFile(target, 'utf8');
  } catch (err) {
    // Only "not there" counts as a fresh create. A permissions or is-a-directory
    // error must not be mistaken for an empty file and overwritten.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      void vscode.window.showErrorMessage('Struktek: could not read ' + relative + ' — ' + String(err));
      return;
    }
  }

  let merged: string;
  try {
    merged = mergeProjectConfig(client, existing, input);
  } catch {
    await vscode.env.clipboard.writeText(buildAgentConfig(client, input));
    void vscode.window.showWarningMessage(
      'Struktek: ' + relative + " couldn't be parsed — copied the config to your clipboard instead.",
    );
    return;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, merged, 'utf8');
  log('Wrote agent MCP config', { client, file: relative });

  const open = 'Open File';
  const choice = await vscode.window.showInformationMessage(
    'Struktek: MCP configured in ' + relative + '. It carries no token, so it is safe to commit.',
    open,
  );
  if (choice === open) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(document);
  }
}

async function pickClient(): Promise<AgentClient | undefined> {
  interface Item extends vscode.QuickPickItem {
    readonly client: AgentClient;
  }
  const items: Item[] = (['claude-code', 'codex'] as const).map((client) => ({
    label: agentClientLabel(client),
    // Showing the target path up front means the write step holds no surprises.
    description: projectConfigRelPath(client),
    client,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Struktek — Configure MCP',
    placeHolder: 'Which agent?',
    ignoreFocusOut: true,
  });
  return picked?.client;
}

async function pickAction(client: AgentClient): Promise<'write' | 'clipboard' | undefined> {
  interface Item extends vscode.QuickPickItem {
    readonly action: 'write' | 'clipboard';
  }
  const items: Item[] = [
    {
      label: '$(new-file) Create project config',
      description: 'writes / merges ' + projectConfigRelPath(client),
      action: 'write',
    },
    {
      label: '$(clippy) Copy to clipboard',
      description: 'paste it in yourself',
      action: 'clipboard',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Struktek MCP for ' + agentClientLabel(client),
    ignoreFocusOut: true,
  });
  return picked?.action;
}
