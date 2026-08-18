/**
 * The struktek core — the single definition of what a template is.
 *
 * Consumed by the extension host (composer, diagnostics), the standalone MCP
 * bridge, and any future webview. Nothing here imports `vscode` or `node:*`;
 * filesystem and YAML access are injected by the caller.
 */

export * from './types';
export { lex, type LexResult, type Token } from './lex';
export { parse, type ParseResult } from './parse';
export { analyze, type AnalyzeOptions } from './analyze';
export { render, type RenderOptions, type RenderResult } from './render';
export {
  loadBlocks,
  mapBlockReader,
  EMPTY_BLOCK_LIBRARY,
  type BlockLibrary,
  type BlockReader,
} from './blocks';
export {
  loadTemplate,
  splitFrontmatter,
  type LoadTemplateOptions,
  type SplitTemplate,
  type YamlParser,
} from './template';
