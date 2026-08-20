/**
 * Whether an agent can actually reach your templates, in the status bar.
 *
 * The MCP server is the part of struktek with no visible surface: it starts
 * during activation, listens on loopback, and says so only in the output
 * channel. When it fails there is nothing to notice — you find out because a
 * slash command is missing, which is a long way from the cause.
 *
 * So the item appears when there is something to say and stays out of the way
 * otherwise. Deliberately off, no workspace, or a remote workspace are not
 * problems and get nothing; running gets a quiet plug, and a failure gets the
 * warning background, which is the one state you could not previously discover.
 *
 * The count is live rather than polled — the server calls back when a session
 * opens or closes. An agent killed outright can leave its session behind until
 * the transport notices, so the number is what the server believes, which is
 * the same thing every MCP client shows.
 */

import * as vscode from 'vscode';
import { showLog } from './log';

export type McpState =
  /** Not running, and not meant to be. Nothing worth a status entry. */
  | { readonly kind: 'off' }
  | { readonly kind: 'running'; readonly url: string; readonly agents: number }
  | { readonly kind: 'failed'; readonly reason: string };

export const MCP_STATUS_COMMAND = 'struktek.mcpStatus';

export interface McpStatusActions {
  readonly configure: () => Thenable<unknown>;
  readonly restart: () => Thenable<unknown>;
}

export class McpStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private state: McpState = { kind: 'off' };

  constructor(private readonly actions: McpStatusActions) {
    // Right-hand side, low priority: this is ambient information, and it should
    // sit outside the language and position indicators rather than among them.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    this.item.command = MCP_STATUS_COMMAND;
    this.item.name = 'Struktek MCP';
  }

  set(state: McpState): void {
    this.state = state;
    this.render();
  }

  /** Re-read the agent count without changing which state we are in. */
  update(agents: number): void {
    if (this.state.kind !== 'running') return;
    this.state = { ...this.state, agents };
    this.render();
  }

  /** The menu behind the item — what you would want next, given the state. */
  async pick(): Promise<void> {
    const state = this.state;
    const items: (vscode.QuickPickItem & { run: () => Thenable<unknown> | void })[] = [];

    if (state.kind === 'failed') {
      items.push({
        label: '$(output) Show Log',
        detail: state.reason,
        run: () => showLog(),
      });
    }
    items.push({
      label: '$(plug) Configure MCP for Agent',
      detail: 'Write the config Claude Code or Codex needs',
      run: () => this.actions.configure(),
    });
    if (state.kind === 'running') {
      items.push({
        label: '$(copy) Copy Server URL',
        detail: state.url,
        run: async () => {
          await vscode.env.clipboard.writeText(state.url);
          void vscode.window.showInformationMessage('Struktek: MCP server URL copied.');
        },
      });
      items.push({ label: '$(output) Show Log', run: () => showLog() });
    }
    items.push({
      label: '$(refresh) Restart Server',
      detail: 'Reconnecting agents pick up the new port automatically',
      run: () => this.actions.restart(),
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Struktek MCP - ' + describe(state),
      placeHolder: 'What would you like to do?',
    });
    await picked?.run();
  }

  private render(): void {
    const state = this.state;
    if (state.kind === 'off') {
      this.item.hide();
      return;
    }

    if (state.kind === 'failed') {
      this.item.text = '$(warning) Struktek';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.tooltip = tooltip([
        '**Struktek MCP did not start.**',
        '',
        state.reason,
        '',
        'Your templates still work everywhere else - this only stops an agent',
        'from reaching them.',
      ]);
      this.item.show();
      return;
    }

    // The count is the answer to "is my agent actually attached", so it earns
    // a place in the label rather than only in the hover.
    this.item.text = state.agents > 0 ? '$(plug) Struktek ' + String(state.agents) : '$(plug) Struktek';
    this.item.backgroundColor = undefined;
    this.item.tooltip = tooltip([
      '**Struktek MCP**',
      '',
      state.agents === 0
        ? 'Listening. No agent attached yet.'
        : String(state.agents) + (state.agents === 1 ? ' agent attached.' : ' agents attached.'),
      '',
      '`' + state.url + '`',
    ]);
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function describe(state: McpState): string {
  if (state.kind === 'failed') return 'not running';
  if (state.kind === 'off') return 'disabled';
  return state.agents === 0 ? 'listening' : String(state.agents) + ' attached';
}

function tooltip(lines: readonly string[]): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(lines.join('\n'));
  markdown.supportThemeIcons = true;
  return markdown;
}
