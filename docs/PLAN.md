# Paddock Implementation Plan

Oct 8, 2026 · @Iyan Saputra

Paddock ships in six milestones, roughly 8.5 working days, each ending in something I can use day to day. It implements the Paddock PRD with [herdr](https://herdr.dev/) holding the agent terminals behind a single VS Code window, and a Chromium element picker driven over CDP.

## Architecture

```mermaid
flowchart LR
  subgraph vscode["VS Code window (always one)"]
    direction TB
    sidebar["Paddock sidebar<br/>groups, projects, worktrees, badges"]
    manager["Session manager<br/>start, attach, switch project"]
    terminals["VS Code terminals<br/>Pseudoterminal, panel or editor tab"]
    picker["Picker controller<br/>launch, capture, send to agent"]
  end
  herdr["herdr server (session: paddock)<br/>a workspace per project or worktree<br/>a tab and pane per agent<br/>detects working, blocked, done, idle<br/>keeps running when VS Code reloads"]
  browser["VS Code integrated browser<br/>browser API proposal<br/>Paddock's picker in each page"]
  picks[".paddock/picks<br/>.md + .png per pick"]

  manager -->|opens| terminals
  manager -->|agent start| herdr
  terminals <-->|control stream| herdr
  herdr -->|"agent list (status)"| sidebar
  picker -->|pane send-text| herdr
  picker <-->|CDP via startCDPSession| browser
  picker -->|writes .md + .png| picks

  classDef main fill:#e8f0fc,stroke:#2f6fd6,stroke-width:2px,color:#1f1f1f
  class herdr main
```

Everything that must survive a project switch lives in herdr: the agents, their terminals and their state. The extension only draws, reconnects and sends input.

## Tech stack and data model

### Stack

| Part | Choice | Why |
| --- | --- | --- |
| Extension | TypeScript, VS Code extension API, bundled with esbuild | Standard, fast builds |
| Agent runtime | herdr 0.9.3 or later, called through its CLI with `child_process.execFile` (JSON output) | Keeps agents alive, detects their state, manages worktrees |
| Terminal | VS Code `Pseudoterminal` fed by `herdr terminal session control` | Native scrolling and shortcuts, no prefix keys |
| Browser | VS Code's integrated browser through the `browser` API proposal, driven over the Chrome DevTools Protocol (CDP) from `BrowserTab.startCDPSession()`, with Paddock's picker injected into each page | A real browser inside VS Code; inspect overlay, HTML, styles and screenshots out of the box; no browser to ship |
| Storage | `globalState` for projects and groups, `workspaceState` for terminal layout | No database needed |

### Data model

- **Project:** `{ id, name, path, groupId, order, workspaceId }`, stored in `globalState`. `workspaceId` is the herdr workspace for the project's main checkout.
- **Session:** `{ paneId, agentName, projectId, worktreePath, kind, label, location }`, where `location` is `panel` or `editor`. The live list and each agent's state come from `herdr pane list` and `herdr agent list`; Paddock only stores labels and layout.
- **Pick:** `.paddock/picks/<timestamp>.md` (URL, selector, size, styles, HTML, comment) plus `<timestamp>.png`.

A **Group** is `{ id, name, order, collapsed }`, also in `globalState`. Each project points at one group; new projects land outside any group, at the top level of the tree, until I move them. Internally that is a hidden Ungrouped group that always exists; the tree never shows it as a header.

### How Paddock maps onto herdr

- **Session.** Paddock uses its own herdr session, `paddock` (`HERDR_SESSION=paddock` on every call), so its agents stay apart from herdr's default session. It's a setting, and the PRD lists the choice as an open question.
- **Project → workspace.** One herdr workspace per project, created with `herdr workspace create --cwd <path> --label <name> --no-focus`. A worktree is the workspace `herdr worktree create` makes, grouped with its repo.
- **Agent → tab.** Each agent gets its own herdr tab, whose root pane runs it, and a herdr name such as `nodus-1` (names must match `[a-z][a-z0-9_-]{0,31}`).
- **IDs.** Pane and workspace IDs always come from herdr's JSON responses, never predicted. After a `pane move`, Paddock switches to the new pane ID.

## Milestones

Build in this order; M1 alone already gives project switching that keeps agents running.

| Milestone | Delivers | PRD | Size (days) |
| --- | --- | --- | --- |
| M0 Scaffold | Extension runs, Paddock view in the activity bar, add and remove projects, groups with drag-and-drop ordering | R1 | 1 |
| M1 Sessions | herdr check, a workspace per project, start agents, VS Code terminals streamed from herdr panes, switch project in the same window, reattach after reload | R3, R4, R7–R11, R19 | 2 |
| M2 Status | Badges from herdr's agent detection, waiting counts, notifications | R5, R6 | 0.5 |
| M3 Worktrees | List, create and remove worktrees through herdr | R2 | 0.5 |
| M4 Picker (roadmap) | Integrated browser, pick mode, capture, comment, copy or send to the agent. Built, switched off until the `browser` API is stable | R12–R18 | 3.5 |
| M5 Polish | Settings, herdr version check and installer prompt, README, packaged `.vsix` | All | 1 |
| **Total** |  |  | **8.5** |

## Implementation details

### M0 Scaffold, groups and ordering

- **Sidebar is a webview view.** `paddock.projects` is a `WebviewView` (`src/tree/view.ts`), not a `TreeView`, so it can draw richer rows: pill badges, a `primary` chip, a card around the open checkout and agent icons. `src/tree/model.ts` builds the rows as plain data (pure, unit-tested) and validates every message from the webview; `src/webview/sidebar.ts` draws them and is bundled separately to `dist/sidebar.js`. Right-click menus are native, contributed under `webview/context` with `webviewSection` set per row through `data-vscode-context`; hover buttons cover the old inline actions. The webview implements tree keyboard navigation itself (arrows, Home/End, Enter, Shift+F10). Multi-select is gone.
- **Drop rules.** A project dropped on the top half of a project goes before it, on the bottom half after it, in that project's group; a project dropped on a group goes to the end of that group; a project dropped below the list goes to the top level; a group dropped on a group goes before or after it.
- **Persist.** Drops rewrite `order` in `globalState` through `moveProjects` and `moveGroups`. Collapsing a group saves `collapsed`; project and session-list expansion is per-view state in the webview.
- **Keyboard path.** Context menu commands New group, Rename group, Delete group (projects move to the top level), Move to group (with a No group choice) a `+` on each group that adds a project straight into it, and the Add project and New group title-bar buttons (and an empty-state with both), since drag and drop has no keyboard equivalent.
- **Group badge.** A group's `description` shows its waiting count, read from the same status data as session badges.

### M1 Sessions

- **herdr check.** On activation run `herdr --version`; if it's missing or older than 0.9.3, offer the installer in a terminal. If `herdr status server` finds no server for the `paddock` session, start `herdr server` in the background.
- **Workspace.** The first time a project opens, run `herdr workspace create --cwd <path> --label <name> --no-focus` and store `workspaceId`.
- **Start.** `herdr tab create --workspace <id> --cwd <path> --no-focus` returns a root pane; then `herdr agent start <name> --kind claude --pane <paneId>`. A shell session stops after `tab create`. `agent start` answers `agent_not_ready` when the agent launched but is already blocked on a prompt (for example a trust dialog); the agent exists, so Paddock treats that as success. The first session of a new workspace reuses the root pane `workspace create` returns instead of opening a second tab. When the last pane of a workspace closes, herdr closes the workspace, so Paddock re-creates it on the next session.
- **Stream into VS Code.** Each terminal is a `Pseudoterminal`. It spawns `herdr terminal session control <paneId> --takeover --cols C --rows R` and reads newline-delimited JSON: `terminal.frame` carries base64 ANSI bytes for the write emitter, and `terminal.closed` closes the tab. Typed input, resizes and scrolling go back on stdin as `terminal.input` (`{text}` or base64 `{bytes}`), `terminal.resize` (`{cols, rows}`) and `terminal.scroll` (`{direction: up|down, lines}`); `terminal.release` detaches. These shapes are **not** in `herdr api schema --json` (that file covers the socket API only); they come from herdr's CLI reference and were confirmed against 0.9.3 by `test/integration/herdr.test.ts`.
- **Detach, not kill.** Closing the tab sends `terminal.release`; the agent keeps running. Killing is an explicit sidebar action (`herdr pane close`).
- **Switch project, `reload` mode (default).** Run `vscode.openFolder` with `forceNewWindow: false`. Terminal layout is saved per project in `workspaceState` as it changes.
- **Switch project, `swap` mode (`paddock.switchMode`).** VS Code restarts extensions when the first workspace folder changes or when a window becomes multi-root, so the first switch writes `Paddock.code-workspace` (in the extension's global storage, so VS Code does not ask to save an untitled workspace) with a fixed placeholder folder first and the project second, and opens it once. Later switches call `updateWorkspaceFolders(1, …)`, which does not restart the extension host. Because a multi-root window shares one editor state and one `workspaceState`, layouts and open files are stored per project id. On switching away Paddock saves the open file tabs (order, active tab, selection), stashes unsaved edits in the snapshot (nothing is written to disk), reverts and closes the tabs, then reopens the target project's files and re-applies its unsaved edits. If the file changed on disk meanwhile, the stashed edits open in an untitled editor instead of overwriting. Custom editors (such as the image viewer), notebooks and Markdown previews move with the project too; a preview's tab carries only its title (`Preview README.md`), so its file is found by name among the open tabs, then in the workspace, and a preview whose file is not unique is closed without being restored. Terminals, diffs, settings and other webviews stay where they are.
- **Reattach on activate.** Match the open folder to a project, list its panes with `herdr pane list --workspace <id>`, and reopen each saved session (matched by pane id and terminal id) where it was. Clicking a session of another project stores a pending-open request in `globalState`, switches project, and opens it after the reload.
- **Wheel scrolling.** herdr's frames are repaints with absolute cursor moves and never carry the app's mouse or alternate-screen modes, so VS Code's own scrollback holds none of the pane's history. The pty turns on SGR mouse reporting in the VS Code terminal (`\e[?1000h\e[?1006h`, re-sent with every full frame) and turns wheel reports from `handleInput` into `terminal.scroll`; other mouse reports are dropped. herdr then scrolls its own scrollback, or, when the app asked for the mouse (Claude Code's fullscreen mode), passes the wheel on to it. Cost: a plain drag no longer selects text; hold Shift (Option on macOS with `terminal.integrated.macOptionClickForcesSelection`) to select.
- **Split buttons.** VS Code cannot draw UI over a terminal, so the pty (`src/herdr/toolbar.ts`) keeps row 1 for a text toolbar: herdr gets `rows - 1`, every absolute row move in its frames (`CUP`, `VPA`) is shifted down one, a scroll region (`ESC[2;Rr`) keeps anything else below row 1, and the toolbar is redrawn after each frame (cursor saved and restored). herdr 0.9.3 frames use only absolute moves, `ESC[2J`, SGR and mode toggles, which makes this safe; re-check after upgrading herdr. Focus reporting (`ESC[?1004h`) plus the active terminal decide when the buttons show. The buttons are bold text; `paddock.toolbarIcons` switches them from plain Unicode symbols to the codicons Nerd Fonts ship (`U+EB56`, `U+EB57`, `U+EA76`). A left press on row 1 runs `paddock.splitRight`, `paddock.splitDown` or `paddock.killSession` with the pane id; other input on row 1 is dropped. Split asks for "New session…" or a session of the same checkout that is not open, then opens it with `viewColumn: Beside` (right), after `workbench.action.newGroupBelow` (down), or with `parentTerminal` in the panel (side by side only). Editor splits come back after a reload: each saved session also stores its editor group (`column`, read from `window.tabGroups` by tab title whenever tabs open or move; closes are ignored because a closing window closes them all), and the grid from `vscode.getEditorLayout` is kept in `workspaceState` (`paddock.grids`). On restore VS Code usually keeps the empty groups, so each terminal reopens with `viewColumn: column`; when it has fewer groups than needed, `vscode.setEditorLayout` rebuilds the saved grid first. Panel splits are not restored. VS Code's own Split Editor button cannot be removed by an extension; right-click it and choose Hide.

### M2 Status

- **Source.** Poll `herdr agent list` every 1 to 2 s. Switch to a socket subscription if the installed herdr's API schema offers one.
- **Mapping.** `working` and `unknown` show as running, `blocked` as waiting, `done` and `idle` as done. A pane with no agent shows as running or exited.
- **Integrations.** With my approval, `herdr integration install claude` and `codex` give exact state instead of screen detection.
- **Updates.** A state change fires the tree's `onDidChangeTreeData`. A change to blocked shows a notification with "Go to session"; opening it runs `herdr agent focus`, which marks the completion as seen.

### M3 Worktrees

- **List** with `herdr worktree list --cwd <project path>`. `--cwd` instead of `--workspace` works before the project has a herdr workspace, so listing never creates one (and its stray shell). The list includes the main checkout (`is_linked_worktree: false`); a folder that is not a git repository answers `not_git_worktree` and shows its sessions directly, without worktree rows. The last list per project is kept in `globalState`, so a window opened on a worktree knows its project before herdr answers. Paddock re-lists on activation, on window focus, after adding a project, and when `workspace list` shows a workspace on a checkout it does not know.
- **Tree.** A git project expands to its checkouts (main first, labelled by branch), each expanding to its sessions. A worktree's workspace is matched by `worktree.checkout_path` in `workspace list`, since herdr labels it with the branch, not the project name. Layouts and open files are keyed per checkout (the main checkout keeps the project id).
- **Create** with `herdr worktree create --cwd <project path> --branch <name> --no-focus`. An existing branch is checked out, any other name becomes a new branch. herdr makes the checkout under `~/.herdr/worktrees/<repo>/<branch>` and returns the new workspace with a root shell pane; the first session started there takes over that pane.
- **Reopen.** herdr closes a worktree's workspace with its last pane (the checkout stays, `open_workspace_id` disappears). Starting a session there runs `herdr worktree open --cwd <project path> --path <checkout> --no-focus` first.
- **Remove** with `herdr worktree remove --workspace <id>`, which needs an open workspace, so Paddock reopens it first if needed. It also closes the workspace and its sessions. A dirty checkout answers `dirty_worktree_requires_force`; `--force` is added only after I confirm. It never deletes the branch. The main checkout answers `not_linked_worktree` and has no Remove action. Removing the worktree open in the current window first switches to the project's own folder; in `reload` mode the request is stored in `globalState` (valid for a minute) and finished after the reload.
- **Errors.** herdr 0.9.3 writes error envelopes (`{"error":{"code",…}}`) to stderr with a non-zero exit, not to stdout; `cli.ts` reads them from there.

### M4 Picker

**Status: on the roadmap.** The picker is built but switched off so Paddock can go on the Marketplace, which does not take extensions that use proposed APIs. `enabledApiProposals`, the Open Browser and Pick Element commands, the globe button and the Cmd+Alt+P keybinding are out of `package.json`; the wiring in `src/extension.ts` and `src/commands.ts` and the `--enable-proposed-api` flags are commented out; `src/test/picker.test.ts` is skipped. `src/picker/` is unchanged. Turn it back on once the `browser` API is stable.

- **Browser API.** Paddock uses VS Code's `browser` API proposal (`src/vscode.proposed.browser.d.ts`, `enabledApiProposals: ["browser"]`): `window.openBrowserTab`, `window.browserTabs`, `onDidOpenBrowserTab` / `onDidCloseBrowserTab`, `activeBrowserTab`, and `BrowserTab.startCDPSession()`. No debugger is involved: no debug toolbar, no Debug Console, no tab prompt. Stable VS Code allows a proposal only for an extension started with `--enable-proposed-api=iyansr.paddock` (already in `.vscode/launch.json` and `.vscode-test.mjs`); an installed `.vsix` needs `"enable-proposed-api": ["iyansr.paddock"]` in `argv.json` and a full restart. Without it, Open Browser explains this and offers to open `argv.json`. The Marketplace does not take extensions that use proposals, and the proposal can change between VS Code releases. Earlier versions used `editor-browser` debug sessions through js-debug's CDP proxy (a launched session, then one attached per pick); both showed the debug toolbar, and the launched one raced js-debug's `about:blank` → URL navigation.
- **Open.** **Paddock: Open Browser** (the globe in the sidebar title) runs `window.openBrowserTab('', { viewColumn: Active })`: an empty tab in the current editor group, next to the other tabs, and I type the URL. There is no URL setting.
- **CDP.** `startCDPSession()` is a browser-level session. `Target.setAutoAttach({ flatten: true })` attaches the page, and commands go to its `sessionId`. `src/picker/cdp.ts` is a small client over that message channel; there is no browser library. `src/picker/browser.ts` attaches to every integrated browser tab, open or opened later, and keeps one `PagePicker` (`src/picker/page-picker.ts`) per page.
- **Picker in the page.** `src/picker/page.ts` is injected with `Page.addScriptToEvaluateOnNewDocument` and once with `Runtime.evaluate`, inside a closed shadow root, and talks back through `Runtime.addBinding` (`Runtime.bindingCalled`). The page can call that binding too, so every message is validated (`src/picker/protocol.ts`). A Pick button sits in the top-right corner; **Paddock: Pick Element in Browser** (Cmd+Alt+P / Ctrl+Alt+P) toggles it in the active tab. Pick mode lays a full-page click catcher over the page: on mouse move it finds the element underneath with `elementFromPoint` (the catcher briefly stops taking pointer events) and draws its own white box and a dark label (`h2  role=…  "text"  524x144`). The click lands on the catcher, so the page never sees it. C copies the hovered element without the card; Esc cancels. Nothing here depends on DevTools' inspect overlay.
- **Capture.** The page reads the element itself: selector (the shortest unique `tag.class.class` chain, with `:nth-of-type` where siblings match), role (ARIA or tag), text, nearby text (sibling and parent text, at most three lines), ancestor and full DOM paths, outer HTML, `getComputedStyle` for the properties `filterStyles` knows, and the box in document coordinates. It hides itself and waits briefly (a timer, since animation frames stop in a hidden tab) before reporting, so `Page.captureScreenshot` clipped to the box with `captureBeyondViewport` shows neither the highlight nor the card. A tab that is not on screen never answers the screenshot, so it times out after 4 s and the pick goes on without one. The extension trims the HTML to about 2 KB and keeps only non-default layout, spacing, typography and colour values (equal sides folded into `margin`, `padding` and so on).
- **React component.** The page reads the node's `__reactFiber$…` key and walks `.return` to the nearest function or class component with a real name, skipping framework internals such as names starting with `__`. Production builds may show minified names.
- **Card.** After a click, a card next to the element shows the selector, size, text and screenshot thumbnail, an instruction box, Cancel, Copy and Send to <session>. Enter sends, Cmd/Ctrl+Enter copies. Copy goes straight back to pick mode for the next element; Send ends it and focuses the agent's terminal. Failures (no session to send to) show on the page and keep the card open.
- **Format.** Build one plain-text block in the layout below and write it to `.paddock/picks/<timestamp>.md`, next to `<timestamp>.png`. The timestamp is `YYYYMMDD-HHMMSS-<tag>`, with `-2`, `-3` added rather than overwriting. Copy writes the files too, since the text names the screenshot.
- **Copy.** Put the block (plus the instruction, if any) on the clipboard with `vscode.env.clipboard.writeText`.
- **Send.** Run `herdr pane send-text <paneId> " @<relPath> "` (leading space as in PRD R16, so it does not run into text already typed), which types without pressing Enter, and focus that session's VS Code terminal. The path is relative to the agent's checkout. The target is the last focused Paddock terminal, tracked with `window.onDidChangeActiveTerminal`; before any is focused, an agent in this window's checkout (one with an open terminal first). The instruction is saved in the `.md`, not typed.
- **Git.** Append `.paddock/` to the exclude file once, found with `git rev-parse --git-path info/exclude` so linked worktrees use the main repository's.

Pick format, shown with the yapp.ink hero heading:

```text
Attached browser context from https://yapp.ink/

Selected element:
h2
Role: h2
Selector: section.flex.h-svh > h2.max-w-\[524px\].text-3xl
React: <Hero>
Dimensions: 524x144
Screenshot: .paddock/picks/20261008-1410-h2.png

Text content:
Your All In One Creator Platform

Nearby context:
- 1000+ Creators already Joined us
- Links, digital products, tipping, campaigns, and livestream overlays, ...
- Start Exploring Become a Creator

Computed styles:
  display: block
  font-size: 60px
  color: lab(14.6704 0 0)

HTML:
<h2 class="max-w-[524px] text-3xl md:text-5xl lg:text-6xl ...">Your All In One Creator Platform</h2>

Ancestor path: section > div > body
Full DOM path: body > div > section.flex.h-svh > h2.max-w-\[524px\].text-3xl

Instruction: make this heading smaller on mobile
```

### M5 Polish

- **Settings.** `paddock.agents` lists the New Session choices as `{ name, kind }` (no `kind` is a shell), parsed in `src/presets.ts`. Left empty (the default), New Session offers the installed agents: herdr has no command for that, so on activation `src/detect.ts` looks for each kind's program, asking the user's login shell (`$SHELL -i -l -c` with a fixed `command -v` script and the names as arguments, POSIX shells only) and scanning `PATH` plus the usual install folders. herdr's kind is its canonical executable, except `cursor`, which counts only `cursor-agent` because `cursor` is the editor's launcher. **Paddock: Refresh Installed Agents** looks again. If detection fails, the list falls back to Claude Code, Codex and Shell. `paddock.herdrSession`, `paddock.herdrPath`, `paddock.terminalLocation` and `paddock.switchMode` are unchanged.
- **Publisher.** The publisher is `iyansr`, so the extension id is `iyansr.paddock`; `argv.json`, `.vscode/launch.json` and `.vscode-test.mjs` name it for the browser API. globalState is keyed by extension id, so projects and groups saved under `undefined_publisher.paddock` do not carry over and are added again once.
- **herdr check.** On activation Paddock checks `herdr --version` (0.9.3 or later) and offers `curl -fsSL https://herdr.dev/install.sh | sh` in a terminal when herdr is missing or older. It then reads `protocol` from `herdr api schema --json` and warns once per protocol number when it differs from the one Paddock was tested with (22, herdr 0.9.3).
- **README** covering requirements, the `argv.json` line, settings and known issues. The GIF of switching and picking is still to be recorded.
- **Package.** `pnpm --allow-build=@vscode/vsce-sign dlx @vscode/vsce package --no-dependencies` builds `paddock-<version>.vsix`. The licence is Apache 2.0.

## Testing and release

- **Unit tests** (Vitest) for the parts with no VS Code dependency: parsing herdr's JSON responses, decoding `terminal.frame` records, state mapping, style filtering.
- **Integration tests** with `@vscode/test-electron`: activation, adding a project, starting and reattaching a session against a real herdr server on a throwaway session name.
- **Manual checklist per milestone**, run on my own projects:
  - [ ] Switch between nodus-studio and d1-studio while Claude Code is mid-task; the session is intact after the reload
  - [ ] Quit VS Code, reopen; every session reattaches in its old place
  - [ ] A session waiting for input shows the badge and a notification within 2 s
  - [ ] Pick a header element on localhost; the `@` reference appears in the prompt without being sent
- **Release.** Package with `vsce package` and install the `.vsix` locally. Publishing to the Marketplace and Open VSX waits until I've used it daily for a week.