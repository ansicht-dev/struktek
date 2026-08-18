# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-08-18

First release. Compose prompts from templates with typed fields, and hand them
to an agent.

### Features

- **Template format.** `{{ field: type "description" }}` placeholders and
  `[ ... ]` optional segments that collapse when every placeholder inside them
  is blank. Types are `text`, `block`, `number`, `file`, and `choice[a, b, c]`.
- **Block types.** A directory under `blocks/` *is* a user-defined type and the
  files inside it are its values, so adding `blocks/output-format/csv.md` makes
  `csv` valid in every template with an `output-format` field.
- **Composer.** `Ctrl+Shift+K` walks a QuickPick per field, then sends to chat,
  copies, inserts at the cursor, or opens in an editor. Last-used values return
  on the next run.
- **Panel.** A library of cards with description, tags, use count and last-used,
  searchable and filterable by tag. Opening one gives the compose form beside a
  **live preview** that updates as you type — the same renderer an agent gets,
  running in the frame, so the two cannot drift.
- **History.** Every prompt you generate is kept, with its timestamp and the
  values behind it. Reread one, copy it, or reuse its values and change a single
  input instead of retyping all of them. Stored per workspace in
  `.struktek/.runtime`, which is git-ignored.
- **Tags.** `tags: [review, quality]` in frontmatter, for filtering a library
  once it outgrows a single screen.
- **Activity-bar view.** Templates in use order as a launcher into the panel,
  with their fields on hover. Blocks browsable underneath.
- **MCP.** Templates are served both as prompts — slash commands like
  `/mcp__struktek__code-review` — and as tools, so an agent can pick a template
  itself when composing for a subagent. `Struktek: Configure MCP for Agent`
  writes the config for Claude Code or Codex.
- **Works with the editor closed.** When no extension host is running the
  bridge reads the library straight off disk, so slash commands still resolve
  from a bare terminal.
