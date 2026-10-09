<div align="center">

<img src="media/icon.png" width="96" alt="Paddock icon">

# Paddock

Keep your coding agents running while you switch projects in one VS Code window.

[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.140-007acc?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com)
[![herdr](https://img.shields.io/badge/herdr-%E2%89%A50.9.3-2f6fd6)](https://herdr.dev)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#-requirements)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Sponsor](https://img.shields.io/github/sponsors/iyansr?logo=githubsponsors&logoColor=white&label=Sponsor&color=ea4aaa)](https://github.com/sponsors/iyansr)

<!-- TODO: media/demo.gif, switching projects mid-task. -->

</div>

Paddock adds a sidebar of projects and agent sessions to VS Code. The agents run in [herdr](https://herdr.dev/), not in VS Code, so Claude Code, Codex and the rest keep working through project switches, window reloads and quitting VS Code. VS Code only draws their terminals.

## 📑 Table of contents

- [✨ Features](#-features)
- [📋 Requirements](#-requirements)
- [📦 Install](#-install)
- [🚀 Quick start](#-quick-start)
  - [Sessions](#sessions)
- [🧭 Recommended setup](#-recommended-setup)
- [⚙️ Settings](#️-settings)
- [🔍 How it works](#-how-it-works)
- [🛡️ What Paddock touches](#️-what-paddock-touches)
- [🩺 Troubleshooting](#-troubleshooting)
- [🗺️ Roadmap](#️-roadmap)
- [🛠️ Development](#️-development)
- [💖 Sponsor](#-sponsor)
- [📄 License](#-license)

## ✨ Features

- **Agents that survive:** sessions live in herdr. Switching project, reloading the window or quitting VS Code leaves them running, and they reattach where they were, in the panel or as editor tabs.
- **One sidebar for everything:** groups, projects, git worktrees and sessions, ordered by drag and drop (or the context menu). Each session shows a live badge: running, waiting for input, done or exited. Collapsed groups count the sessions waiting on you.
- **Never miss a prompt:** a session that starts waiting shows a notification with **Go to session**, which switches project if needed.
- **Any agent:** New Session offers the agents installed on your machine (Claude Code, Codex, Gemini CLI, opencode, Cursor Agent and the other 20-odd kinds herdr supports) plus a plain shell.
- **Worktrees:** create a worktree from a branch name, start agents in it, and remove it when you're done, all through herdr.

## 📋 Requirements

- macOS or Linux.
- VS Code `1.140` or later.
- [herdr](https://herdr.dev/) `0.9.3` or later. If Paddock can't find it, it offers to run herdr's installer in a terminal:

  ```bash
  curl -fsSL https://herdr.dev/install.sh | sh
  ```

Paddock has no runtime dependencies.

## 📦 Install

Install **Paddock** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=iyansr.paddock), or from the command line:

```bash
code --install-extension iyansr.paddock
```

## 🚀 Quick start

### Sessions

1. Open **Paddock** in the activity bar and click **Add Project** (or **New Group** first, to sort projects into groups).
2. Right-click the project and choose **New Session…**, then an agent.
3. Click another project. The window switches to it while the first agent keeps working; click back and its terminal reattaches.

Closing a session's terminal only detaches it. **Kill Session** in the context menu stops the agent.

## 🧭 Recommended setup

Paddock works out of the box, but this layout keeps files and agents side by side:

1. **Give Paddock its own sidebar.** Right-click the Paddock icon in the activity bar and choose **Move To → Secondary Side Bar** (or drag it there). The Explorer stays on the left, your projects and sessions sit on the right, and you never have to flip between them. Toggle the secondary sidebar with `⌥⌘B` (`Ctrl+Alt+B` on Linux).
2. **Run agents as editor tabs.** Keep `paddock.terminalLocation` at `editor` (the default) so each session opens as a full-size tab next to your files, not squeezed into the bottom panel. Split, drag and pin agent tabs like any other editor. To treat your own terminals the same way, add this to your settings:

   ```json
   "terminal.integrated.defaultLocation": "editor"
   ```

3. **Hide the panel.** With terminals in the editor area, the bottom panel is rarely needed. Close it with `⌘J` (`Ctrl+J` on Linux) for more room.

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

## 🛡️ What Paddock touches

- **Agent config only when you agree.** Installing herdr's integration edits the agent's own config (for example `~/.claude/settings.json`). Paddock asks first, every time.
- **Your herdr session is left alone.** Paddock uses its own herdr session and never touches herdr's default one.
- **herdr is called directly.** Every call is an argument list, never a shell string.
- **Nothing leaves your machine.** No telemetry, no uploads.

## 🩺 Troubleshooting

**"Paddock needs herdr, and could not find it".** VS Code often starts without your shell's `PATH`. Set `paddock.herdrPath` to the output of `which herdr`.

**An agent is missing from New Session.** Run **Paddock: Refresh Installed Agents** after installing it. If it's still missing, add it to `paddock.agents` yourself.

**A warning about herdr's API protocol.** Your herdr is newer or older than the one this Paddock was tested with. Sessions usually still work; if they don't, update Paddock or install a matching herdr.

**Mouse-wheel scrolling doesn't scroll back.** herdr repaints the screen, so VS Code's scrollback stays empty. Use the agent's own scrolling for now.

**Your projects are gone after updating from 0.0.x.** Paddock's extension id changed to `iyansr.paddock`, and VS Code keeps saved state per id. Add your projects again once; your agents are still in herdr.

## 🗺️ Roadmap

- **Pick an element, hand it to an agent.** In VS Code's integrated browser, pick an element, type an instruction, and Paddock types `@.paddock/picks/<pick>.md` into the agent's prompt without pressing Enter. The pick will hold the URL, selector, React component, size, text, nearby text, computed styles, trimmed HTML and a screenshot. It is built but switched off: it needs VS Code's proposed `browser` API, and the Marketplace doesn't accept extensions that use proposed APIs. It ships once that API is stable.

## 🛠️ Development

```bash
pnpm install
pnpm run watch          # rebuild on change, then press F5 for the Extension Development Host
pnpm run test:unit      # Vitest, no VS Code needed
pnpm run test:herdr     # against a real herdr server on a throwaway session
pnpm --allow-build=@vscode/vsce-sign dlx @vscode/vsce package --no-dependencies   # build the .vsix
```

Agent-facing notes live in [AGENTS.md](AGENTS.md); requirements and design in [docs/PRD.md](docs/PRD.md) and [docs/PLAN.md](docs/PLAN.md).

## 💖 Sponsor

Paddock is free and built in my spare time. If it keeps your agents running while you hop between projects, consider [sponsoring me on GitHub](https://github.com/sponsors/iyansr). It helps me keep Paddock up to date with herdr and VS Code.

## 📄 License

[Apache License 2.0](LICENSE)
