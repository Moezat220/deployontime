# Machine queue

Machine queue is one waiting line for the heavy jobs on a computer that several coding agents use at the same time:
full test suites, builds, end-to-end runs. Its command is `dotime-queue`. The messages of `run` and its
warnings start with `dotime-queue:`, and the titles of its notices start with `dotime:`.

**Nothing is queued unless you ask.** Only a command started as `dotime-queue run ... -- <command>` (or
`node queue/cli.mjs run ... -- <command>`) waits in the line, is held by the gate and runs under a time limit. A
`npm test` that an agent runs directly is not held, not limited and not recorded. A single test file, a lint or a
typecheck of a few files finishes quickly and does not need the queue.

What the queue does for every job started through it:

1. **Line.** Jobs queue up first come, first served. Only a set number hold a slot at the same time (2 by
   default).
2. **Gate.** The first in line starts only when a slot is free and the computer has room: load, free memory, free
   disk, and the battery when the computer runs on it. See [Health gate](#health-gate).
3. **Limit.** The job runs under a time limit. At the limit, the job and everything it started are stopped.
4. **Journal.** Each run leaves a record of its wait, its run time and its result. Later runs use that record.

**State folder.** The queue keeps its state in one folder: `~/.dotime` by default, or the folder that the
`DOTIME_HOME` variable names. Callers share one queue only when they use the same folder. A state folder may only
be used by processes on one computer that see the same process list: the queue decides whether a job is still alive
by its process id. A container, a virtual machine or a second computer must therefore not point at the same folder;
it would take the host's jobs for finished, delete their slots and let too many jobs run. Each user account has its
own `~/.dotime`, and two computers must not share one.

**Your repository.** The queue never edits your repository. It runs read-only git commands and reads files to tell
whether the code changed between runs. The one exception is the [isolated run](#isolated-runs), which you ask for with
`--isolate`: it adds a worktree and a branch, and only `integrate` moves your branch, by a fast-forward. The commands
you run through it do what they always do. The queue opens no network connection; only a `DOTIME_NOTIFY_CMD` that you
set can send notices elsewhere.

## Install

Requirements: macOS or Linux (servers and desktops, x64 and arm64). Node 22 or newer. git 2.31 or newer. On Linux
the `ps` of procps, which almost every distribution installs, and a readable `/proc`.

```
npm install -g deployontime
dotime-queue status
```

This puts `dotime-queue` and `dotime-mcp` on your path. The package has no dependencies. The first line of
`dotime-queue status` should read `slots: 0 of 2 taken, 0 waiting`.

On Linux the steps are the same. When the install stops with a permission error, your Node was installed for all
users; run it with a Node from a version manager, or after `npm config set prefix ~/.local` with `~/.local/bin` on
your path.

To work from the source instead, clone `https://github.com/Moezat220/deployontime.git` and run `npm link` in its top
folder.

To tell the agents of a project to use the queue, run [`dotime-queue setup`](#setup) in that project's folder:
without `--write` it shows what it would add to `AGENTS.md` and `CLAUDE.md`, with `--write` it adds it.

From a clone that was not linked, call `node <path to the clone>/queue/cli.mjs` from any folder. The `queue/` folder
needs nothing outside itself. The examples below use `dotime-queue`.

To uninstall:

```
npm uninstall -g deployontime
rm -rf ~/.dotime        # or the folder DOTIME_HOME names
```

If you scheduled the [reaper](#reaper), also remove it from your scheduler (for cron or a systemd timer, see
[the end of that section](#scheduling-the-reaper-with-cron)).

Agents that use MCP can reach the queue as tools instead of shell commands: `dotime-mcp`, set up as described in
[Use with an MCP client](../README.md#use-with-an-mcp-client). It runs the same `dotime-queue run` underneath, so
everything in this manual applies to its jobs too.

### What differs on Linux

The queue, `run`, `status`, `passed`, `history`, `flaky` and the reaper work the same on Linux. The readings come from
other places: free memory and swap from `/proc/meminfo`, the battery from `/sys/class/power_supply`, and desktop
notices go through `notify-send` (see [Health gate](#health-gate) and [Notices](#notices)). A server or desktop
without a battery has no battery limit. The [scheduled-job report](#scheduled-job-report) reads launchd jobs and
works on macOS only for now.

## Quick start

```
dotime-queue run --label "shop-api: unit tests" -- npm test
dotime-queue status
```

Worth knowing before the first run:

- The text before the colon in the label is the project. Run limits and history are kept per project.
- A new command gets the limit its kind has learned in that project, which can be as short as 10 minutes, or 30
  minutes until the kind has five passed runs. For a longer one, pass `--max-run <min>`. See [Run limits](#run-limits).
- A question mark in the task part of the label makes a debug job, stopped after 15 minutes:
  `"shop-api: does login work?"` is one.
- A job waits in line at most 60 minutes, then exits 75. That is not a test failure.
- A test or lint check that already passed on the same clean commit, in the same folder, is skipped and exits 0 at
  once. `--no-skip` runs it anyway.
- Times are printed in UTC unless `DOTIME_TZ` names another zone.

## Commands

`dotime-queue help` and `dotime-queue --help` print a short usage text and exit 0.

### `run`

```
dotime-queue run --label "<project>: <task>" [options] -- <command> [args]
```

Waits for a slot, runs the command, and exits with the command's exit code. Input and output pass through as
usual. Stopping a job stops every process it started, because `run` starts the job in a new session with a process group
of its own. The job therefore has no controlling terminal: a program that opens `/dev/tty`, for example to ask for a
password, cannot do so.

| Option | Effect |
| --- | --- |
| `--label "<project>: <task>"` | Names the job. The text before the colon is its project. Default: `unnamed`. |
| `--max-wait <min>` | Leave the line after this many minutes, exit 75. `0`: no limit. Default: `maxWaitMin`. |
| `--max-run <min>` | Run limit for this job. Needed for a new command that runs longer than its kind's learned limit. |
| `--kind <name>` | Job kind, in place of the guessed one. See [Projects and kinds](#projects-and-kinds). |
| `--after-fix "<note>"` | Runs a check that would be refused with exit 3. The note is stored in the journal. |
| `--priority` | Joins the line at the front. Slots and the gate still apply. For a person's urgent run. |
| `--no-skip` | Runs a `test` or `lint` job that already passed on this commit. See **Checks that already passed** below. |
| `--isolate` | Runs the job in a git worktree of its own, on a new branch. Never skipped. See [Isolated runs](#isolated-runs). |

Options go in front of the `--`. Everything behind it is the job's command. Keep `--priority` out of agent
instructions: an agent that uses it every time puts itself in front of everyone else.

An option that is not in this table, an option without its value or with an empty value, an option given twice,
or any other word in front of the `--` is refused with exit 2, for example `dotime-queue: unknown option --max-runn`.
A word that starts with `--` is not taken as the value of the option in front of it: `--label --priority` is refused
because `--label` has no value. Give `--label` a value, or, when the value itself starts with `--`, join it to the
option with `=`: `--label=--priority`. The refusal message says both, with the value in single quotes when a shell
would split or change it. The job does not run. The same holds for `status`, `passed`, `history`, `flaky`,
`integrate`, `discard` and `worktrees`: each accepts only the options shown for it.

`run` started in a folder that was removed checks its options first, as above. When they are fine, it says
`dotime-queue: the current folder was removed; start the job from a folder that exists` and exits 2; nothing is
journalled.

While it waits, `run` prints its position and what holds it, at each change of position and again after each
minute of waiting.

**Ctrl-C.** While the job waits, Ctrl-C or TERM takes it out of the line and `run` exits 130. While the job runs,
INT, TERM and HUP are passed on to the whole job, and the run is journalled as `stopped`: neither a pass nor a
failure.

Details:

- A stop signal that the queue did not send (HUP, INT, KILL or TERM) also makes the run `stopped`, for example when
  the system ends a job because memory ran out. So does exit status 128 plus a stop signal's number, because that
  is how a shell script reports a child it lost to that signal. Stopped runs never count towards
  [Repeated failures](#repeated-failures).
- Any other signal that ends a job counts as a failure.
- A job ended by a signal makes `run` exit 1, not 128 plus the signal's number as a shell would. The exceptions are
  SIGUSR1 and signals Node does not die by, such as SIGPIPE: those give 128 plus the number. A script that looks
  for 130 or 143 should look for the `stopped:` line that `run` prints instead.
- If the `run` process itself dies, the job notices within about 2 seconds (`limits.orphanCheckMs`) and stops.
- A command that cannot be started at all, for example a misspelled program name, makes `run` print a
  `start failed:` line and exit 127. It is journalled as `could-not-start`, which counts neither as a failure nor
  towards [Repeated failures](#repeated-failures). A command that starts and then exits 127 by itself, such as a
  shell script that calls a missing program, is an ordinary failed run.
- `run` ends when the job's main process ends. A process the job started in the background and left running does
  not keep `run` waiting.

**Checks that already passed.** A `test` or `lint` job that already passed on the same commit, in the same folder,
with the same files named in its command, is not run again. `run` prints one line, exits 0, takes no slot and starts
nothing:

```
dotime-queue: skipped: "shop-api: unit tests" already passed on commit 0a1b2c3d (12 min ago); --no-skip runs it anyway
```

It skips a job only when all of these hold:

- The job's kind is `test` or `lint`, as guessed from the label and command or given with `--kind` (see
  [Projects and kinds](#projects-and-kinds)). A `build`, `deploy`, `debug` or `other` job always runs, because its
  output may be needed. The guess takes the first kind that matches, and `test` comes before `build`, so a job whose
  label or command names both, such as `"shop-api: build and test"` or `sh -c "npm run build && vitest"`, is a `test`
  job. Such a job is still never skipped: when the label's task part or the command also names a build or a deploy,
  `run` runs it. For this, `build`, `bundle`, `compile`, `deploy`, `release` and `publish` count also inside other
  words (`prebuild`, `esbuild`, `deploy_prod.sh`, `deployProd`), and so do `webpack`, `rollup`, `parcel`, `tsc`
  without `--noEmit`, and `vercel` or `netlify` with `--prod`. This errs towards running: a test file named
  `build.test.js` is run each time. Only `--kind test` or `--kind lint`, given on the command line, lets such a job
  be skipped.
- The folder is a git checkout at a commit, with no uncommitted or untracked changes now.
- The journal holds a pass stamp for this check, found by the rules of [`passed`](#passed) but only among runs
  started in the same folder, with the same label and the same command line: on this commit, begun with a clean tree,
  and the newest of them exited 0. Stopped and timed-out runs are left out, as `passed` leaves them out. A pass in
  another folder of the same repository, such as another package, never counts.
- That passing run has the same code fingerprint as the job now (see [Repeated failures](#repeated-failures)). With a
  clean tree, the fingerprint covers the files the command names, so a script outside git that has changed since,
  such as `node ../tools/check.js`, makes the job run. Only a file given as a word of its own counts: not a path
  inside a `sh -c "..."` string or in `--config=../tools/check.ts`, not what is in a folder the command names, and
  not a named file of 4 MB or more.
- No run of the same check in this folder on this commit failed, hit its run limit or could not start after that
  pass, not even one that began with uncommitted changes.

The stamp has no age limit. Other things outside git are not part of the check: files the command reads without
naming them, installed packages in an ignored folder, tools and the environment. That includes a live target:
end-to-end or smoke tests against a deployed site are skipped on the same commit even after a redeploy, so give such
a job `--no-skip` or `--kind other`. After changing any of those, or to run a flaky test again, give `--no-skip`:
the job then runs, and its result counts like that of any run. A check that is refused because it failed twice is
refused before this is looked at.

A nested run follows the same rules. `--no-skip` on a job also reaches every run nested in it, at any depth: `run`
hands the job the variable `DOTIME_NO_SKIP=1`, and a nested run that finds it runs as with `--no-skip` and hands it on
in turn. A job that could not be skipped itself, such as a `build`, `deploy` or `other` job or a `test` job that
also names a build, gets the variable too, so no step inside it is skipped: a `tsc` or other check that such a job
runs through the queue may make output the job needs. Only a nested run heeds the variable, and a job gets it only
from its own `--no-skip`, from its own kind, or from the job it is nested in, never from the shell that started the
queue.

`run` prints nothing when it does not skip. To see why, look at the check's own lines in the journal: `cwd`, `cmd`,
`head`, `clean`, `fp` and `outcome` show which of the conditions above did not hold.

A skipped job is journalled with outcome `skipped`, exit 0, its commit, and the stamp it relied on in `stamp`
(`head`, `endedAt` and `runMin` of the passing run). A skipped line is never a stamp itself, never a sample for the
[run limits](#run-limits), and never a pass or an attempt for [Repeated failures](#repeated-failures). `history`
counts the skipped jobs and the run time they saved, and leaves them out of its wait median and p90.

**Nested runs.** A job may run the queue itself, for example an `npm test` script that calls `dotime-queue run`, or
an agent at work inside a queued job. Such an inner run would wait for a slot that its own outer job holds, and with
one slot it would never get one. So `run` hands every job it starts the variable `DOTIME_JOB`, which names the slot
of the outermost job, and the variable `DOTIME_PARENT`, which names the job's direct parent (see below). A `run`
that finds either is a nested run: it takes no slot, joins no line and does not wait for the
health gate, because the outer job was already let through. Everything else stays the same: the option checks, the
refusal of a check that failed twice, a run limit of its own, the handling of INT, TERM and HUP, and a journal line,
marked `nested: true`, so pass stamps and `history` see it as usual. A nested run says so on a `nested:` line when
it starts.

One job may run at most `nestedPerJob` nested runs at once (default 2). Each running nested run holds one of the
places of the job it was started in, its parent. A further nested run of the same parent waits for one of those
places, and only for them: never for a slot and never for the health gate, so it cannot wait for its own outer job.
Nested runs waiting under the same parent take the places in the order they started. While it waits, a nested run
prints an `in line for a nested place:` line that names its parent, gives up with exit 75 at the `--max-wait` limit,
leaves with exit 130 on INT or TERM, and books its waiting time in the journal under `nested`, as a run in line does.
A waiting nested run checks on every poll that its parent still runs. If the parent has ended, the run is no longer
inside a job: it prints a `parent gone:` line and joins the line as a normal run, waits for a slot and the health
gate, and is journalled without `nested`. Its `--max-wait` limit still counts from when it began to wait.

This limit is new: nested runs used to start at once, with no limit per job. Now no more than 2 run at once under one
job unless `nestedPerJob` says otherwise. A job that fans out to many long shards, each a nested run, now runs them 2 at
a time; the rest wait, and a shard whose wait passes its `--max-wait` limit (`maxWaitMin`, 60 min by default) gives up
with exit 75. The outer job's own run limit keeps counting while its shards wait, and that limit was learned from runs
made before this cap, when all shards ran at once. So a job that used to run 3 or more shards side by side now takes
longer: with 2 at a time, N equal shards take about N/2 times as long (6 shards about 3 times). It can then be stopped
at its limit (exit 124, its shards with it; twice the limit with `--priority`), which in a short job comes before any
shard reaches `--max-wait`. Give such a job `--max-run` on the outer run, or raise `nestedPerJob`.

Nested runs of one parent that only work when they run at the same time wait the same way: a pipeline such as
`dotime-queue run … | dotime-queue run …`, or a server and the tests that call it, both started through the queue.
With more of them than `nestedPerJob`, the ones beyond it wait for a place that none of the others give up, until
`--max-wait` ends them with 75. For such jobs, raise `nestedPerJob` in `config.json` to the number that must run at
once, for example `{ "nestedPerJob": 4 }`, or start only one side through the queue.

A nested run inside a nested run counts against its own parent, not against the outermost job: each nested run hands
its job a `DOTIME_PARENT` that names the nested run itself, while `DOTIME_JOB` keeps naming the outer slot at every
level. So with `nestedPerJob` at 1 several levels of nesting still run, each level in the one place of the level
above. A run looks at `DOTIME_PARENT` first, and at `DOTIME_JOB` when the first is missing or fails the check below;
`DOTIME_JOB` is only taken when it names a slot. An older copy of the queue that shares the state folder and reads
only `DOTIME_JOB` therefore still finds the outer slot at any depth, and runs nested as it did before.

Each of the two variables is trusted only while the slot or nested run it names belongs to a job that has started,
whose file names its start time and process group, and the process holding that slot or running that nested run is
an ancestor of the new run. A nested run that still waits for a place is not trusted as a parent yet. A copy of the
variables in another shell, or one left in a program that outlived its job, fails that check, and that run queues as
usual. The variables therefore cannot be used to skip the line from outside a job.

### `status`

```
dotime-queue status
```

Prints the taken slots, each running job with its limit and time left, the waiting jobs in start order, and the
gate. `gate: open` means a job may start now; `gate: shut;` is followed by what holds new jobs back. `dotime-queue`
with nothing after it prints the same as `status`. A [nested run](#run) is shown indented under the job it runs in,
and a nested run inside a nested run one step further in; it holds no slot and is not counted as one. A nested run
that waits for a place under its parent says `waiting for a nested place` and names the parent. Its `min so far`
counts from when it began to wait, and once it runs, from when it started to run.

The gate is judged by the same rules as `run`, so a high load with an idle CPU shows as open. `run` judges on the
reading it shares with the other waiting jobs; `status` takes a reading of its own each time. When the load is above
its limit, memory, disk and battery do not already hold a job, and `health.json` holds no usable CPU times up to 5
seconds old, that reading takes about a second longer, while the CPU is measured. CPU times younger than half a
second make it wait only for the rest of the half second.

`status` only reads the state folder and never changes it. The file of a job that has ended is still left out of
what it prints, but the file itself stays until a waiting `run` or the reaper removes it.

### `passed`

```
dotime-queue passed [--match <text>] [--cwd <dir>]
```

Answers "did this check already pass on exactly this code?". `run` asks the same for every `test` or `lint` job
and skips one that already passed (see **Checks that already passed** under [`run`](#run)), so an agent does not need
to call `passed` first. It still may, for example for a build. `passed` asks a broader question than `run`: it looks
at every run in the repository, not only at those of one folder, label, command and fingerprint, so it can show a
stamp for a check that `run` rightly runs again.

It works only on a clean, committed tree: the folder must have no uncommitted or untracked changes now, and the run
it finds must have started with none. With local changes it always prints `no stamp:` and exits 1.

It looks at runs started in a repository of the same name, on the commit the folder is at now, that began with a
clean tree. Runs that were stopped or timed out are left out, since they say nothing about the code, and so are
jobs that `run` skipped. If the newest of what is left exited 0, it prints a `stamp:` line and exits 0. In every
other case it prints a `no stamp:` line that says why and exits 1. `--match` keeps only runs whose label or command
contains the text, in any letter case; without it, the newest run of any check counts. `--cwd` asks about another
folder. A folder outside git gives
`no stamp: this folder is not a git checkout`, and a repository whose current branch has no commits yet
(a new repository) gives `no stamp: the current branch has no commits yet`; both exit 1. Without `--cwd`, in a
folder that was removed, `passed` says so, points to `--cwd <dir>` and exits 2.

Note: an untracked entry named `node_modules` that is not a folder (in practice a link) does not count as a change.
Git's usual `node_modules/` ignore rule matches folders only, so git lists such a link.

### `history`

```
dotime-queue history [--days <n> | --day <YYYY-MM-DD>]
```

Sums up the journal: one row for all projects and one per project, with outcome counts, waiting time and the gates
that caused the waiting. Once a row has skipped jobs, its outcome counts end with `skipped N (saved M min)`, where M
is the run time of the passing runs those jobs relied on. The outcome counts close with `flaky N`: the [flaky
checks](#flaky-checks) of that row whose runs ended in the range. The waiting columns answer three questions. `sum`:
how much waiting all jobs did together. `clock`: how long the line was not empty. `clock with no job running`: how
much of that time jobs were waiting while none of this row's jobs ran, for example because the health gate was shut.
`--days` covers the last n calendar days including today (default 7); `--day` covers one day. Days are counted in
the `DOTIME_TZ` zone, UTC by default. `--days` takes a whole number of 1 or more and `--day` a date as `YYYY-MM-DD`;
anything else exits 2. The median and p90 are nearest-rank percentiles, the same ones the run limits use.

### `flaky`

```
dotime-queue flaky [--days <n>]
```

Lists the [flaky checks](#flaky-checks) of the last n days (default `flakyWindowDays`, 14), one line per check, the
newest mixed run first, and exits 0. Each line names the check, how many commits it both passed and failed on, the
passes and failures on those commits, how long ago the newest of those runs ended, and the command. With no flaky
check it prints one line, `flaky: none in 14 days`. `--days` takes a whole number of 1 or more; anything else exits 2.

```
shop-api: unit tests; mixed on 3 commits, 5 passes and 3 failures, last 2 h ago; command npm test
```

### `setup`

```
dotime-queue setup [--write] [--cwd <dir>] [--mcp]
```

Puts the queue instruction into a project's agent instruction files, so the coding agents that work in it start
their heavy commands through the queue. The project folder is the one `--cwd` names; without it, the top folder of
the git repository the current folder is in, or the current folder outside git. The first line says which folder
was used. setup looks there for `AGENTS.md`, `CLAUDE.md` and `.claude/CLAUDE.md`. Each one it finds gets the
instruction block; when none exists, `AGENTS.md` is created with the block alone.

Claude Code does not read `AGENTS.md` when it finds a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in the
folder or above it. `CLAUDE.local.md` is one person's own file, usually kept out of git. When it is the only one of
those three in the project folder, it gets the block too, beside the `AGENTS.md` that other agents read, and setup
prints a note that says why; next to a `CLAUDE.md` or `.claude/CLAUDE.md` it is left alone, unless it holds the
block already. Adding the block there is safer than a warning alone: it is the file Claude Code reads, the change
sits between the markers, and a dry run shows it first. When no file in the project folder that Claude Code reads
gets the block and a folder above holds one, setup prints a note that names it and the `@` import line to add;
it never writes above the project folder.

A `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` without the block that imports `AGENTS.md` with an `@`
line (such as `@AGENTS.md`, or `@../AGENTS.md` in `.claude/CLAUDE.md`) is not given a copy of its own: Claude Code
reads the block through the import. setup prints `would skip` or `skipped` for it, with the reason. An `@` inside
a code span or a fenced code block is no import.

Without `--write`, setup is a dry run: it prints `would create`, `would add the block to` or `would update the block
in` for each file, then the block, and changes nothing. With `--write` it makes those changes and prints `created`,
`added the block to`, `updated the block in` or `unchanged:` for each file, then a `changed:` line that names every
file it wrote, or `changed: nothing`.

The block starts with the line `<!-- dotime-queue setup: begin; ... -->` and ends with
`<!-- dotime-queue setup: end -->`. A file without the block gets it at the end, after a blank line; a file with it
gets only the lines from the begin marker to the end marker replaced. Every other byte of the file stays as it was,
so running setup again changes nothing until the block's text changes in a newer version. A file whose lines end in
CRLF gets the block in CRLF too. Marker lines inside a fenced code block are an example and do not count; spaces
after a marker do not matter. A file with a begin marker and no end marker, with two blocks, or with the end
before the begin, is not changed: fix the markers by hand.

setup writes only inside the project folder, and only the files it names. A `CLAUDE.md` that is a link to
`AGENTS.md` is written once; an agent file that is a link to a file outside the project folder is refused, and so
is one with a second hard link, since that other name may be outside the project folder. A missing `AGENTS.md`
is created only when no file or link of that name exists, so a dangling link is never followed. Before
anything is written, every file to change is checked: when one cannot be read or written (a read-only file, for
example), setup names it, writes nothing and exits 1. It reads no settings and never touches the state folder.

`--mcp` also prints the settings for the [MCP server](../README.md#use-with-an-mcp-client): the generic
`mcpServers` entry with `"command": "dotime-mcp"`, the command that adds it to Claude Code, and the entry for a
clone that was not linked, with the full path of its `mcp/server.mjs`. It writes no MCP settings file.

setup exits 0 when it is done, also as a dry run, 1 when a file cannot be read or written, and 2 for an unknown
option, a `--cwd` that is not an existing folder, or, without `--cwd`, a current folder that was removed.

## Projects and kinds

The project of a job is the label text before the colon. That text may be at most 40 characters: a longer one is
not taken as a project name, so a sentence with a colon in it does not make a new project. Without a project in the
label, the project is the name of the git repository the job runs in (a linked worktree counts as its main
repository), and outside git the name of the folder.

The kind groups similar jobs for the run limit. It is read from the label's task part (the text after the project
prefix) and, only when that matches nothing, from the command. In each, it is the first match in this list, read
from the top: `deploy tests` is a `deploy` job, and `build tests` is a `test` job.

| Kind | Words |
| --- | --- |
| `debug` | `debug`, `repro`, `bisect`, `probe`, or a question mark in the label's task part. See below. |
| `deploy` | `deploy`, `release`, `publish` |
| `test` | `test`, `tests`, `check`, `suite`, `spec`, `e2e`, `vitest`, `jest`, `playwright`, `node --test` |
| `build` | `build`, `bundle`, `compile` |
| `lint` | `lint`, `typecheck`, `tsc`, `format` |
| `other` | anything else |

In the command, a `debug` word followed by `=` does not count, so `DEBUG=1` does not make a debug job.

## Run limits

Without `--max-run`, the journal decides the limit. Only passed runs count (exit 0), from the job's own project,
at most `limits.windowDays` (14) days old:

- With at least `limits.minSamples` (5) passed runs of the same command: `limits.p90Factor` (1.5) times their 90th
  percentile.
- Otherwise, with that many passed runs of the same kind: the same formula over those runs.
- Otherwise: `limits.defaultMin`, 30 minutes.

A measured limit is never below `limits.floorMin` (10 minutes). A `debug` job gets `limits.debugMin` (15 minutes)
instead. Even before it has 5 passed runs, a command's own runs count: when 1.5 times its longest passed run is more
than the limit above, that becomes the limit. Passed runs under `--max-run` count as history too.

**The 30-minute trap.** Until a command, or its kind in that project, has enough passed runs, its limit is
`limits.defaultMin`, 30 minutes. A command that normally takes longer is stopped at 30 minutes every time. A stopped
run is not a pass, so it never builds a history and the limit never grows. Two such stops on unchanged code also
lead to a refusal (see [Repeated failures](#repeated-failures)). The fix: pass `--max-run <min>` to that command, or
raise `limits.defaultMin` in `config.json`.

Two commands count as the same when they have the same stem: the program and its task, without paths, flags and
variable assignments (`npm run build -- --watch` and `npm run build` share the stem `npm run build`). Labels and
`--kind` do not split a stem: `npm test -- a.test.js` and `npm test` are both `npm test`. Many quick partial runs
can pull the learned limit of the full suite down; if that happens, give the full suite `--max-run`.

A job that reaches its limit ends `run` with exit 124. Before that, its whole process group receives TERM and,
`limits.killGraceMs` (10 seconds) later, KILL. With `--priority` the stop moves out to `limits.priorityGrace` (2)
times the limit, and reaching the limit itself only prints a warning. When the last KILL is refused, for example
for a process that runs as another user, the job is still there: `run` then prints `timed out: exit 124, stop failed
after N min, KILL refused for group 48210 (EPERM), pid 48215 (EPERM)` instead of `stopped after N min`, naming the
group when the signal to the whole group was refused and each process that refused it, and the journal line gets
`stopFailed` with the same reason. The slot is freed either way, because `run` itself ends.

**Long-run notice.** A job that runs much longer than usual gets one notice and keeps running. `run` prints it,
and it goes out as a [notice](#notices): to `notify.log`, as a desktop notice, and into `notices/`. The mark
is `limits.longRunFactor` (2) times the 75th percentile of the same runs (at least `limits.floorMin`), or
`limits.longRunUnmeasuredMin` (20 minutes) when there are fewer than 5 of them. A command with a few passed runs of
its own raises the mark to 2 times their 75th percentile, when that is more. No notice is sent when the mark is not
earlier than the stop.

## Repeated failures

When the same check failed twice in a row within `limits.failWindowHours` (6), and neither the commit nor the
uncommitted and untracked files have changed since, a third run is refused: `run` prints a `refused:` line and
exits 3. The way out: change the code, or pass `--after-fix "<note>"` in front of the `--`. A failure is a non-zero
exit or a stop at the run limit. Runs that were stopped by a signal, and commands that could not be started, do
not count.

Renaming the label does not reset the count. Earlier runs belong to a check when they carry its label, and runs
under another label still belong when command, project and folder are all identical.

What is compared between the failures and the new run:

- the command line: a new run of the check with another command is let through, and two failures count as the same
  failure twice only when they ran the same command;
- the commit;
- uncommitted changes to tracked files, wherever they are, and the list of changed and untracked paths as
  `git status` prints it;
- the content of untracked files that git does not ignore, up to 2000 files. A file above 1 MB, or one that would
  take the total past 32 MB, counts by its size and modification time;
- files the job's command mentions by path: their content, when they are smaller than 4 MB.

All of this is hashed on the computer; the journal keeps only a short hash, in the field `fp`.

Two groups of untracked files are skipped, because a check rewrites them itself: files inside a folder named in
`outputDirs`, at any depth, and files ending in `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.ico`, `.bmp`,
`.mp4`, `.webm`, `.mov`, `.pdf`, `.zip`, `.gz`, `.tgz` or `.log`. Tracked files are never skipped. If your fix
changes only such untracked files, the code counts as unchanged: pass `--after-fix "<note>"`.

## Flaky checks

A check is flaky when, within the last `flakyWindowDays` (14) days, it both passed and failed on the same commit in
the same folder, each time from a clean tree. The same code gave two results, so a failure of it may come from the
test or the machine and not from the change at hand. Checks are told apart the way
[Repeated failures](#repeated-failures) tells them apart: by label, else by command, project and folder.

Only runs that ended by themselves count: a pass is exit 0, a failure any other exit. A run that hit its run limit,
was stopped, refused, skipped, gave up, left the line or could not start never counts, and neither does a run that
began with uncommitted changes or outside a git checkout.

The flag is advice only. It changes no exit code, no skip and no refusal, and nothing is run again. When a run of a
flaky check fails, `run` prints one more line after the job ends; the run that just failed counts, so a check that
passed earlier on this commit is flagged at its first failure. A `refused:` line of a flaky check ends with the same
note, and `queue_job` gives it in its `flaky` field.

```
dotime-queue: flaky: this check passed and failed on the same commit 3 times in 14 days, last 2 h ago; the failure
may not come from your change
```

`3 times` counts the commits, and `once` stands for one. `dotime-queue flaky` lists the flaky checks, and `history`
counts them per project.

## Isolated runs

Agents that work side by side in one checkout edit the same files. An isolated run gives each job a checkout of its
own, and brings its work back only after a check passed on the result:

```
dotime-queue run --isolate --label "shop-api: rename price field" -- <agent or edit command>
dotime-queue worktrees
dotime-queue integrate <id> -- npm test
dotime-queue discard <id> [--force]
```

**`run --isolate`.** The folder must be in a git repository with at least one commit and a clean working tree, by
the rule the journal uses: no tracked changes and no untracked files that are not ignored. Otherwise `run` exits 2,
for example `dotime-queue: --isolate needs a clean working tree; /src/shop-api has 2 uncommitted changes or untracked
files; commit or stash your changes first; nothing was started`. A detached HEAD is fine: the job starts from the
commit. The job then waits in line like any other. Once it holds its slot it gets a new id of 8 hex digits, a branch
`dotime/<label>-<id>` (the label in lowercase letters, digits and dashes, at most 40 characters; `job` without a
label) and a folder `<repo>-<id>` in `worktrees/` of the state folder, made with `git worktree add` at the commit the
job was queued on. A branch, folder or id that is already there is never reused: a new id is picked. A job that is
refused (exit 3), gives up waiting (exit 75) or leaves the line (exit 130) never gets a worktree. The command runs in
the worktree, in the same subfolder `run` was started in, under the same slot, gate, limit and repeated-failure rules
as any job. It is never skipped, since it changes files, and a pass in a worktree is no pass stamp for the checkout.
The check is still the one of the folder `run` was started in, so the repeated-failure stop and the flaky flag count
isolated runs and plain runs of one check together.

A fresh worktree holds only what git tracks: no installed packages, no `.env`, no build output. The setting
`isolateLinks` names paths to link into it from your checkout, such as `["node_modules"]`; a path is linked only when it
exists in the checkout and git ignores it there. The links are never committed, and removing a worktree removes only
the links, never what they point to. A job that writes into a linked folder writes into your checkout's copy.

After exit 0, changes the command left uncommitted are committed on the job's branch as `dotime: <label>` with the
repository's own name and e-mail, and two lines follow:

```
dotime-queue: committed: 1 change on branch dotime/shop-api-rename-price-field-3fa9c2d1 as 9b1e0c4a "dotime: shop-api: rename price field"
dotime-queue: isolated in ~/.dotime/worktrees/shop-api-3fa9c2d1 on branch dotime/shop-api-rename-price-field-3fa9c2d1; integrate with: dotime-queue integrate 3fa9c2d1 -- <check>
```

Without a configured `user.name` and `user.email` (or the `GIT_AUTHOR_` and `GIT_COMMITTER_` variables), or when a
commit hook refuses, the changes stay uncommitted and a `not committed:` line says so; `integrate` refuses such a job
until they are committed. After a failure, a timeout or a stop, the worktree is kept as it is, nothing is committed,
and the line is `dotime-queue: kept <folder> on branch <branch> for a look; remove it with: dotime-queue discard
<id>`. The journal line of an isolated run adds `isolate`: `{ id, branch, worktree, base, baseBranch }`, where
`baseBranch` is null on a detached HEAD.

**`integrate <id> -- <check command>`.** Run it in a folder of the same repository. It refuses with exit 2 and
changes nothing when the check command is missing, the job did not end with exit 0, the job's worktree has
uncommitted changes, your checkout has uncommitted changes, or your checkout is not on the branch the job started
from (the message names the branch to switch to). Then it makes a temporary worktree at your HEAD, detached, and
merges the job's branch there with `git merge --no-ff` as `dotime: integrate <label>`. A conflict aborts the merge,
removes the temporary worktree, names the files and exits 1; the job is kept. The check then runs in the temporary
worktree through the queue, labelled `<job label>: integrate`, with `isolateLinks` linked. When it fails, its exit
code is passed on and nothing else changes. When it passes, your branch is fast-forwarded to the commit the check
passed on. If your branch moved while the check ran, nothing is changed and it says to run `integrate` again. Only
after the fast-forward are the temporary worktree, the job's worktree and its branch removed (`git branch -d`). A job
whose branch is already in your HEAD, for example one that changed nothing, is just removed. Two jobs integrated one
after the other both land: the second is merged onto the first.

**`discard <id> [--force]`.** Removes the job's worktree and branch. Without `--force` it refuses with exit 2 while
the branch has commits that are not in the branch the job started from, or the worktree has uncommitted changes,
and says how many. A worktree folder that was deleted by hand is pruned (`git worktree prune`).

**`worktrees`.** One line per kept job, oldest first: `worktree <id>: "<label>", branch <branch>, folder <folder>,
<outcome>, <n> min old`, with the exit code after a failure and `folder missing` when the folder is gone; or
`worktrees: none`. Exits 0.

Nothing here ever stashes, resets or force-pushes, and no branch with unmerged commits is deleted without
`--force`. The state of each kept job is a file `worktrees/<id>.json` in the state folder, so `integrate` and
`discard` work after a restart.

## Exit codes

| Code | Meaning |
| --- | --- |
| the job's own | The job ran and ended by itself. A job ended by a signal gives 1; see [`run`](#run). |
| 0 | Also a `test` or `lint` job that was skipped because it already passed on this commit; see [`run`](#run). |
| 2 | The command line was not understood, for example an unknown option or a value that is not a number. Also `run`, and `passed` and `setup` without `--cwd`, from a folder that was removed. Also `run --isolate` outside git or in a dirty tree, and `integrate` or `discard` refused before changing anything. |
| 3 | Refused: the same check failed twice on unchanged code. Change the code or pass `--after-fix "<note>"`. |
| 75 | Gave up waiting after `--max-wait`. Not a test failure. |
| 124 | Stopped at the run limit. |
| 127 | The job's command could not be started. Journalled as `could-not-start`, not as a failure. |
| 130 | Left the line because of a signal. |

`integrate` exits 0 once your branch holds the job, 1 for a merge conflict or a branch that moved during the check, and
the check's own code when the check fails; see [Isolated runs](#isolated-runs). `discard` exits 1 when git could not
remove the worktree or branch. `passed` exits 0 with a stamp and 1 without. `setup` exits 1 when an agent file cannot be
read or written; see [`setup`](#setup).

## Message format

Every message has the same shape: clauses separated by `; `, each clause a topic, a colon, and facts separated by
commas. Durations are written as `12 min`, percentages as `20%`, sizes as `40 GB`, clock times on a 24-hour clock
with the zone name.

Sample lines. Each is one line on screen; long lines are wrapped here, and `<date and time>` stands for a value.

```
dotime-queue: in line: position 2, 3 min waited, wait limit 60 min; no free slot: 2 of 2 taken, by "shop-api: e2e"
and "docs-site: build"
dotime-queue: in line: position 1, 0 min waited, wait limit 60 min; disk too low: 7.4 GB free, 10 GB needed; hint:
the job starts once there is more free disk; to start with less, lower health.minFreeDiskGB in
/home/you/.dotime/config.json
dotime-queue: gave up: exit 75, position 1, 60 min waited; memory too low: 9% free, 20% needed; hint: --max-wait 0
waits without limit
dotime-queue: skipped: "shop-api: unit tests" already passed on commit 0a1b2c3d (12 min ago); --no-skip runs it anyway
stamp: commit 0a1b2c3d, passed 4 min ago by "shop-api: unit tests", command npm test, run time 2.5 min, tree clean
at start, finished <date and time> UTC
```

## Health gate

The gate is checked only before a job starts. A running job is never stopped because the computer got busy.

| Reading | Taken from | Holds a job when |
| --- | --- | --- |
| Load | 1-minute load average per core, and the share of CPU time in use since the last shared reading, when that was half a second to 5 seconds ago, or else over one second. While jobs wait, a new shared reading is taken about every `pollMs`, so the span is about `pollMs` when that is between half a second and about 5 seconds. With a shorter `pollMs` a reading waits until half a second has passed; from about 5 seconds up, the saved CPU times are always too old, and every reading that measures the CPU waits one second. | above `health.loadPerCore` while the CPU is at least `health.busyCpuPct` percent busy |
| Free memory | on macOS the free percentage that `memory_pressure` reports; on Linux `MemAvailable` as a share of `MemTotal` in `/proc/meminfo` | below `health.minFreeMemPct` |
| Free disk | the space free for users on the disk that holds `/`, as `df` counts it, read through Node's `statfs` | below `health.minFreeDiskGB` |
| Battery | `pmset -g batt` on macOS; on Linux the batteries and chargers in `/sys/class/power_supply` (batteries of a mouse, keyboard or phone do not count) | at or below `health.minBatteryPct` while on battery |

If the charger cannot keep up and the charge keeps falling, the battery limit applies as if unplugged.
A computer without a battery of its own, such as a server or a desktop, has no battery limit, and neither has one
whose battery state cannot be read. On Linux, several batteries count as one, with their mean charge.

The 1-minute load average lags: after heavy work ends it stays high for up to a minute while the CPU is already
idle. So when the load is above its limit, the gate also measures how busy the CPU is right now, from two readings
of the CPU times, and holds the job only when that share is at or above `health.busyCpuPct`. Each shared reading
of a waiting job keeps the CPU times it ended on in `health.json`; a `status` reading only reads them. When those
are between half a second and 5 seconds old, the next reading measures the CPU since then and does not wait; when
they are younger, it waits for the rest of the half second and then measures since then; when there are none, they
are older or they make no sense, it takes two readings one second apart. The message then names both numbers, for
example `load too high: 12.4 now, 8.0 allowed; CPU 96% busy now`. When the load is inside its limit, the CPU is not
measured and the load never holds a job. The CPU is measured after memory, disk and battery, and not at all when one
of those already holds the job. When the CPU is not measured or cannot be measured, a load above its limit holds the
job as the load alone would.

When a value cannot be read, such as on a computer with no battery or when a tool does not answer, that check is
left out and never holds a job, so it protects nothing until it can be read again. A reading of 0, such as a full
disk, is a real value and does shut the gate.

## Reaper

```
node queue/reaper.mjs          # one run; schedule it to run every few minutes
node queue/reaper.mjs --dry    # print what a run would do, change nothing
```

The reaper is optional. It runs only if you schedule it, and the queue works without it. It exits 0 after a run,
also a dry one, and 1 when the run fails. An option other than `--dry`, or `--dry` given twice, is refused with
exit 2, and then nothing runs, as for an option given twice to `run`.

**When it runs, it can stop idle dev servers anywhere on this computer**, also ones you started yourself and not
through the queue, in any project. It stops nothing else. To protect a server, add a part of its command line to
`reaper.keepPattern` (see [Settings](#settings)). To see first what it would do, run it with `--dry`.

It stops a dev server only when all of these hold:

- its command matches `reaper.serverPattern` (by default `vite`, `vitest`, `next dev`, `wrangler dev`,
  `webpack serve`, `webpack-dev-server` and `nodemon`);
- its process group is older than `idle.serverIdleMin` (30) minutes and used less than `idle.serverCpuS` (10)
  seconds of CPU in that time;
- its process group holds nothing but the server and its launchers (details below), so nothing else is stopped
  with it;
- no process in the group holds a slot, runs a one-shot test command, or matches `reaper.keepPattern`, and the group
  is not the reaper's own.

It then sends TERM to the group and, `limits.killGraceMs` later, KILL to what is left. When a signal is refused,
for example for a server that runs as another user, the reaper prints `stop failed: idle dev server ...` with the
reason, keeps the server under watch, and sends a notice, at most one an hour for the same process group. CPU use
is compared between reaper runs, so one run by hand only takes a sample: idle servers show up only after runs have
covered a whole idle window.

Each run also:

- sends one notice for a job that used less than `idle.slotCpuS` seconds of CPU in `idle.slotIdleMin` minutes while
  holding a slot;
- reports a large test run that was not started through the queue: 5 or more test processes, or 2 or more that
  together use 2 GB of memory or more. It is left running, with at most one notice an hour;
- reports an overloaded computer when two runs in a row see it, at most once an hour;
- reports low disk space, at most every six hours.

A test run counts as started through the queue when it descends from a process that holds a slot. A shell that
starts a test runner with `-c`, such as `bash -c "npx vitest run"`, is only its launcher: it is not counted as a test
process and is never reported as the run's root. This holds for `sh`, `bash` and `zsh` in any folder: a shell in
`/opt/homebrew/bin` or `/usr/local/bin` counts as a launcher just like one in `/bin`.

What "nothing but the server and its launchers" means: the server, the processes it started, and the processes
above it that are package-script launchers (`npm`, `npx`, `pnpm`, `yarn`, `bun`, or the script `node` runs for one
of them, and `sh -c`, `bash -c`, `zsh -c`) or name a dev server themselves. The server is the innermost matching
process, so a launcher that names the server is never taken for it. An idle server that shares its group with
another program is reported and left running.

### Scheduling the reaper with cron

Run `crontab -e` and add these two lines. On macOS:

```
PATH=/usr/bin:/bin:/usr/sbin
*/5 * * * * /path/to/node /path/to/deployontime/queue/reaper.mjs >> "$HOME/Library/Logs/dotime-reaper.log" 2>&1
```

On Linux:

```
PATH=/usr/bin:/bin
*/5 * * * * /path/to/node /path/to/deployontime/queue/reaper.mjs >> "$HOME/.local/state/dotime-reaper.log" 2>&1
```

Create the log folder first if it does not exist (`mkdir -p ~/.local/state`).

Replace `/path/to/node` with what `command -v node` prints, and `/path/to/deployontime` with the folder of the
package: `$(npm root -g)/deployontime` after `npm install -g`, or your clone. The
`PATH` line lets the reaper find the system tools it reads (`sysctl` lives in `/usr/sbin`); it applies to every
line below it in your crontab. If you use `DOTIME_HOME`, add a `DOTIME_HOME=...` line the same way. If the clone
sits in a folder that macOS protects, such as Documents, cron may be refused access to it; a clone elsewhere in your
home folder avoids that. Notices always reach `notify.log`, also when no desktop notice shows.

To stop it, run `crontab -e` again and delete the reaper line, plus the `PATH` and `DOTIME_HOME` lines if nothing
else in your crontab needs them.

On a Linux computer with systemd, a user timer does the same. Create `~/.config/systemd/user/dotime-reaper.service`:

```
[Unit]
Description=dotime reaper

[Service]
Type=oneshot
ExecStart=/path/to/node /path/to/deployontime/queue/reaper.mjs
```

and `~/.config/systemd/user/dotime-reaper.timer`:

```
[Unit]
Description=dotime reaper every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

Then run `systemctl --user daemon-reload` and `systemctl --user enable --now dotime-reaper.timer`. The reaper's
lines go to the journal: `journalctl --user --unit dotime-reaper`. For `DOTIME_HOME`, add
`Environment=DOTIME_HOME=...` under `[Service]`. A user timer runs only while you are logged in, unless
`loginctl enable-linger` is on for your account. To stop it, run
`systemctl --user disable --now dotime-reaper.timer` and delete the two files.

## Scheduled-job report

```
node queue/schedule-check.mjs [--dry] [--json]
```

An optional extra, separate from the queue: a health report on your own scheduled jobs. It reads every job file in
`~/Library/LaunchAgents`, not only ones made for this project, and checks each job: loaded, last exit code
accepted, scripts present, log as recent as the schedule implies. It changes no job; it only adds to its own log
files in the state folder. Problems go out as one notice; `--dry` only prints. It exits 1 when it cannot read the
job list from `launchctl`, and 2, without running, for an option other than `--dry` and `--json` or for one of them
given twice, as for an option given twice to `run`. Optional rules in `$DOTIME_HOME/schedule-check.json`, where
`skip` leaves jobs out:

```json
{ "skip": ["com.example.*"], "okExit": { "com.example.sync": [0, 2] }, "maxLogAgeH": { "com.example.weekly": 200 } }
```

A rules file that cannot be read, is not valid JSON or is not one JSON object is ignored, and the report runs
without rules. The warning goes to stderr, to the front of the notice and into the `warnings` field of the line in
`schedule-check.jsonl`. A missing file simply means no rules.

The report works on macOS only for now, because it reads launchd job files and `launchctl`. On Linux it prints
`schedule-check: works on macOS only for now: ...` to stderr and exits 1 without checking anything, sending a
notice or writing to its log; an option it does not know is still refused with exit 2 first. Jobs that cron or
systemd timers start on Linux are not checked.

## Notices

A notice is always appended to `$DOTIME_HOME/notify.log`. It is also shown as a desktop notice: on macOS through
`osascript` (if none appear, look at the notification settings in System Settings), on Linux through `notify-send`
when it is installed and a desktop session is running. A Linux computer without `notify-send`, such as a server,
keeps the log line and the notify command only. When `DOTIME_NOTIFY_CMD` is set, the notice is also handed to that
command through `/bin/sh`, with the texts in the environment variables `DOTIME_TITLE` and `DOTIME_MESSAGE`:

```
export DOTIME_NOTIFY_CMD='printf "%s: %s\n" "$DOTIME_TITLE" "$DOTIME_MESSAGE" >> "$HOME/queue-notices.txt"'
```

**Done notice.** A job that ran for at least `notifyDoneMin` minutes (default 5) sends one notice when it ends, so
quick runs stay quiet. The title is `dotime: done <label>`, and the message says how it ended and how long it ran:
`passed, exit 0, ran 12 min`, `failed, exit 1, ran 12 min`, `stopped by SIGTERM, ran 6 min` or
`run limit hit, ran 30 min`. A skipped or refused job, and one that gave up or left while waiting, never ran and
sends none. The notice goes out after the journal line is written; a notice that fails or hangs changes nothing about
the job's result or exit code, and the notify command is stopped after 15 seconds. Jobs started with `queue_run`
get it too, since they go through `run`. `"notifyDoneMin": 0` sends it for every job that ran.

`DOTIME_NOTIFY=log` keeps only the log line. Long-run and idle-slot notices are also stored in the folder
`$DOTIME_HOME/notices/`, one JSON file per notice, as a record you can look through. Each job gets at most one of
each, also when several processes send notices at the same time. Earlier versions kept them all in one file,
`notices.json`; it is no longer read, and you can delete it.

## Settings

Settings live in `$DOTIME_HOME/config.json`. The file is optional: create it only to change a default. The queue
creates the state folder itself the first time it runs.

The settings apply to every caller that uses the state folder. That is on purpose: one agent cannot loosen a limit
for the others. No environment variable changes a setting. A caller can ask for more for one job only, through the
flags of `run`: `--max-run`, `--priority` and `--after-fix`, described above. `DOTIME_HOME` does not change a setting
either: it picks a whole other state folder, with its own settings, slots and journal.

```json
{ "slots": 3, "health": { "minFreeDiskGB": 25 }, "idle": { "serverIdleMin": 45 } }
```

A value that does not fit is replaced by its default, with one warning on stderr. A value does not fit when it is:

- of the wrong type;
- a negative number;
- a number the table rules out. "Above 0": 0 is too low. "At least 1": anything under 1 is too low. "A whole
  number": a fraction does not fit either;
- a time in milliseconds (a key ending in `Ms`) above 2147483647, about 24 days;
- a pattern that does not compile.

An unknown name is skipped, also with one warning. A `config.json` that is not valid JSON, or that exists but cannot
be read (no permission, or a folder in its place), is ignored with one warning, and every setting keeps its
default. Only a missing file is silent.

| Key | Default | Meaning |
| --- | --- | --- |
| `slots` | 2 | Jobs that may run at once. At least 1; a fraction is rounded down. |
| `nestedPerJob` | 2 | Nested runs that one job may run at once; a further one waits for a place under that job. A whole number, at least 1. See nested runs under [`run`](#run). |
| `mcpMaxJobs` | 20 | Jobs started by `dotime-mcp` that may wait or run at once; `queue_run` refuses a further one with a tool error. Each costs two Node processes while it waits. A whole number, at least 1. |
| `flakyWindowDays` | 14 | How many days back the [flaky flag](#flaky-checks) and `dotime-queue flaky` read the journal. A whole number, at least 1. |
| `notifyDoneMin` | 5 | A job that ran at least this many minutes sends a [done notice](#notices) when it ends. 0 sends one for every job that ran. |
| `maxWaitMin` | 60 | Default for `--max-wait`. `0`: no limit. |
| `pollMs` | 3000 | How often a waiting job looks at the line and reads the health. Above 0. |
| `health.loadPerCore` | 1.0 | Gate shuts above this 1-minute load per core, while the CPU is busy now. Above 0. |
| `health.busyCpuPct` | 90 | A load above `health.loadPerCore` shuts the gate only while this percent of CPU time, or more, is in use since the last shared reading (half a second to 5 seconds) or over one second. Above 0, at most 100. |
| `health.minFreeMemPct` | 20 | Gate shuts below this free memory, in percent, as `memory_pressure` reports it on macOS or `/proc/meminfo` gives it on Linux. |
| `health.minFreeDiskGB` | 10 | Gate shuts below this free disk space. |
| `health.minBatteryPct` | 15 | Gate shuts at or below this charge while running on battery. |
| `limits.defaultMin` | 30 | Run limit with fewer than `limits.minSamples` passed runs. Above 0. |
| `limits.debugMin` | 15 | Run limit of a debug job. Above 0. |
| `limits.floorMin` | 10 | Lowest measured run limit. Above 0. |
| `limits.p90Factor` | 1.5 | Run limit as a multiple of the 90th percentile. Above 0. |
| `limits.longRunFactor` | 2 | Long-run mark as a multiple of the 75th percentile. Above 0. |
| `limits.longRunUnmeasuredMin` | 20 | Long-run mark with fewer than `limits.minSamples` passed runs. Above 0. |
| `limits.minSamples` | 5 | Passed runs needed before history sets a limit. At least 1. |
| `limits.windowDays` | 14 | How far back history is read. Above 0. |
| `limits.failWindowHours` | 6 | How long two failures stay "in a row". |
| `limits.priorityGrace` | 2 | A `--priority` job is stopped at this multiple of its limit. At least 1. |
| `limits.killGraceMs` | 10000 | Time between TERM and KILL. |
| `limits.orphanCheckMs` | 2000 | How often a job checks that its queue process is alive. Above 0. |
| `idle.serverIdleMin` | 30 | Idle window for dev servers. Above 0. |
| `idle.serverCpuS` | 10 | CPU seconds below which a dev server is idle. |
| `idle.slotIdleMin` | 10 | Idle window for a job in a slot. Above 0. |
| `idle.slotCpuS` | 5 | CPU seconds below which a job in a slot is idle. |
| `reaper.overloadPerCore` | 2.0 | Overload above this load per core. Above 0. |
| `reaper.overloadSwapPct` | 80 | Overload above this swap use. |
| `reaper.overloadMemPct` | 10 | Overload below this free memory. |
| `reaper.overloadDiskGB` | 5 | Overload below this free disk space. |
| `reaper.lowDiskGB` | 20 | Early low-disk notice below this. |
| `reaper.serverPattern` | see below | Regular expression for dev-server commands. |
| `reaper.keepPattern` | `/Applications/\|LaunchAgents` | Commands the reaper never stops. See below. |
| `outputDirs` | see below | Folder names whose untracked files are left out when failed runs are compared. |
| `isolateLinks` | `[]` | Paths, relative to the top of the repository, linked into the worktree of an [isolated run](#isolated-runs) when git ignores them, such as `"node_modules"`. No `..`, no leading `/`. |

Default `reaper.serverPattern`: `vite` (but not `vite build`), `vitest`, `next dev`, `wrangler dev`,
`webpack serve`, `webpack-dev-server` and `nodemon`. A one-shot test run, such as `vitest run`, `vitest --run`,
`node --test`, `playwright test` or `jest` without `--watch`, is never taken for a dev server.

Default `reaper.keepPattern`: the regular expression `/Applications/` or `LaunchAgents`, written as one pattern with
a `|` between the two. Programs inside `/Applications/` and scripts kept in a `LaunchAgents` folder are never
stopped. Both are macOS folders, so on Linux the default protects nothing beyond the other rules above; add the
servers you want kept the same way. To protect your own server too, add a part of its command line, for example
`{ "reaper": { "keepPattern": "/Applications/|LaunchAgents|docs-site" } }`.

Default `outputDirs`: `node_modules`, `dist`, `build`, `out`, `coverage`, `.cache`, `.next`, `.turbo`, `.wrangler`,
`.vercel`, `test-results`, `playwright-report`.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOTIME_HOME` | `~/.dotime` | The state folder. Callers share a queue only when they use the same folder. |
| `DOTIME_TZ` | `UTC` | Time zone (an IANA zone name) for printed times and for calendar days. |
| `DOTIME_NOTIFY` | not set | `log`: notices go to the log file only. |
| `DOTIME_NOTIFY_CMD` | not set | Shell command that receives each notice. |
| `DOTIME_JOB` | set by `run` | Given to each job; names the slot of the outermost job, also inside nested runs. Not a setting: see nested runs under [`run`](#run). |
| `DOTIME_PARENT` | set by `run` | Given to each job; names its direct parent: the slot it holds, or for the job of a nested run that run itself. Not a setting: see nested runs under [`run`](#run). |
| `DOTIME_NO_SKIP` | set by `run` | `1` in a job started with `--no-skip`, in a job that could not be skipped itself (such as a build), and in any job nested in either; the runs nested in it are then never skipped. Not a setting: see **Checks that already passed** under [`run`](#run). |

## Files in the state folder

| File | Content |
| --- | --- |
| `config.json` | Settings. Optional. |
| `nested/` | One small file per nested run while it waits for a place and while it runs, so `status` can show it under its parent job; it names the slot or nested run, pid and start time of that job, so it never shows under a later job in the same slot. Its name without `.json` is the `DOTIME_PARENT` the run hands its own job, and it names the outer slot the run hands on in `DOTIME_JOB`. Removed by the run when it ends; the file of a run that died goes the same way as one in `slots/`. |
| `places/` | One small file per place a running nested run holds under its parent job, named after that job's marker and start time and the place number. Claimed and freed the same way as a slot, and the file of a run that died goes the same way as one in `slots/`. |
| `slots/`, `line/` | One small file per running and per waiting job. The files of ended processes are removed by a `run` that waits in line and by the reaper (not with `--dry`); `status` leaves them. |
| `journal.jsonl` | One line per job. |
| `notices/` | Long-run and idle-slot notices, one file each. |
| `notify.log` | Every notice sent. |
| `reaper-state.json` | CPU samples between reaper runs. |
| `health.json` | The last health reading of a waiting job, with the live CPU reading when one was taken, the time the reading ended and the CPU times it ended on. Other waiting jobs reuse the reading for up to `pollMs`, and never once it is 5 seconds old; the next reading measures the CPU from the saved CPU times. A temporary `health.json.tmp-<pid>` that a process left behind when it died while writing is removed by the next saved reading once it is a minute old. |
| `schedule-check.json`, `schedule-check.jsonl` | Rules and results of the scheduled-job report. |
| `worktrees/` | The worktrees of [isolated runs](#isolated-runs), `<repo>-<id>`, with one state file `<id>.json` per kept job, and the temporary worktrees of `integrate` while it runs. |
| `mcp-jobs/` | The jobs `dotime-mcp` started: per job id the request (`.json`), the runner and queue pids (`.pid`), how the queue process ended (`.exit`) and its output (`.log`). Removed by `dotime-mcp` 7 days after the job started, or sooner beyond 200 finished jobs; a job whose runner is still alive is kept. |

A file in `slots/`, `line/`, `nested/` or `places/` is also removed when its pid now belongs to a process that
started later.

Each line of `journal.jsonl` is one JSON object with `v` (the format, now 1), `label`, `project`, `projectKey`, `cwd`,
`priority`, `queuedAt`, `startedAt`, `endedAt` (times in ISO form), `waitMin`, `runMin`, `outcome`, `exit`, `waitBy`
(minutes waited per gate), `cmd`, `head` and `clean` (the commit and whether the tree was clean), `kind`, `limitMin`,
`limitBasis` and `fp` (the hash of the code, used by the repeated-failure stop). Some lines add `stem`, `afterFix`,
`signal`, `stopFailed`, `stoppedAt`, `longRunAt`, `warnedAt`, `nested`, `isolate` (an isolated run) or `stamp` (on a
line with outcome `skipped`: the passing run it relied on). Lines written by `run` also carry `pid`, the pid of the
`run` process, so whoever started that process can find its own line. Copies of the queue that share a state folder all
read the same fields, so a field keeps its name; a new field is only ever added.

The journal and the logs are only ever added to; nothing trims them. Delete or move them when they grow too large:
the queue starts new ones. The run limits, the stamps and the repeated-failure stop then start again from no
history. For the same reason, on a computer that starts fresh for every job, such as many CI runners, the queue
never has a history.

These files stay on the computer, but they hold working folders, full command lines, job labels and the labels and
log paths of scheduled jobs. Keep that in mind before sharing them, and when `DOTIME_NOTIFY_CMD` forwards notices to
another service.

## Code layout

All code lives in `queue/`, one module per job. An entry point is started as a script; it reads the settings, the
state folder and the time zone once and hands them to the libraries, which read none of them by themselves. No
module opens a network connection; only a `DOTIME_NOTIFY_CMD` that you set can.

| Module | Purpose | Kind | Side effects it owns |
| --- | --- | --- | --- |
| `cli.mjs` | The `dotime-queue` command: reads the command line and runs `status`, `passed`, `history`, `flaky`, `setup`, `run`, `integrate`, `discard` or `worktrees`. | entry point | Prints to stdout and stderr; ends the process, in one place. |
| `run.mjs` | The `run` command in steps: plan the limit, wait for a slot (or a nested run's place), run the job. | library | Starts the job wrapper, signals the job, handles INT, TERM and HUP; writes through slots, journal and notices. |
| `worktree.mjs` | Isolated runs: the checks before one, the worktree, branch, links and state file, and the commit after a pass. | library | Runs `git` that adds worktrees, branches and commits in them; writes `worktrees/`; makes links. |
| `integrate.mjs` | The `integrate`, `discard` and `worktrees` commands. | library | Runs `git` that merges in a temporary worktree, fast-forwards your branch, removes worktrees and branches; removes `worktrees/` files. |
| `job-wrapper.mjs` | Starts the job in a process group of its own and ends the way the job ended. | entry point | Starts the job, signals its own process group, writes to file descriptor 3. |
| `reaper.mjs` | One reaper run: idle dev servers, stray test runs, idle slots, overload, low disk. | entry point | Stops idle dev-server groups, writes `reaper-state.json`, prunes `slots/`, `line/`, `nested/` and `places/`. |
| `schedule-check.mjs` | The report on scheduled jobs in `~/Library/LaunchAgents`, macOS only. | entry point | Reads job files, appends to `schedule-check.jsonl`. |
| `setup.mjs` | The queue instruction block and where `setup` puts it in a project's agent files; the MCP settings it prints. | library | Reads and, with `--write`, writes `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the project folder. |
| `args.mjs` | The flags each command accepts, their values, and the usage text. | library | None. |
| `settings.mjs` | Defaults, `config.json`, and the file names in the state folder. | library | Reads `config.json` and the `DOTIME_` variables, when an entry point asks. |
| `slots.mjs` | Slot, waiting-line, nested-run and place files: snapshot, join, take, release, update. | library | Reads and writes `slots/`, `line/`, `nested/` and `places/`; runs `ps` for process ages. |
| `nested.mjs` | Nested runs: the marker a job is given, the check that a marker is genuine, and the key of a parent's places. | library | Runs `ps` when no listing is given. |
| `gate.mjs` | Who may take a free slot, what keeps a job out, when a waiting job gives up. | library | None. |
| `health.mjs` | The health gate: judges a reading, takes one, shares it for up to `pollMs` and at most 5 s. | library | Runs the health probes; reads and writes `health.json` and removes its abandoned temporary files. |
| `limits.mjs` | Run limits from the journal history. | library | None. |
| `kinds.mjs` | Job kinds and command stems. | library | None. |
| `failstop.mjs` | The stop for a check that failed twice on unchanged code, and the rule that tells two checks apart. | library | None. |
| `flaky.mjs` | Flaky checks: the ones that passed and failed on one commit, the note `run` prints, and the `flaky` lines. | library | None. |
| `fingerprint.mjs` | A short hash of the code under test. | library | Runs read-only git commands, reads files in the working tree. |
| `journal.mjs` | Journal lines, pass stamps and `history` totals. | library | Reads and appends `journal.jsonl`. |
| `notices.mjs` | Done, long-run and idle-slot notices and the notices store. | library | Writes `notices/`; runs `ps` for CPU samples. |
| `notify.mjs` | Sends a notice: log line, desktop notice, `DOTIME_NOTIFY_CMD`. | library | Appends `notify.log`, runs `osascript` or `notify-send` and the notify command. |
| `idle.mjs` | Idle verdicts from CPU samples; the dev-server test. | library | None. |
| `stray.mjs` | Finds large test runs outside the queue. | library | None. |
| `commands.mjs` | The test, shell and launcher command patterns, each with its reason. | library | None. |
| `git.mjs` | The queue's git calls, read-only and with time limits; the repository's top folder for `setup`. | library | Runs `git`. |
| `project.mjs` | The project of a job: label prefix, repository name or folder name. | library | Runs `git` through `git.mjs`. |
| `probes.mjs` | Readings from the operating system, one function each, with a macOS and a Linux branch where they differ. | library | Runs `ps`, on macOS also `memory_pressure`, `sysctl`, `pmset`, `osascript`, `launchctl`, `plutil`, on Linux `notify-send`; reads `/proc/meminfo` and the disk through `statfs`. |
| `linux.mjs` | Readings Linux keeps in `/proc` and `/sys`, with their parsers. | library | Reads `/proc/meminfo` and `/sys/class/power_supply`. |
| `ps.mjs` | Parsers for `ps` output. | library | None. |
| `proctree.mjs` | Process trees: descendants, ancestors, a job's pids and CPU; group signals and stops. | library | Sends signals; runs `ps` when no listing is given. |
| `files.mjs` | JSON read with warnings, atomic JSON write, removal of abandoned temporary files, append with folder. | library | Reads, writes and removes the files it is handed. |
| `timer.mjs` | Timers that can be cancelled, also ones longer than one Node timer can hold, and a sleep that can be ended early. | library | Sets and clears timers. |
| `clock.mjs` | Clock times, days and zone offsets. | library | None. |
| `stats.mjs` | The percentile that limits and `history` share. | library | None. |
| `units.mjs` | Time units and rounding. | library | None. |
| `testkit.mjs` | Test helpers: temp folders, started processes, isolated git and state folder, stored notices, a script started as on another platform. | test helper | Creates and removes temp folders, signals processes the tests started. |

## Tests

From the repository's top folder:

```
npm test                         # everything (the same as node --test)
node --test queue/slots.test.mjs # one file
```

The code has no switch for the tests. A test that needs a made-up health reading, or a clock that jumps ahead, runs
the steps of `run` inside the test process and hands them stand-ins for the clock, the health reading and the
signals (see `queue/run.test.mjs`). Every test file gets a state folder of its own inside the temp folder.

The tests run on macOS and on Linux, and CI runs them on both. The Linux readers are tested on sample text on any
computer, and a few tests start a script as if on the other platform. The tests that need launchd and `plutil` are
skipped on Linux, each with its reason.
