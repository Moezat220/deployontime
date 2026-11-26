# DeployOnTime

[![tests](https://github.com/Moezat220/deployontime/actions/workflows/test.yml/badge.svg)](https://github.com/Moezat220/deployontime/actions/workflows/test.yml)

Ship AI-written code to production, safely, one change at a time.

DeployOnTime is being published in pieces. The first piece is ready to use on its own. The rest follows.

| Piece | What it does | State |
| --- | --- | --- |
| Machine queue | Lets several coding agents share one computer without overloading it | Available |
| Release engine | Carries an agent's pull request through checks to a safe live release | Not published yet |
| Install and quickstart | One command to set up, with a trial mode that changes nothing | Not published yet |

## Machine queue

When several agents run test suites and builds on the same computer at the same time, everything slows down and
checks start to fail for no real reason. The queue fixes that:

- It gives out a small number of slots (2 unless you change it). A job without a slot waits for its turn.
- Before a job starts, the queue looks at CPU load, free memory and free disk, and holds the job back if any is short.
- A job that runs too long is stopped, together with everything it started.
- It remembers which checks passed on which commit, so an agent can skip a check that is already green.

Beyond taking turns:

- A job that hangs cannot keep its slot: the limit is learned from that command's earlier passed runs. A command
  with fewer than five passed runs borrows the limit of its kind in the same project, and a fixed default applies
  until there are five of those.
- A check that failed twice in a row on unchanged code is refused for the next 6 hours (a setting), unless the code
  changes or `--after-fix` is given.
- Each job's wait, the gates that held it, its limit and its result go into a journal; `history` adds them up per
  project.
- A separate reaper, run from a scheduler, stops dev servers that sit idle and prints what it did.

```
node queue/cli.mjs run --label "shop-api: unit tests" -- npm test
node queue/cli.mjs status
```

Every command, flag, exit code and setting: [queue/README.md](queue/README.md).

Requirements: macOS, Node 22 or newer, git 2.31 or newer. No dependencies.

## Tests

```
npm test
```

## License

Copyright (C) 2026 Moezat220

[AGPL-3.0-only](LICENSE)
