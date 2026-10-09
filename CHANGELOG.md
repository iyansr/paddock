# Change Log

## 0.1.1

- Session terminals show a toolbar on their top row while focused: Split Right, Split Down and Kill. `paddock.toolbarIcons` switches it to Nerd Font icons.
- Split opens a new session, or one of the checkout's sessions that is not open yet, beside the clicked terminal.
- Editor terminals keep their editor group and grid, so splits come back in place after a reload.
- The mouse wheel scrolls herdr's own scrollback.
- The sidebar highlights the session whose terminal is active.
- Custom editors, notebooks and Markdown previews move with the project like file tabs.
- Development and test runs keep their state and herdr session apart from an installed Paddock.
- Licensed under Apache 2.0.

## 0.1.0

First packaged build.

- Projects and groups in a Paddock sidebar, with drag and drop and keyboard equivalents.
- Agent sessions run in herdr and stream into VS Code terminals; they survive project switches, reloads and quitting VS Code.
- Live status badges, waiting counts and a notification when a session waits for input.
- Git worktrees: list, create and remove through herdr.
- Element picker in VS Code's integrated browser: copy a pick or send it to an agent as an `@` reference.
- New Session offers the agents installed on this machine; `paddock.agents` overrides the list.
- herdr version and API protocol check on activation, with an install prompt when herdr is missing.
