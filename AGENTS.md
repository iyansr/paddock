# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) working in this repository.

## What Paddock is

Paddock is a VS Code extension that keeps coding agents running while I switch projects in a single VS Code window, and lets me pick elements in a browser and hand them to an agent.

- Agents run in [herdr](https://herdr.dev/), not in VS Code. VS Code only draws their terminals, so agents survive window reloads and project switches.
- The sidebar shows groups, projects, worktrees and agent sessions with live status badges.
- A Chromium window driven over the Chrome DevTools Protocol (CDP) lets me pick an element and copy its context or send it to an agent.

Read these before changing behaviour:

- `docs/PRD.md`: what Paddock must do (requirements R1 to R18).
- `docs/PLAN.md`: architecture, data model, milestones M0 to M5 and the API calls for each.
- `docs/paddock-mock.html`: interactive mock of the intended UI (sidebar with groups, session badges, project switching, the element picker with Copy and Send). Open it in a browser, or read its HTML for layout, labels and wording. The same mock is published at https://claude.ai/artifact/ASR1ncW9xQa1GhSsu8KWZS, but that link needs a signed-in claude.ai account, so use the local copy. The mock shows look and flow only; where it differs from the PRD, the PRD wins.

If a change contradicts either document, stop and ask instead of picking one yourself.

## Commands

```bash
pnpm install
pnpm run watch        # rebuild on change; then press F5 in VS Code to open the Extension Development Host
pnpm run compile      # one-off build
pnpm run check-types  # tsc --noEmit
pnpm run lint
pnpm run test:unit    # Vitest, no VS Code needed
pnpm test             # integration tests with @vscode/test-electron
pnpm dlx @vscode/vsce package   # build the .vsix
```

Run `check-types`, `lint` and `test:unit` before saying a task is done.

## Layout

```
src/
  extension.ts        activate(): registers the tree, commands and status polling
  herdr/cli.ts        the only place that runs herdr; returns parsed JSON
  herdr/terminal.ts   Pseudoterminal over `herdr terminal session control`
  herdr/status.ts     polls `herdr agent list`, maps states
  store.ts            groups and projects in globalState, layout in workspaceState
  tree/provider.ts    TreeDataProvider for paddock.projects
  tree/dnd.ts         TreeDragAndDropController
  picker/             Playwright launch, CDP capture, pick format, copy and send
test/
  unit/               Vitest
  integration/        @vscode/test-electron
docs/
  PRD.md, PLAN.md
```

## Rules

### herdr

- Call herdr only through `src/herdr/cli.ts`, with `child_process.execFile` and an argument array. Never build a shell string.
- Always set `HERDR_SESSION` from the `paddock.herdrSession` setting (default `paddock`). Never touch herdr's default session.
- Use the herdr binary from the `paddock.herdrPath` setting when it is set. VS Code often starts without the user's shell `PATH`.
- Pane, tab and workspace IDs come from herdr's JSON responses only. Never construct or predict them, and refresh IDs after any `pane move`.
- Agent names must match `[a-z][a-z0-9_-]{0,31}`.
- Shapes of `terminal.input`, `terminal.resize`, `terminal.scroll` and `terminal.release` follow `herdr api schema --json`, saved as `herdr-api.schema.json`. Check it before changing the stream code.
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
- Do not add a runtime dependency without asking. Current ones: `playwright-core`.

## Testing

- Unit-test parsing of herdr responses, `terminal.frame` decoding, state mapping, the pick format and style filtering.
- Integration tests run against a real herdr server on a throwaway session name such as `paddock-test-<random>`. Tear it down afterwards. Never run tests against the `paddock` session; it holds my real agents.
- Before finishing a milestone, go through its manual checklist in `docs/PLAN.md`.

## Working on milestones

- Work on one milestone at a time, in order: M0, M1, M2, M3, M4, M5.
- Keep commits small and named after the milestone, for example `M1: stream herdr pane into Pseudoterminal`.
- If the plan turns out to be wrong (a herdr command behaves differently, a VS Code API is missing), say so and propose the change to `docs/PLAN.md` rather than working around it silently.