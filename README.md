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

## Two libraries

Templates live in `.struktek/` in your workspace. They can also live in
`~/.struktek/`, which is visible from **every** workspace — the same layout,
one level up:

```
~/.struktek/                 <- global, everywhere
  templates/commit-message.md
  blocks/depth/forensic.md

my-project/.struktek/        <- this project only
  templates/code-review.md
  blocks/depth/forensic.md   <- wins; the global one is shown as overridden
```

The two are merged into one library. **The workspace wins a name collision**,
the way `git config` and VS Code settings resolve — so a project can override a
global template without renaming anything, and the copy it displaced is still
listed, marked as overridden, so you can see why.

Block *types* union rather than collide: a `blocks/depth/` folder in your global
library makes `{{ how: depth }}` a valid field in every project you open.

**Moving between them is a file move.** Any row in the sidebar has a globe
(make global) or a folder (make workspace-only), and the same pair is in the
palette as `Struktek: Make Global` / `Struktek: Make Workspace-Only`. A block
type moves as a unit — all of its values.

Struktek asks first when the move is not just a move: when the destination name
is taken, when demoting something you might rely on elsewhere, and — the one
worth the dialog — when promoting a template whose block types exist only in
this workspace. That last one reads fine here and reports an unknown type in
every *other* project, so it offers to bring the blocks along.

Templates in the global library work with no folder open at all, and the offline
MCP bridge reads both roots, so a global template is there in a bare terminal
too. Use counts and history stay per-workspace: how often you reach for a
template *here* is the useful question.

Set `struktek.globalLibrary.path` to keep it somewhere else, or
`struktek.globalLibrary.enabled` to `false` to use the workspace library alone.

## Finding things

The search box narrows templates and blocks as you type, matching names,
descriptions, notes and tags. Two buttons sit beside it, each opening a menu
with submenus — menus rather than panels that unfold, so choosing never moves
the list underneath you.

**Filter** holds one section per dimension. In the sidebar that is Tags; tick
as many as you like and the funnel fills in while a filter is on.

**Sort** holds one submenu per field, each with both directions:

| | |
|---|---|
| Relevance | Most used · Least used |
| Name | Alphabetical · Reverse alphabetical |
| Date | Newest · Oldest |

The field the list is currently ordered by carries the name of that order
beside it, so how a list is sorted is readable without opening anything.

Most used is the default and counts prompts composed from a template *in this
workspace*. You will not find that number anywhere in the UI, and that is on
purpose: a count beside every row is something you read past on each pass,
while the order it produces needs no reading at all. Blocks carry no such
count, so they stay alphabetical whichever sort is chosen.

Overridden rows sort last under every option — a struck-through row should
never sit above one you can actually compose.

The history screen has the same row over prompts instead of templates: Filter
holds Templates and Tags, and Sort holds Date and Template. Ordered by
template, the runs inside one name stay newest-first — the name is the key you
chose, and recency is still what you want to read first inside it.

## The panel

`Struktek: Open Panel` opens *beside* what you are looking at rather than as
another tab on top of it — the panel is something you compose **from**, so the
one thing it must not do is hide the file you opened it for. Two screens.

**Compose** is the fields on the left and the prompt as it will be sent on the
right, split by a divider you can drag - how much room a form needs depends on
the template, and how much a preview needs depends on the prompt. Optional
fields fold away so a template reads as long as it actually is. The template
name is also the switcher.

**History** is every prompt you have composed, newest first. The search box
matches the prompt text, the template, its tags and the values behind it, and
the funnel and sort button beside it work as they do in the sidebar.

Click a run to open it in full: the whole prompt, scrolling on its own, the
value each field was filled with, and every action the card carries. What it
was made *from* is a set of links — the template opens in the composer, a block
opens its file — which is the one thing a prompt cannot tell you by reading it.

Copy takes the text. Create variant reopens the composer with the values that
run actually used. The bin removes that one run, and asks nothing: it is a line
in a log and it is in front of you when you press it, where clearing a
template's history or all of it throws away runs you cannot see and still asks
first. Runs are kept in `.struktek/.runtime/history.jsonl`, which is
git-ignored.

There is no library screen: the sidebar is the library, and a second grid of
the same templates was one surface too many.

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
| `Struktek: Open Panel` | the composer, and the history of every prompt you have produced |
| `Struktek: Open Template Library` | browse and edit what you have |
| `Struktek: Make Global` | move a template or block into `~/.struktek`, for every workspace |
| `Struktek: Make Workspace-Only` | move it back into this project |
| `Struktek: Reveal Global Library` | open `~/.struktek` in your file manager |
| `Struktek: Configure MCP for Agent` | wire your templates into Claude Code or Codex |
| `Struktek: Report an Issue` | open a bug report or a feature request, prefilled |

Composing ends with a choice of **Send to Chat** (prefills the chat box without
submitting), **Copy to Clipboard**, **Insert at Cursor**, or **Open in Editor**.

## Agents

Run `Struktek: Configure MCP for Agent` and your templates become available to
your agent three ways at once:

- **As slash commands** — `/mcp__struktek__code-review`, with each field an
  argument. This is MCP's `prompts` primitive, which a template maps onto exactly.
- **As tools** — `struktek_list_templates` and `struktek_compose`, so the *model*
  can pick a template itself. Necessary because MCP prompts are invisible to the
  model: you can invoke one, but the agent cannot see it to choose. This is what
  lets an agent compose a good prompt for its own subagents.
- **As resources** — `struktek://template/{name}` and
  `struktek://block/{type}/{instance}`, returning a file as written. Listing a
  template reports its fields; reading the resource is the only way to see its
  *wording*, which is what an agent needs before it edits one.

On connect the server also sends instructions — that there is a library worth
checking before writing a prompt from scratch, that a block type is shared
vocabulary, and that composing reports what it left unfilled. Tool descriptions
are read after deciding to look; instructions arrive before.

A plug in the status bar says whether the server is up and how many agents are
attached; it turns amber if the server could not start, which is the one
failure you would otherwise only find in the output channel. Click it to
configure an agent, copy the URL, read the log, or restart. Nothing appears
when MCP is switched off or the workspace cannot host it.

The generated config launches `npx -y @struktek/mcp-bridge` — no port, no token,
no absolute path — so it is static, committable, and survives restarts.

When VS Code is running the bridge proxies to it, keeping one writer for usage
stats and last-used values. When it is not, templates are read straight off
disk — both libraries, merged the same way — so your slash commands still work
in a bare terminal.

`struktek_save_template` and `struktek_save_block` take a `scope`, offered only
when there are two libraries to choose between. It defaults to the workspace:
an agent should not make something global for every project you open unless you
asked for it.

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
| `struktek.libraryPath` | `.struktek` | where this workspace's templates and blocks live |
| `struktek.globalLibrary.enabled` | `true` | also load a library visible from every workspace |
| `struktek.globalLibrary.path` | `~/.struktek` | where that library lives |
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

Bug reports and ideas are welcome in [issues][issues] — or from the sidebar's
title bar, which asks whether you are reporting a bug or requesting a feature
and opens that form with the version, editor and platform already filled in.
Security issues should go through [SECURITY.md](SECURITY.md) rather than a
public issue.

[issues]: https://github.com/ansicht-dev/struktek/issues
