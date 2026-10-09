# Paddock PRD

Oct 8, 2026 · @Iyan Saputra

Paddock is a VS Code extension for working with coding agents in a single VS Code window: a project sidebar whose agent terminals survive project switches, and a Chromium element picker that sends what I click straight into the agent's prompt. Everything else stays plain VS Code, so files keep full LSP support.

## Problem

Neither standalone agent apps nor plain VS Code fit my agent workflow on their own.

- **Standalone agent apps are too heavy for what I use.** I only need a project switcher, file preview and an element-picking browser. Everything else (mobile app, GitHub/Linear, SSH worktrees, usage tracking) is weight I don't use.
- **Their file previews have no code intelligence.** They embed an editor but no language servers, so there is no go-to-definition, hover types or diagnostics.
- **Plain VS Code loses agent state on switch.** Opening another folder in the same window restarts the extension host and kills its terminals, including a running Claude Code session.
- **VS Code's built-in element picker targets the wrong agent.** The integrated browser's Add Element to Chat sends to VS Code's own chat, not to a CLI agent in a terminal, and extensions can't add buttons to its toolbar.

## Goals and non-goals

### Goals (v1)

1. Switch between projects in one VS Code window without losing any agent session.
2. See every agent's state (running, waiting for input, done) across all projects from one sidebar.
3. Get a picked UI element into the agent's prompt in two actions: pick, then send.
4. Work with any CLI agent; Claude Code first, Codex second.

### Non-goals

- A custom editor or chat UI. Paddock uses VS Code's editor and the agent's own TUI.
- GitHub/Linear integration, PR review, mobile companion, SSH remotes.
- Account switching and usage or rate-limit tracking.
- Multi-agent delegation or shared context between agents; that belongs to Relay.
- Windows support in v1; herdr's Windows support is still in beta.

## Requirements

All requirements below are in scope for v1; later work is listed at the end.

### Sidebar and sessions

- **R1 Projects and groups.** A Paddock view in its own activity bar container lists projects I add by folder. Projects can sit at the top level or inside groups I name (for example Personal and Company A); a `+` on each group adds a project straight into it, and an "Add project" row at the bottom of the tree adds one at the top level. Drag and drop reorders projects, moves them between groups (or out to the top level) and reorders the groups; "Move to group" in the context menu does the same from the keyboard. A collapsed group shows how many of its sessions are waiting. Groups and order are stored globally, so every window sees them.
- **R2 Worktrees.** Each project expands to its git worktrees (`herdr worktree list`). I can create a worktree from a branch name and remove one.
- **R3 Sessions.** Each worktree expands to its agent sessions. "New session" asks for an agent preset (Claude Code, Codex, plain shell) and starts it in its own herdr pane.
- **R4 Switch project.** Clicking a project or worktree that isn't open switches the same window to that folder. With `paddock.switchMode` set to `reload` the folder is reopened and its sessions reattach after the reload; with `swap` the window is a saved multi-root workspace and only the project folder is replaced, with no reload. Either way each project keeps its own open files (including unsaved edits) and terminals.
- **R5 Status badges.** Every session shows running, waiting for input, done or exited, updated live from herdr's own agent detection. Projects that aren't open still show their badges, plus a count of sessions waiting on me.
- **R6 Notifications.** A session that starts waiting for input shows a VS Code notification with a "Go to session" action, which switches project if needed.
- **R7 Manage sessions.** Rename, restart and kill sessions from the sidebar context menu.

### Terminals

- **R8 Terminals live in VS Code.** Each session opens as a VS Code terminal that streams its herdr pane, either in the bottom panel or as an editor tab next to code (a setting, overridable per session).
- **R9 Restore layout.** After a reload, sessions reopen where they were: panel or editor tab, and an editor tab in its own editor group, so split layouts come back.
- **R10 No prefix keys.** Paddock draws the pane through VS Code's own terminal, so scrolling, search and shortcuts work as usual and there is no multiplexer prefix to learn.
- **R11 Survive VS Code.** Closing a terminal tab detaches instead of killing the agent. Quitting VS Code leaves agents running.
- **R19 Split terminals.** A session terminal's top row is a small toolbar with Split Right, Split Down and Kill (×) buttons, shown while that terminal is focused. Split offers a new session or one of the project's sessions not open yet, and opens it beside that terminal. In the panel, splits sit side by side only. Panel splits are not restored after a reload; editor splits are (R9).

### Element picker

> On the roadmap: R12 to R18 are built but switched off until VS Code's `browser` API is stable, since the Marketplace does not take extensions that use proposed APIs.

- **R12 Open browser.** One "Open Browser" button opens an empty tab of VS Code's own integrated browser in the current editor group, next to my other tabs; I type the URL. No separate window, no debugger, and scrolling and typing feel like any browser.
- **R13 Pick mode.** A small Pick button sits in the corner of every page (VS Code does not let extensions add buttons to the browser's own toolbar); a keyboard shortcut does the same. Pick mode highlights the element under the mouse with a label of its tag, role, text and size. Clicking selects it without the page seeing the click; C copies the hovered element straight away; Esc cancels.
- **R14 Capture.** A pick captures the page URL, tag and role, a CSS selector, the nearest React component, size, text content, nearby text, key computed styles, trimmed outer HTML, the ancestor and full DOM paths, and a cropped screenshot. It's written as plain text in a fixed layout, so any agent can read it.
- **R15 Optional comment.** After picking, I can type a short instruction that is saved with the pick.
- **R16 Send to agent.** The pick is written to `.paddock/picks/<timestamp>.md` and `.png`. Paddock then types ` @<path>  ` into the chosen session's input without pressing Enter, so I can finish the prompt myself. The target defaults to the last focused session.
- **R17 Keep git clean.** Paddock adds `.paddock/` to `.git/info/exclude` the first time it writes there.

* **R18 Copy instead of send.** A Copy button puts the same browser context on the clipboard, with the instruction from R15 at the end, so I can paste it into any agent, chat or issue. The screenshot stays in `.paddock/picks/` and its path is included in the text. Copy goes straight back to pick mode for the next element; Send ends it.

## Constraints and success measures

### Constraints

- **Platforms:** macOS first, then Linux. herdr 0.9.3 or later must be installed; Paddock checks on activation and offers herdr's one-line installer.
- **One window:** Paddock never opens a second VS Code window.
- **Memory:** only the open project's language servers run. Background projects cost only their agent processes.
- **Browser:** use VS Code's integrated browser, so Paddock ships no browser and no browser library.
- **Agent-agnostic:** herdr recognises Claude Code, Codex and over 20 other agent CLIs and reports their state. Anything else runs as a plain pane that shows only running or exited.
- **Privacy:** picks stay on disk in the project; nothing is uploaded.

### Success measures

| Measure | Target |
| --- | --- |
| Project switch to a usable agent terminal | under 5 s |
| Pick to element reference in the prompt | 2 actions |
| Agent sessions lost across switches and reloads | 0 |
| Days in a row using Paddock as my only agent workspace | 7 |

## Later, risks and open questions

### Later versions

- Agents on other machines, through herdr's saved SSH machines.
- Area screenshots and console-log capture from the browser.
- Source location for picked elements (file and line), using a dev-build plugin that stamps it onto JSX.
- Comments on diff lines sent back to the agent.

### Risks

- **herdr is pre-1.0 (v0.9.3).** Its CLI and socket API may change. Mitigation: require a minimum version and check `herdr api schema` on activation.
- **One controller per pane.** Opening a pane in VS Code takes control from herdr's own TUI or another device. Mitigation: take over only when I open the pane, and release it when the tab closes.
- **Reload delay on switch.** Reopening a folder takes a few seconds and restarts language servers. The `swap` mode avoids the reload (the switch is near-instant in testing) at the cost of a permanent `Paddock` placeholder folder at the top of the Explorer, which VS Code cannot hide; collapsing it once is remembered.
- **Detection can be unsure.** herdr reports `unknown` when it can't classify an agent. Mitigation: show it as running, and offer herdr's Claude Code and Codex integrations for exact state.

### Open questions

- Use herdr's default session, so Paddock's agents also show in herdr's own TUI, or a dedicated `paddock` session?
- Install herdr's Claude Code and Codex integrations by default, or rely on screen detection until I ask?
- Should picks be cleaned up automatically after some days?
