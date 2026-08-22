# Changelog

All notable changes to this project will be documented in this file.

## [unreleased]

### Added

- **A global library.** `~/.struktek/` is visible from every workspace, same
  layout one level up. The two merge into one library and the workspace wins a
  name collision, the way `git config` resolves; what it displaced is still
  listed, marked as overridden. Block *types* union instead, so a
  `blocks/depth/` folder written once is a valid field type in every project.
  Moving between the two is a file move, from the sidebar or the palette.
- **Filter and sort**, in the sidebar and over the history. Drawn menus rather
  than panels that unfold, so choosing never moves the list underneath you.
  Filter narrows by tag — and by template as well, over the history. Sort takes
  a field and a direction: relevance, name or date for the library, date or
  template for the feed.
- **A run, in full.** Clicking a prompt in the history opens it over the feed:
  the whole text, the value each field was filled with, and every action. The
  template and blocks it was built from are links — the template opens in the
  composer, a block opens its file.
- **Deleting one prompt** from the history, beside the two Clear actions that
  were previously the only way to remove anything.
- **`Struktek: Report an Issue`**, in the sidebar's title bar. Asks whether it
  is a bug or a feature request and opens that form with the version, editor
  and platform already filled in.
- **Resources and instructions over MCP**, plus `struktek_save_template` and
  `struktek_save_block` behind a write capability the offline bridge does not
  have. Both take a `scope`, offered only when there are two libraries.
- **Headers on blocks.** `title`, `description`, `tags` and `note` in a block's
  frontmatter describe it in the sidebar; everything below the fence is what
  lands in the prompt. Templates gained a `note` too.
- **Editor support for template files.** Diagnostics on the right character,
  highlighted placeholders, hovers that say what a field resolves to, and
  completion for the built-in types, your own block types and their values.
- **A status-bar plug** saying whether the MCP server is up and how many agents
  are attached.

### Changed

- **The panel opens beside** what you are looking at rather than as another tab
  on top of it.
- **The history is the panel's own screen**, replacing the library grid the
  sidebar already was.
- **The use count is gone from the UI.** It survives as a sort key: a number
  beside every row is something you read past on each pass, while the order it
  produces needs no reading at all.
- **The sidebar is drawn the way the Extensions view is** — rows at the
  workbench's own metrics, actions that appear on hover, and a hover card that
  says what a template *is* rather than listing what it asks for.

### Fixed

- **A choice is enforced over MCP.** `struktek_compose` refuses a value that is
  not one of the options rather than composing with it.
- **Sidebar corrections.** Compose opens the panel rather than the QuickPick,
  the view uses the whole width it is given, a block value is paired with its
  type, and a broken template keeps its icon.
- **Menus.** One highlighted row instead of two, a tick that is the right size,
  centred, and clear of the label, and labels that no longer clip their own
  descenders.
- **Fields look like the workbench's.** The metrics are VS Code's own, and a
  select carries a drawn chevron rather than the platform's arrows, which no
  theme can reach.
- **Every colour derives from the active theme**, in both frames, enforced by a
  test that fails on a literal.
- **Colours that vanished in some themes.** Edges and chips were derived from
  tokens a theme is free to leave unset, so they resolved to nothing; they now
  fall through to ones every theme defines. Selected text takes a token pair
  rather than a background with its foreground left to chance.

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
