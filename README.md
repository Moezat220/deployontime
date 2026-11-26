# DeployOnTime

[![tests](https://github.com/Moezat220/deployontime/actions/workflows/test.yml/badge.svg)](https://github.com/Moezat220/deployontime/actions/workflows/test.yml)

Ship AI-written code to production, safely, one change at a time.

**The problem.** Coding agents each start their own test runs and builds. Three agents on one computer can mean
three full test suites at once: memory and CPU run out, tests that pass on their own start timing out, and an agent then
"fixes" code that was never broken. Each agent sees only its own run, so nobody sees why.

**What it is.** DeployOnTime is the step after the coding agent. Today it keeps the heavy jobs that agents start
through it from overloading your computer; next, it carries their changes through checks to a safe live release. It
is published in pieces, and the first one works on its own.

| Piece | What it does | State |
| --- | --- | --- |
| Machine queue | Lets several coding agents share one computer without overloading it | Available |
| Release engine | Carries an agent's pull request through checks to a safe live release | Not published yet |
| Install and quickstart | One command to set up, with a trial mode that changes nothing | Not published yet |

## Machine queue

Tell your agents, in their instruction file for example, to start test runs and builds through the queue
(`node queue/cli.mjs run`, or `dotime-queue run` once installed).
Jobs started that way share out the computer:

- It gives out a small number of slots (2 unless you change it). A job without a slot waits for its turn.
- Before a job starts, the queue looks at CPU load, free memory and free disk, and holds the job back if any is short.
- A job that runs too long is stopped, together with everything it started.
- It remembers which checks passed on which commit, so an agent can skip a check that is already green.

Beyond taking turns:

- A job that hangs cannot keep its slot: the limit is learned from that command's earlier passed runs. A command
  with fewer than five passed runs borrows the limit of its kind in the same project, and a fixed default applies
  until there are five of those.
- A check whose last two runs both failed on unchanged code is refused while the older failure is less than 6 hours
  old (a setting), unless the code changes or `--after-fix` is given.
- A journal records each job's run and its wait, and `history` turns it into totals per project.
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
