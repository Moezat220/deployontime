# AGENTS.md

This file is for coding agents that open this repository.

## What this is

DeployOnTime is an open-source software factory for building with coding agents, published one part at a time. The
part that works today is the machine queue, `dotime-queue`: one waiting line that lets several agents share one
computer without running too many heavy jobs at once. An MCP server, `dotime-mcp`, offers the same queue as tools.

## Install

macOS or Linux, Node 22 or newer, git 2.31 or newer. There are no npm dependencies and none are downloaded.

```
git clone https://github.com/Moezat220/deployontime.git
cd deployontime
npm link                          # puts dotime-queue and dotime-mcp on the path
cd <a project folder>
dotime-queue setup --write        # adds the queue instruction to its agent files, at the git top folder
```

Without `--write`, `setup` only shows what it would change. Without `npm link`, use `node <clone>/queue/cli.mjs`.

## The one instruction for a project's agent file

`dotime-queue setup --write` adds it between marker comments. Written by hand, it is:

```
Start every test run, build and other heavy command through the queue:
dotime-queue run --label "<project>: <task>" -- <command>
```

Exit 75 means the job gave up waiting for a slot, 124 that it hit its run limit, 3 that the same check already
failed twice on unchanged code; none of them is a test failure of the code. A test or lint run that prints
`skipped:` already passed on this commit and exits 0.

## MCP instead of shell commands

`dotime-queue setup --mcp` prints the client settings. The generic entry is
`{ "mcpServers": { "dotime-queue": { "command": "dotime-mcp" } } }`. The tools are `queue_status`, `queue_passed`,
`queue_history`, `queue_run` and `queue_job`; see "Use with an MCP client" in README.md.

## Working on this repository

- Run one test file directly: `node --test queue/setup.test.mjs`.
- Run the whole suite through the queue: `node queue/cli.mjs run --label "deployontime: tests" -- npm test`.
- Zero dependencies: use Node's own modules only, plain JavaScript ESM, no build step.
- Every change comes with tests (`node:test` and `node:assert/strict`, helpers in `queue/testkit.mjs`); a change
  of behaviour gets a test that fails before it and passes after. Do not weaken an existing assertion.
- Bad input (an unknown flag, a value that is not a number) is refused with a clear message and exit 2.
- Comments and docs are plain English, with neutral example values, and no dates or names of people.
- Update `queue/README.md` when documented behaviour changes. Its code layout table has one row per module.
- Keep prose lines in the READMEs at 120 characters or less; tables and code blocks may be longer.

The full manual, with every command, flag, exit code and setting, is `queue/README.md`.
