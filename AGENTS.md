# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) working in this repository.

## What Paddock is

Paddock is a VS Code extension that keeps coding agents running while I switch projects in a single VS Code window, and lets me pick elements in a browser and hand them to an agent.

- Agents run in [herdr](https://herdr.dev/), not in VS Code. VS Code only draws their terminals, so agents survive window reloads and project switches.
- The sidebar shows groups, projects, worktrees and agent sessions with live status badges.
- VS Code's integrated browser, with an element picker Paddock injects over the Chrome DevTools Protocol (CDP), lets me pick an element and copy its context or send it to an agent. It uses VS Code's `browser` API proposal; F5 passes `--enable-proposed-api`, an installed build needs it in `argv.json`.

Read these before changing behaviour:

- `docs/PRD.md`: what Paddock must do (requirements R1 to R18).
- `docs/PLAN.md`: architecture, data model, milestones M0 to M5 and the API calls for each.
- `docs/mock.html`: interactive mock of the intended UI (sidebar with groups, session badges, project switching, the element picker with Copy and Send). Open it in a browser, or read its HTML for layout, labels and wording. The same mock is published at https://claude.ai/artifact/ASR1ncW9xQa1GhSsu8KWZS, but that link needs a signed-in claude.ai account, so use the local copy. The mock shows look and flow only; where it differs from the PRD, the PRD wins.

If a change contradicts either document, stop and ask instead of picking one yourself.

## Commands

```bash
pnpm install
pnpm run watch        # rebuild on change; then press F5 in VS Code to open the Extension Development Host
pnpm run compile      # one-off build
pnpm run check-types  # tsc --noEmit
pnpm run lint         # oxlint (.oxlintrc.json)
pnpm run format       # oxfmt (.oxfmtrc.json): sorts imports, single quotes in JS/TS, double in JSX
pnpm run test:unit    # Vitest, no VS Code needed
pnpm run test:herdr   # Vitest against a real herdr server on a throwaway session
pnpm test             # integration tests with @vscode/test-electron
pnpm dlx @vscode/vsce package   # build the .vsix
```

Run `format`, `check-types`, `lint` and `test:unit` before saying a task is done.

## Layout

```
src/
  extension.ts        activate(): registers the tree, commands and status polling
  herdr/cli.ts        the only place that runs herdr; returns parsed JSON
  herdr/terminal.ts   Pseudoterminal over `herdr terminal session control` (the only file in herdr/ that imports VS Code)
  herdr/parse.ts      validates herdr JSON; herdr/frames.ts stream protocol; herdr/names.ts agent names
  sessions.ts         sessions per project, open terminals, layout, project switching
  layout.ts           saved open-terminal layout (pure)
  herdr/status.ts     polls `herdr agent list`, maps states
  store.ts            groups and projects in globalState, layout in workspaceState
  tree/model.ts       sidebar rows as plain data, webview message validation (pure)
  tree/view.ts        WebviewViewProvider for paddock.projects
  webview/sidebar.ts  sidebar script, runs in the webview (bundled to dist/sidebar.js)
  picker/             integrated browser tabs over CDP (browser.ts, cdp.ts), the in-page picker (page.ts), pick format, copy and send
test/
  unit/               Vitest
  integration/        @vscode/test-electron
docs/
  PRD.md, PLAN.md
```

## Rules

### herdr

- Call herdr only through `src/herdr/cli.ts`, with `child_process.execFile` (or `spawn` for the long-lived terminal stream) and an argument array. Never build a shell string.
- Always set `HERDR_SESSION` from the `paddock.herdrSession` setting (default `paddock`). Never touch herdr's default session.
- Use the herdr binary from the `paddock.herdrPath` setting when it is set. VS Code often starts without the user's shell `PATH`.
- Pane, tab and workspace IDs come from herdr's JSON responses only. Never construct or predict them, and refresh IDs after any `pane move`.
- Agent names must match `[a-z][a-z0-9_-]{0,31}`.
- `herdr-api.schema.json` (from `herdr api schema --json`) describes the socket API. The `terminal session control` stream (`terminal.frame`, `terminal.input`, `terminal.resize`, `terminal.scroll`, `terminal.release`) is not in it; its shapes live in `src/herdr/frames.ts` and are checked by `test/integration/herdr.test.ts`. Re-run that test after upgrading herdr.
- Closing a VS Code terminal must release the pane (`terminal.release`), not close it. Only the explicit Kill action runs `herdr pane close`.
- Do not use tmux or any other multiplexer.

### VS Code

- Paddock never opens a second window. Project switches use `vscode.openFolder` with `forceNewWindow: false`.
- Every contributed ID uses the `paddock.` prefix: views, commands, settings, context keys.
- Keep work out of `activate()` that could block startup. Start herdr checks and polling without awaiting them.
- Every drag-and-drop action in the tree also needs a keyboard path through a context menu command.

### Agent config and user files

- Never write to an agent's config (for example `~/.claude/settings.json`) or run `herdr integration install` without asking the user in the UI first.
- Picks go in `.paddock/picks/`. Add `.paddock/` to `.git/info/exclude`, never to the project's `.gitignore`.
- Sending a pick types into the agent's input with `herdr pane send-text` and never presses Enter.

### Code style

- TypeScript strict mode. No `any` except at the JSON boundary in `herdr/cli.ts`, where responses are validated before use.
- Small modules with one job each. Keep VS Code imports out of `herdr/`, `picker/format.ts` and `store.ts` logic so they stay unit-testable.
- Do not add a runtime dependency without asking. There are none at the moment.

## Testing

- Unit-test parsing of herdr responses, `terminal.frame` decoding, state mapping, the pick format and style filtering.
- Integration tests (`test:herdr`) run against a real herdr server on a throwaway session name such as `paddock-test-<random>`. Tear it down afterwards. Never run tests against the `paddock` session; it holds my real agents.
- A development or test run (F5, `pnpm test`) never shares data with an installed Paddock: `src/devState.ts` prefixes its state keys with `dev:`, keeps its files in `globalStorage/…/dev`, and swaps the `paddock` herdr session for `paddock-dev`. F5 also opens with its own user data in `.vscode-dev/`.
- Before finishing a milestone, go through its manual checklist in `docs/PLAN.md`.

## Working on milestones

- Work on one milestone at a time, in order: M0, M1, M2, M3, M4, M5.
- Keep commits small and follow convetional commit message
- If the plan turns out to be wrong (a herdr command behaves differently, a VS Code API is missing), say so and propose the change to `docs/PLAN.md` rather than working around it silently.
