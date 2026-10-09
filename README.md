# Paddock

Paddock keeps your coding agents running while you switch projects in a single VS Code window, and lets you pick an element in a browser and hand it to an agent.

<!-- TODO: short GIF of switching projects and picking an element (media/demo.gif). -->

- **Agents live in [herdr](https://herdr.dev/), not in VS Code.** VS Code only draws their terminals, so Claude Code, Codex and friends keep working through window reloads, project switches and quitting VS Code.
- **One sidebar for every project.** Groups, projects, git worktrees and agent sessions, each with a live badge: running, waiting for input, done or exited. A session that starts waiting shows a notification with **Go to session**.
- **Switch projects in place.** Clicking a project reopens the same window on it; its sessions reattach where they were, in the panel or as editor tabs.
- **Pick an element, send it to an agent.** Open VS Code's integrated browser, pick an element, add an instruction, and Paddock types `@.paddock/picks/<pick>.md` into the agent's prompt without pressing Enter. The pick holds the URL, selector, React component, size, text, computed styles, trimmed HTML and a screenshot.

## Requirements

- macOS or Linux.
- VS Code 1.140 or later.
- herdr 0.9.3 or later. If Paddock can't find it, it offers to run herdr's installer (`curl -fsSL https://herdr.dev/install.sh | sh`) in a terminal. If herdr is installed somewhere VS Code doesn't look, set `paddock.herdrPath`.

### Enable the browser API (element picker only)

The picker uses VS Code's proposed `browser` API, which an installed extension may use only when VS Code is told so. Run **Preferences: Configure Runtime Arguments**, add this line to `argv.json`, and quit and restart VS Code:

```json
"enable-proposed-api": ["iyansr.paddock"]
```

Everything else works without it. **Paddock: Open Browser** explains this and opens `argv.json` if the API is not enabled.

## Getting started

1. Open the Paddock view in the activity bar and **Add Project** (or create a **New Group** first).
2. Right-click a project and pick **New Session…**, then a preset such as Claude Code.
3. Click another project to switch to it. Sessions keep running; switch back and they reattach.
4. Click the globe in the Paddock title bar to open a browser tab, type a URL, then press the **Pick** button in the page (or Cmd+Alt+P / Ctrl+Alt+P). Click an element, type an instruction, and **Send** (Enter) or **Copy** (Cmd/Ctrl+Enter).

Installed an agent after opening VS Code? Run **Paddock: Refresh Installed Agents**. Closing a session's terminal only detaches it. Use **Kill Session** in the context menu to stop an agent.

## Settings

| Setting                    | Default   | What it does                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paddock.agents`           | empty     | Choices offered by **New Session**. Empty offers the agents Paddock finds installed (Claude Code, Codex, Gemini CLI, opencode, Cursor Agent and the other kinds herdr supports) plus Shell. To pick your own: `[{ "name": "Gemini", "kind": "gemini" }]`, where `kind` is herdr's agent kind and an entry without it is a shell. |
| `paddock.herdrPath`        | empty     | Path to the `herdr` binary. Empty looks in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`.                                                                                                                                                                                                                             |
| `paddock.herdrSession`     | `paddock` | herdr session Paddock keeps its agents in, separate from herdr's default session.                                                                                                                                                                                                                                                |
| `paddock.terminalLocation` | `editor`  | Where session terminals open: `editor` tabs or the bottom `panel`.                                                                                                                                                                                                                                                               |
| `paddock.switchMode`       | `reload`  | `reload` reopens the folder. `swap` (experimental) keeps a multi-root workspace and swaps only the project folder, with no reload.                                                                                                                                                                                               |

## What Paddock writes

- Picks go to `.paddock/picks/` in the agent's checkout. Paddock adds `.paddock/` to `.git/info/exclude`, never to `.gitignore`.
- With your approval, Paddock runs `herdr integration install claude` (or `codex`), which edits that agent's own config so herdr reports exact state. It never does this without asking.

## Known issues

- Mouse-wheel scrolling through an agent's history inside the VS Code terminal does not work yet; herdr repaints the screen, so VS Code's scrollback stays empty.
- The `browser` API is a proposal and may change between VS Code releases. Extensions that use proposals cannot be published to the Marketplace.
- Paddock warns once when the installed herdr speaks a different API protocol from the one it was tested with.
- Windows is not supported.

## Development

```bash
pnpm install
pnpm run watch          # then press F5 for the Extension Development Host
pnpm run test:unit
pnpm dlx @vscode/vsce package --no-dependencies
```
