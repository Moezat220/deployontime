# DeployOnTime

[![tests](https://github.com/Moezat220/deployontime/actions/workflows/test.yml/badge.svg)](https://github.com/Moezat220/deployontime/actions/workflows/test.yml)

Ship AI-written code to production, safely, one change at a time.

**Ready to use today: the machine queue** (macOS). It lets several coding agents share one computer without
overloading it. The rest of DeployOnTime is on the roadmap below.

## The problem

Coding agents each start their own test runs and builds. Three agents on one computer can mean three full test
suites at once: memory and CPU run out, tests that pass on their own start timing out, and an agent then "fixes" code
that was never broken. Each agent sees only its own run, so neither you nor the agents can see the real cause.

## Machine queue

The queue is a command that agents put in front of their heavy commands. It works with any coding agent that can run
a shell command; there is no plugin to install. Only commands started through it are queued. A command an agent runs
directly, such as a plain `npm test`, is not.

A job started through the queue:

- takes its turn: at most 2 jobs run together (set with `slots`), and extra jobs wait;
- is held back while the computer is short of CPU, memory or disk, or low on battery;
- is stopped, together with everything it started, when it runs past its time limit (exit 124);
- is written to a journal, which `dotime-queue history` sums up per project.

It also helps an agent skip work and stop loops:

- Before a check, an agent can ask `dotime-queue passed --match "<check>"`. Exit 0 means a run whose label or
  command contains that text succeeded on this exact commit, and the folder had nothing uncommitted then and has
  nothing now. The queue itself never skips a job.
- After two failures in a row on unchanged code, a third try is blocked with exit 3 for up to 6 hours. Editing the
  code, or adding `--after-fix "<note>"`, unblocks it.
- Time limits are learned from passed runs: first the command's own, then those of its kind of job in the project,
  once either has five; before that, 30 minutes. A new command that takes longer than what its kind has learned
  (which can be as short as 10 minutes) needs `--max-run <minutes>`, or it is stopped every time.

The queue never edits your repository. It keeps its state (slots, journal, settings) in `~/.dotime`. Agents share one
queue only when they use the same state folder on the same computer. An agent in a container or a virtual machine sees a
different process list, so it must not share the folder: it gets a queue of its own.

An optional reaper, which runs only if you schedule it, stops dev servers that sit idle anywhere on the computer,
including ones started outside the queue. A trial run with `--dry` lists the servers it would stop and stops
none, and a keep pattern protects the ones you want left alone. Details are in the
[queue manual](queue/README.md#reaper).

### Install

Requirements: macOS (the queue reads macOS tools such as `pmset` and `memory_pressure`), Node 22 or newer, git 2.31
or newer. No npm packages are downloaded.

```
git clone https://github.com/Moezat220/deployontime.git
cd deployontime
npm link                 # puts the dotime-queue command on your path
dotime-queue status
```

Then tell your agents to use it. For example, add this to their instruction file (such as `AGENTS.md` or
`CLAUDE.md`):

```
Start every test run, build and other heavy command through the queue:
dotime-queue run --label "<project>: <task>" -- <command>
Before running a check, ask whether it already passed: dotime-queue passed --match "<check>"
```

The text before the colon in a label is the project name; limits and history are kept per project.

To remove it: `npm uninstall -g deployontime`, delete `~/.dotime`, and take the reaper out of your scheduler if you
added it.

Every command, flag, exit code and setting: [queue/README.md](queue/README.md).

## Roadmap

The machine queue is complete and usable on its own. These pieces come next, in this order:

| Next | What it will do |
| --- | --- |
| Release engine | Carry an agent's pull request through checks to a safe live release |
| Install and quickstart | Set everything up with one command, with a trial mode that changes nothing |
| Linux and Docker | Run the queue outside macOS |

## Tests

From the repository's top folder:

```
npm test
```

## License

Copyright (C) 2026 Moezat220

[AGPL-3.0-only](LICENSE). Using the queue on your own computer does not put your projects under this license. Its
conditions apply when you pass this code on, changed or not, and when you let others use a changed version of it
over a network.
