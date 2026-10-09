<div align="center">

<img src="media/icon.png" width="96" alt="Paddock icon">

# Paddock

Keep your coding agents running while you switch projects in one VS Code window, and hand them any element you pick in the browser.

[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.140-007acc?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com)
[![herdr](https://img.shields.io/badge/herdr-%E2%89%A50.9.3-2f6fd6)](https://herdr.dev)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#-requirements)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Sponsor](https://img.shields.io/github/sponsors/iyansr?logo=githubsponsors&logoColor=white&label=Sponsor&color=ea4aaa)](https://github.com/sponsors/iyansr)

<!-- TODO: media/demo.gif, switching projects mid-task and sending a pick to an agent. -->

</div>

Paddock adds a sidebar of projects and agent sessions to VS Code. The agents run in [herdr](https://herdr.dev/), not in VS Code, so Claude Code, Codex and the rest keep working through project switches, window reloads and quitting VS Code. VS Code only draws their terminals.

## 📑 Table of contents

- [✨ Features](#-features)
- [📋 Requirements](#-requirements)
- [📦 Install](#-install)
  - [Enable the browser API](#enable-the-browser-api)
- [🚀 Quick start](#-quick-start)
  - [Sessions](#sessions)
  - [Element picker](#element-picker)
- [⚙️ Settings](#️-settings)
- [🔍 How it works](#-how-it-works)
- [🛡️ What Paddock touches](#️-what-paddock-touches)
- [🩺 Troubleshooting](#-troubleshooting)
- [🛠️ Development](#️-development)
- [💖 Sponsor](#-sponsor)
- [📄 License](#-license)

## ✨ Features

- **Agents that survive:** sessions live in herdr. Switching project, reloading the window or quitting VS Code leaves them running, and they reattach where they were, in the panel or as editor tabs.
- **One sidebar for everything:** groups, projects, git worktrees and sessions, ordered by drag and drop (or the context menu). Each session shows a live badge: running, waiting for input, done or exited. Collapsed groups count the sessions waiting on you.
- **Never miss a prompt:** a session that starts waiting shows a notification with **Go to session**, which switches project if needed.
- **Any agent:** New Session offers the agents installed on your machine (Claude Code, Codex, Gemini CLI, opencode, Cursor Agent and the other 20-odd kinds herdr supports) plus a plain shell.
- **Worktrees:** create a worktree from a branch name, start agents in it, and remove it when you're done, all through herdr.
- **Pick an element, hand it to an agent:** in VS Code's integrated browser, pick an element, type an instruction, and Paddock types `@.paddock/picks/<pick>.md` into the agent's prompt without pressing Enter. The pick holds the URL, selector, React component, size, text, nearby text, computed styles, trimmed HTML and a screenshot.

## 📋 Requirements

- macOS or Linux.
- VS Code `1.140` or later.
- [herdr](https://herdr.dev/) `0.9.3` or later. If Paddock can't find it, it offers to run herdr's installer in a terminal:

  ```bash
  curl -fsSL https://herdr.dev/install.sh | sh
  ```

Paddock has no runtime dependencies and ships no browser.

## 📦 Install

Paddock isn't on the Marketplace yet. Build the `.vsix` (see [Development](#️-development)) and install it:

```bash
code --install-extension paddock-0.1.0.vsix
```

### Enable the browser API

The element picker uses VS Code's proposed `browser` API, which an installed extension may use only when VS Code allows it. Run **Preferences: Configure Runtime Arguments**, add this entry to `argv.json`, then quit and restart VS Code:

```json
"enable-proposed-api": ["iyansr.paddock"]
```

Everything else works without it. **Paddock: Open Browser** explains this and opens `argv.json` when the API isn't enabled.

## 🚀 Quick start

### Sessions

1. Open **Paddock** in the activity bar and click **Add Project** (or **New Group** first, to sort projects into groups).
2. Right-click the project and choose **New Session…**, then an agent.
3. Click another project. The window switches to it while the first agent keeps working; click back and its terminal reattaches.

Closing a session's terminal only detaches it. **Kill Session** in the context menu stops the agent.

### Element picker

1. Click the globe in the Paddock title bar. An empty browser tab opens next to your editors; type your URL.
2. Press the **Pick** button in the page, or `Cmd+Alt+P` (`Ctrl+Alt+P` on Linux).
3. Hover to highlight, click to pick. `C` copies the hovered element straight away, `Esc` cancels.
4. Type an instruction, then **Send** (`Enter`) to the last focused session, or **Copy** (`Cmd/Ctrl+Enter`) to put the whole pick on the clipboard and keep picking.

## ⚙️ Settings

| Setting                    | Default   | Description                                                                                                                                     |
| -------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `paddock.agents`           | empty     | Choices in **New Session**. Empty offers the agents found on your machine plus Shell.                                                           |
| `paddock.herdrPath`        | empty     | Path to the `herdr` binary. Empty looks in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`.                                            |
| `paddock.herdrSession`     | `paddock` | herdr session Paddock keeps its agents in, apart from herdr's default session.                                                                  |
| `paddock.terminalLocation` | `editor`  | Where session terminals open: `editor` tabs or the bottom `panel`.                                                                              |
| `paddock.switchMode`       | `reload`  | `reload` reopens the folder. `swap` (experimental) keeps a multi-root workspace and swaps only the project folder, so the window never reloads. |

**Choosing your own agents.** Set `paddock.agents` to a list of `name` and herdr agent `kind`; leave `kind` out for a shell:

```json
"paddock.agents": [
  { "name": "Claude Code", "kind": "claude" },
  { "name": "Gemini", "kind": "gemini" },
  { "name": "Shell" }
]
```

## 🔍 How it works

1. **herdr holds the agents.** Paddock talks to its own herdr session (`paddock` by default), with one herdr workspace per project or worktree and one tab per agent.
2. **VS Code draws them.** Each session's terminal is a VS Code pseudoterminal fed by `herdr terminal session control`, so typing, resizing and shortcuts feel native and there is no multiplexer prefix to learn.
3. **Switching only redraws.** Opening another project reloads the window (or swaps the folder in `swap` mode); Paddock saves which terminals were open where and reattaches them afterwards.
4. **Status comes from herdr.** Paddock polls `herdr agent list` every 2 seconds. With your approval, herdr's Claude Code and Codex integrations report exact state instead of reading the screen.
5. **Picks go over CDP.** Paddock attaches to each integrated browser tab through the Chrome DevTools Protocol and injects its picker into the page in a closed shadow root.

## 🛡️ What Paddock touches

- **Agent config only when you agree.** Installing herdr's integration edits the agent's own config (for example `~/.claude/settings.json`). Paddock asks first, every time.
- **Picks stay in the project.** They are written to `.paddock/picks/` in the agent's checkout. Paddock adds `.paddock/` to `.git/info/exclude`, never to your `.gitignore`.
- **Sending never submits.** A pick is typed into the agent's prompt without `Enter`, so you finish the message yourself.
- **Your herdr session is left alone.** Paddock uses its own herdr session and never touches herdr's default one.
- **herdr is called directly.** Every call is an argument list, never a shell string.
- **Nothing leaves your machine.** No telemetry, no uploads.

## 🩺 Troubleshooting

**"Paddock needs herdr, and could not find it".** VS Code often starts without your shell's `PATH`. Set `paddock.herdrPath` to the output of `which herdr`.

**Open Browser asks you to edit `argv.json`.** The browser API isn't enabled for Paddock. Add the entry from [Enable the browser API](#enable-the-browser-api) and fully quit VS Code; a window reload isn't enough.

**An agent is missing from New Session.** Run **Paddock: Refresh Installed Agents** after installing it. If it's still missing, add it to `paddock.agents` yourself.

**A warning about herdr's API protocol.** Your herdr is newer or older than the one this Paddock was tested with. Sessions usually still work; if they don't, update Paddock or install a matching herdr.

**Mouse-wheel scrolling doesn't scroll back.** herdr repaints the screen, so VS Code's scrollback stays empty. Use the agent's own scrolling for now.

**Your projects are gone after updating from 0.0.x.** Paddock's extension id changed to `iyansr.paddock`, and VS Code keeps saved state per id. Add your projects again once; your agents are still in herdr.

## 🛠️ Development

```bash
pnpm install
pnpm run watch          # rebuild on change, then press F5 for the Extension Development Host
pnpm run test:unit      # Vitest, no VS Code needed
pnpm run test:herdr     # against a real herdr server on a throwaway session
pnpm --allow-build=@vscode/vsce-sign dlx @vscode/vsce package --no-dependencies   # build the .vsix
```

F5 already passes `--enable-proposed-api` for the browser API. Agent-facing notes live in [AGENTS.md](AGENTS.md); requirements and design in [docs/PRD.md](docs/PRD.md) and [docs/PLAN.md](docs/PLAN.md).

## 💖 Sponsor

Paddock is free and built in my spare time. If it keeps your agents running while you hop between projects, consider [sponsoring me on GitHub](https://github.com/sponsors/iyansr). It helps me keep Paddock up to date with herdr and VS Code.

## 📄 License

[Apache License 2.0](LICENSE)
