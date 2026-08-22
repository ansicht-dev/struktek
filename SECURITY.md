# Security

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue —
use [GitHub's private advisory form][advisory], or email security@ansicht.dev.
The in-editor **Report an Issue** button opens a *public* form, so it is the
wrong door for a vulnerability.

[advisory]: https://github.com/ansicht-dev/struktek/security/advisories/new

Expect an acknowledgement within a few working days. Struktek is a pre-release
project maintained by one person, so please allow reasonable time for a fix
before disclosing publicly.

## What struktek touches

Worth knowing if you are reviewing it:

- **A local MCP server.** When a workspace is open, struktek listens on
  `127.0.0.1` on an OS-assigned port. Every request must carry a bearer token
  minted per listen with `randomBytes(32)` and compared with `timingSafeEqual`.
  The socket is loopback only and the server is not started for a remote or
  virtual workspace.
- **A discovery file carrying that token.** `.struktek/.runtime/mcp.json` lands
  inside your repository so the bridge can find the server. The directory is
  made self-ignoring with a `*` gitignore when it is created, so the token is
  not committable even if your own ignore rules say nothing about it. The token
  rotates on every restart and the file is deleted when the server stops.
- **Your template files.** Read from `.struktek/` and rendered as text. Struktek
  does not execute template content, and does not send it anywhere — an agent
  receives a composed prompt only when you or it asks for one.
- **No network calls.** Struktek makes no outbound requests. The bridge is
  fetched from npm by your agent's `npx` invocation, not by the extension.
- **One outbound link, opened by you.** `Struktek: Report an Issue` hands your
  browser a `github.com/.../issues/new` URL. It carries the extension version,
  the editor name and version, and the platform — nothing from your library,
  your prompts or your workspace. Nothing is sent; a page is opened, and what
  you type into it is yours to review before submitting.

## Scope

The generated agent config is intended to be committed and shared: it carries
no token, no port, and no absolute path to the extension. If you find a way to
make struktek write a credential into a file that is not self-ignored, that is
a vulnerability and we would like to hear about it.
