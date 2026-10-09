# Change Log

## 0.1.0

First packaged build.

- Projects and groups in a Paddock sidebar, with drag and drop and keyboard equivalents.
- Agent sessions run in herdr and stream into VS Code terminals; they survive project switches, reloads and quitting VS Code.
- Live status badges, waiting counts and a notification when a session waits for input.
- Git worktrees: list, create and remove through herdr.
- Element picker in VS Code's integrated browser: copy a pick or send it to an agent as an `@` reference.
- New Session offers the agents installed on this machine; `paddock.agents` overrides the list.
- herdr version and API protocol check on activation, with an install prompt when herdr is missing.
