/**
 * The Struktek output channel.
 *
 * One channel, level-filtered at write time. Kept deliberately small — struktek
 * reads a handful of files and renders strings; there is no pipeline here worth
 * instrumenting, and a logging framework would outweigh what it observes.
 */

import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let channel: vscode.OutputChannel | undefined;
let threshold: LogLevel = 'info';

export function initLog(): vscode.Disposable {
  channel ??= vscode.window.createOutputChannel('Struktek');
  return { dispose: disposeLog };
}

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function log(message: string, data?: unknown, level: LogLevel = 'info'): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const suffix = data === undefined ? '' : ' ' + safeJson(data);
  channel?.appendLine('[' + new Date().toISOString() + '] [' + level + '] ' + message + suffix);
}

log.debug = (message: string, data?: unknown): void => log(message, data, 'debug');
log.warn = (message: string, data?: unknown): void => log(message, data, 'warn');
log.error = (message: string, data?: unknown): void => log(message, data, 'error');

export function showLog(): void {
  channel?.show(true);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    // A circular or otherwise unserialisable payload must not take down the
    // call site that was only trying to log.
    return '[unserialisable]';
  }
}
