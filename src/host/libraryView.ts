/**
 * The Struktek activity-bar view: the template library as a tree.
 *
 * The QuickPick composer is the fast path once you know what you want; this is
 * the one for when you don't. Templates come first and in use order, because
 * picking one is the common act — blocks sit underneath, collapsed, since they
 * are edited far less often than they are referenced.
 *
 * A template row composes on click rather than opening its file. Opening is the
 * rarer intent and stays available as an inline action.
 */

import * as vscode from 'vscode';
import type { Field, TemplateModel } from '../core';
import type { Library, TemplateEntry } from './library';
import type { Stats } from './stats';

type Node =
  | { readonly kind: 'template'; readonly entry: TemplateEntry }
  | { readonly kind: 'blocksRoot' }
  | { readonly kind: 'blockType'; readonly type: string }
  | { readonly kind: 'blockInstance'; readonly type: string; readonly instance: string };

export class LibraryTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  /**
   * Accessors rather than instances: the view is created once at activation and
   * outlives any single session, so a workspace change swaps what it reads
   * without the tree being torn down and rebuilt.
   */
  constructor(
    private readonly getLibrary: () => Library | undefined,
    private readonly getStats: () => Stats | undefined,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const library = this.getLibrary();
    const stats = this.getStats();
    if (!library || !stats) return [];

    if (!node) {
      const templates = stats
        .order(library.names())
        .map((name) => library.get(name))
        .filter((entry): entry is TemplateEntry => entry !== undefined)
        .map((entry): Node => ({ kind: 'template', entry }));
      // Only offer the Blocks section when there is something in it — an empty
      // expander teaches nothing and costs a row.
      return library.blocks.names.size > 0 ? [...templates, { kind: 'blocksRoot' }] : templates;
    }

    if (node.kind === 'blocksRoot') {
      return [...library.blocks.names.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map((type): Node => ({ kind: 'blockType', type }));
    }

    if (node.kind === 'blockType') {
      return (library.blocks.names.get(node.type) ?? [])
        .map((instance): Node => ({ kind: 'blockInstance', type: node.type, instance }));
    }

    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const library = this.getLibrary();
    switch (node.kind) {
      case 'template':
        return templateItem(node.entry, this.getStats());
      case 'blocksRoot': {
        const item = new vscode.TreeItem('Blocks', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.description = String(library?.blocks.names.size ?? 0) + ' types';
        item.tooltip = 'Your own field types. A folder under blocks/ is a type; the files in it are its values.';
        return item;
      }
      case 'blockType': {
        const instances = library?.blocks.names.get(node.type) ?? [];
        const item = new vscode.TreeItem(node.type, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('symbol-enum');
        item.description = String(instances.length);
        item.contextValue = 'struktekBlockType';
        return item;
      }
      case 'blockInstance': {
        const item = new vscode.TreeItem(node.instance, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('symbol-text');
        item.tooltip = firstLine(library?.blocks.bodies.get(node.type)?.get(node.instance) ?? '');
        item.contextValue = 'struktekBlockInstance';
        item.command = {
          command: 'struktek.openBlock',
          title: 'Open Block',
          arguments: [node.type, node.instance],
        };
        return item;
      }
    }
  }
}

function templateItem(entry: TemplateEntry, stats: Stats | undefined): vscode.TreeItem {
  const { model } = entry;
  const item = new vscode.TreeItem(model.name, vscode.TreeItemCollapsibleState.None);
  const errors = model.diagnostics.filter((d) => d.severity === 'error').length;
  const uses = stats?.uses(model.name) ?? 0;

  item.description = [
    uses > 0 ? String(uses) + '×' : undefined,
    errors > 0 ? String(errors) + ' error' + (errors === 1 ? '' : 's') : undefined,
  ]
    .filter(Boolean)
    .join('  ');

  // A broken template still lists — you cannot fix what the view hides.
  item.iconPath = new vscode.ThemeIcon(errors > 0 ? 'warning' : 'symbol-snippet');
  item.tooltip = tooltipFor(model);
  item.resourceUri = entry.uri;
  item.contextValue = 'struktekTemplate';
  item.command = {
    command: 'struktek.compose',
    title: 'Compose',
    arguments: [model.name],
  };
  return item;
}

/** A hover that answers "what will this ask me for?" without opening the file. */
function tooltipFor(model: TemplateModel): vscode.MarkdownString {
  const lines: string[] = [];
  if (model.description) lines.push(model.description, '');
  if (model.fields.length === 0) lines.push('_No fields — composes as written._');
  else {
    lines.push('| Field | Type | |', '|---|---|---|');
    for (const field of model.fields) lines.push('| `' + field.name + '` | ' + typeLabel(field) + ' | ' + (field.required ? '' : 'optional') + ' |');
  }
  for (const diagnostic of model.diagnostics) {
    lines.push('', '$(' + (diagnostic.severity === 'error' ? 'error' : 'warning') + ') ' + diagnostic.message);
  }
  const tooltip = new vscode.MarkdownString(lines.join('\n'));
  tooltip.supportThemeIcons = true;
  return tooltip;
}

function typeLabel(field: Field): string {
  if (field.type.kind === 'choice') return field.type.options.join(' \\| ');
  if (field.type.kind === 'blockType') return '`' + field.type.name + '`';
  return field.type.kind;
}

function firstLine(body: string): string {
  const line = body.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 200 ? line.slice(0, 197) + '...' : line;
}
