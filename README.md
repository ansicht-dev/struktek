<p align="center">
  <img src="https://raw.githubusercontent.com/ansicht-dev/struktek/master/assets/struktek.png" alt="Struktek" width="104" height="104">
</p>

<h1 align="center">Struktek</h1>

<p align="center"><strong>Never forget a good prompt.</strong></p>

<p align="center">
  <a href="https://github.com/ansicht-dev/struktek/actions/workflows/ci.yml"><img src="https://github.com/ansicht-dev/struktek/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

Instead of retyping a good prompt from memory or digging it out of a transcript,
compose it from a template with typed fields — then hand it to your agent.

Built by [Ansicht](https://ansicht.dev).

---

## Install

Struktek is published on the [Open VSX Registry][ovsx], so it installs in
VS Code, VSCodium, Cursor, Windsurf, and anything else that uses Open VSX.

[ovsx]: https://open-vsx.org/extension/ansicht/struktek

## The format

A template is a markdown file. Three constructs in the body, nothing else:

| Construct | Meaning |
|---|---|
| `{{ name }}` | a placeholder, type `text` |
| `{{ name: type "description" }}` | typed; the description is optional |
| `[ ... ]` | a segment that vanishes when every placeholder inside it is blank |

```markdown
---
name: code-review
description: Review a file for a specific class of problem
---
Review {{ target: file "path relative to repo root" }} for {{ focus: choice[correctness, perf, security] }}.
[Pay particular attention to {{ emphasis }}.]

{{ format: output-format = json-strict }}
```

Filled in as `target=src/auth.ts, focus=security`, that renders:

```
Review src/auth.ts for security.

Return JSON only — no prose, no code fence, no commentary.
```

The optional line dropped out cleanly, and `format` used its pinned default.

## Types

**Built in:** `text` (the default), `block` (multi-line), `number`, `file`,
and `choice[a, b, c]`.

**Your own — a directory *is* a type, and the files inside it are the instances:**

```
.struktek/
  templates/
    code-review.md
  blocks/
    output-format/          <- the type
      json-strict.md        <- the instances
      markdown-table.md
      prose.md
    depth/
      quick.md
      thorough.md
```

A `choice` yields a word. A block type yields the whole instance file. That
difference is invisible at the call site by design — `{{ format }}` reads the
same either way.

Drop in `blocks/output-format/csv.md` and `csv` becomes valid in *every*
template with an `output-format` field. Improve a block once and everything
using it improves at the same time. That is the part a flat list of snippets
cannot do.

## Rules worth knowing

- **Type once.** A field can appear many times; annotate whichever occurrence
  reads best. Two occurrences with *different* types is an error, not last-wins.
- **`= value` pins a default.** Pre-filled, still overridable — which is why
  there is no separate "always include this block" syntax.
- **Frontmatter is optional and wins.** Reach for it when a field needs a long
  description or a default, and leave the body clean.
- **Brackets with no placeholder inside are prose.** `[see notes]` stays exactly
  as written. Escape a real one as `\[` if you need to.
- **Last-used values come back.** The second time you use a template, each field
  is pre-filled with whatever you picked last time.
- **Blocks can carry a header too.** `title`, `description`, `tags` and `note` in
  frontmatter describe a block in the sidebar. Everything below the fence is
  what actually lands in the prompt — the header never renders.

## History

Every prompt you compose is kept in `.struktek/.runtime/history.jsonl`, which is
git-ignored. `Struktek: Open Panel` opens the feed: newest first, searchable by
what the prompt said, showing which template and which blocks produced it, with
**Copy** and **Create variant** on each one.

Prompts your agent composes over MCP land there too, tagged `mcp` — with one
exception. When VS Code is closed the bridge reads templates straight off disk
and deliberately writes nothing, so there is only ever one writer per file;
prompts composed in a bare terminal are not recorded.

Keep more or fewer with `struktek.history.limit`, or `0` to keep none.

## In the editor

Open a template and Struktek works on it directly: unknown types, conflicting
annotations and unmatched brackets appear in the Problems panel on the right
character, placeholders are highlighted, hovering a field says what it resolves
to, and typing `:` or `=` completes the built-in types, your own block types,
and the values a block type has.

Templates stay ordinary Markdown - no special extension. The editor features
apply to files under your library folder, wherever `struktek.libraryPath`
points.

## Commands

| Command | |
|---|---|
| `Struktek: Compose Prompt` | `Ctrl+Shift+K` — pick a template, fill it, send it |
| `Struktek: New Template` | create a blank template and open it |
| `Struktek: New Block` | add a value to a block type, or start a new type |
| `Struktek: Open Panel` | the history of every prompt you have produced |
| `Struktek: Open Template Library` | browse and edit what you have |
| `Struktek: Configure MCP for Agent` | wire your templates into Claude Code or Codex |

Composing ends with a choice of **Send to Chat** (prefills the chat box without
submitting), **Copy to Clipboard**, **Insert at Cursor**, or **Open in Editor**.

## Agents

Run `Struktek: Configure MCP for Agent` and your templates become available to
your agent two ways at once:

- **As slash commands** — `/mcp__struktek__code-review`, with each field an
  argument. This is MCP's `prompts` primitive, which a template maps onto exactly.
- **As tools** — `struktek_list_templates` and `struktek_compose`, so the *model*
  can pick a template itself. Necessary because MCP prompts are invisible to the
  model: you can invoke one, but the agent cannot see it to choose. This is what
  lets an agent compose a good prompt for its own subagents.

The generated config launches `npx -y @struktek/mcp-bridge` — no port, no token,
no absolute path — so it is static, committable, and survives restarts.

When VS Code is running the bridge proxies to it, keeping one writer for usage
stats and last-used values. When it is not, templates are read straight off
disk, so your slash commands still work in a bare terminal.

## Development

```bash
npm install
npm run build          # or: npm run watch
npm test               # vitest — unit + integration
npm run lint           # tsc --noEmit
npm run package:bridge # build the publishable npm bridge
```

## Settings

| Setting | Default | |
|---|---|---|
| `struktek.libraryPath` | `.struktek` | where templates and blocks live |
| `struktek.mcp.enabled` | `true` | run the MCP server so agents can reach your templates |
| `struktek.logLevel` | `info` | verbosity of the Struktek output channel |

`F5` launches an Extension Development Host on `test-fixtures/workspace`.
`npm run install:local` packages the `.vsix` and installs it into every editor
CLI it finds — VS Code, VSCodium, Insiders, Cursor, Windsurf.

The parser lives in [`src/core/`](src/core/) and imports nothing — no `vscode`,
no `node:*`. Filesystem and YAML access are injected, so the extension host, the
MCP bridge, and any future webview all run the same code.

## Status and licence

Pre-release (`0.1.0`) and shaped by daily use, so expect the format to move
before `1.0`.

The source is public to read, review, and learn from. It is **not** open
source: struktek is proprietary, all rights reserved — see
[LICENSE.txt](LICENSE.txt). Your templates and blocks are entirely yours; the
licence claims nothing over anything you author with it.

Bug reports and ideas are welcome in [issues][issues]. Security issues should
go through [SECURITY.md](SECURITY.md) rather than a public issue.

[issues]: https://github.com/ansicht-dev/struktek/issues
