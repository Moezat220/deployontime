# Machine queue

Machine queue is one waiting line for the heavy jobs on a Mac that several coding agents use at the same time:
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

**Your repository.** The queue never edits your repository. It runs read-only git commands and reads files to
tell whether the code changed between runs. The commands you run through it do what they always do. The queue
opens no network connection; only a `DOTIME_NOTIFY_CMD` that you set can send notices elsewhere.

## Install

Requirements: macOS only, because the queue reads `pmset`, `memory_pressure`, `launchctl` and `ps`. Node 22 or
newer. git 2.31 or newer.

```
git clone https://github.com/Moezat220/deployontime.git
cd deployontime
npm link
dotime-queue status
```

`npm link`, run in the repository's top folder, puts `dotime-queue` on your path. No npm packages are downloaded:
the queue has no dependencies. The first line of `dotime-queue status` should read `slots: 0 of 2 taken, 0 waiting`.

Without `npm link`, call `node <path to the clone>/queue/cli.mjs` from any folder. The `queue/` folder needs nothing
outside itself. The examples below use `dotime-queue`.

To uninstall:

```
npm uninstall -g deployontime
rm -rf ~/.dotime        # or the folder DOTIME_HOME names
```

If you scheduled the [reaper](#reaper), also remove it from your scheduler (for cron, see
[the end of that section](#scheduling-the-reaper-with-cron)).

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

Options go in front of the `--`. Everything behind it is the job's command. Keep `--priority` out of agent
instructions: an agent that uses it every time puts itself in front of everyone else.

An option that is not in this table, an option without its value or with an empty value, an option given twice,
or any other word in front of the `--` is refused with exit 2, for example `dotime-queue: unknown option --max-runn`.
A word that starts with `--` is not taken as the value of the option in front of it: `--label --priority` is refused
because `--label` has no value. To give such a value, join it to the option with `=`: `--label=--priority`. The
refusal message says so, with the value in single quotes when a shell would split or change it. The job does not run. The same holds for `status`, `passed` and `history`: each accepts
only the options shown for it.

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

### `status`

```
dotime-queue status
```

Prints the taken slots, each running job with its limit and time left, the waiting jobs in start order, and the
gate. `gate: open` means a job may start now; `gate: shut;` is followed by what holds new jobs back. The gate is
judged by the same rules as `run`, so a high load with an idle CPU shows as open. `run` judges on the reading it
shares with the other waiting jobs; `status` takes a reading of its own each time. When the load is above its limit
and `health.json` holds no CPU times between half a second and 5 seconds old, that reading takes about a second
longer, while the CPU is measured. `dotime-queue` with nothing after it does the same.

`status` only reads the state folder and never changes it. The file of a job that has ended is still left out of
what it prints, but the file itself stays until a waiting `run` or the reaper removes it.

### `passed`

```
dotime-queue passed [--match <text>] [--cwd <dir>]
```

Answers "did this check already pass on exactly this code?". `run` never asks this by itself and never skips a job.
An agent that wants to skip a check that is already green must call `passed` first, and skip only on exit 0.

It works only on a clean, committed tree: the folder must have no uncommitted or untracked changes now, and the run
it finds must have started with none. With local changes it always prints `no stamp:` and exits 1.

It looks at runs started in a repository of the same name, on the commit the folder is at now, that began with a
clean tree. Runs that were stopped or timed out are skipped, since they say nothing about the code. If the newest
of what is left exited 0, it prints a `stamp:` line and exits 0. In every other case it prints a `no stamp:` line
that says why and exits 1. `--match` keeps only runs whose label or command contains the text, in any letter case;
without it, the newest run of any check counts. `--cwd` asks about another folder.

Note: an untracked entry named `node_modules` that is not a folder (in practice a link) does not count as a change.
Git's usual `node_modules/` ignore rule matches folders only, so git lists such a link.

### `history`

```
dotime-queue history [--days <n> | --day <YYYY-MM-DD>]
```

Sums up the journal: one row for all projects and one per project, with outcome counts, waiting time and the gates
that caused the waiting. The waiting columns answer three questions. `sum`: how much waiting all jobs did
together. `clock`: how long the line was not empty. `clock with no job running`: how much of that time jobs were
waiting while none of this row's jobs ran, for example because the health gate was shut.
`--days` covers the last n calendar days including today (default 7); `--day` covers one day. Days are counted in
the `DOTIME_TZ` zone, UTC by default. `--days` takes a whole number of 1 or more and `--day` a date as
`YYYY-MM-DD`; anything else exits 2. The median and p90 are nearest-rank percentiles, the same ones the run limits
use.

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

## Exit codes

| Code | Meaning |
| --- | --- |
| the job's own | The job ran and ended by itself. A job ended by a signal gives 1; see [`run`](#run). |
| 2 | The command line was not understood, for example an unknown option or a value that is not a number. Also `run` from a folder that was removed. |
| 3 | Refused: the same check failed twice on unchanged code. Change the code or pass `--after-fix "<note>"`. |
| 75 | Gave up waiting after `--max-wait`. Not a test failure. |
| 124 | Stopped at the run limit. |
| 127 | The job's command could not be started. Journalled as `could-not-start`, not as a failure. |
| 130 | Left the line because of a signal. |

`passed` exits 0 with a stamp and 1 without.

## Message format

Every message has the same shape: clauses separated by `; `, each clause a topic, a colon, and facts separated by
commas. Durations are written as `12 min`, percentages as `20%`, sizes as `40 GB`, clock times on a 24-hour clock
with the zone name.

Sample lines. Each is one line on screen; the stamp line is wrapped here, and `<date and time>` stands for a value.

```
dotime-queue: in line: position 2, 3 min waited, wait limit 60 min; no free slot: 2 of 2 taken, by "shop-api: e2e"
and "docs-site: build"
dotime-queue: gave up: exit 75, position 1, 60 min waited; memory too low: 9% free, 20% needed; hint: --max-wait 0
waits without limit
stamp: commit 0a1b2c3d, passed 4 min ago by "shop-api: unit tests", command npm test, run time 2.5 min, tree clean
at start, finished <date and time> UTC
```

## Health gate

The gate is checked only before a job starts. A running job is never stopped because the computer got busy.

| Reading | Taken from | Holds a job when |
| --- | --- | --- |
| Load | 1-minute load average per core, and the share of CPU time in use over about one second | above `health.loadPerCore` while the CPU is at least `health.busyCpuPct` percent busy |
| Free memory | the free percentage that `memory_pressure` reports | below `health.minFreeMemPct` |
| Free disk | `df` for the disk that holds `/` | below `health.minFreeDiskGB` |
| Battery | `pmset -g batt` | at or below `health.minBatteryPct` while on battery |

If the charger cannot keep up and the charge keeps falling, the battery limit applies as if unplugged.

The 1-minute load average lags: after heavy work ends it stays high for up to a minute while the CPU is already
idle. So when the load is above its limit, the gate also measures how busy the CPU is right now, from two readings
of the CPU times, and holds the job only when that share is at or above `health.busyCpuPct`. Each health reading
keeps the CPU times it ended on in `health.json`. When those are between half a second and 5 seconds old, the next
reading measures the CPU since then and does not wait; otherwise it takes two readings one second apart. The
message then names both numbers, for example `load too high: 12.4 now, 8.0 allowed; CPU 96% busy now`. When the
load is inside its limit, the CPU is not measured and the load never holds a job. The CPU is measured after memory,
disk and battery, and not at all when one of those already holds the job. When the CPU is not measured or cannot be
measured, a load above its limit holds the job as the load alone would.

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

Run `crontab -e` and add these two lines:

```
PATH=/usr/bin:/bin:/usr/sbin
*/5 * * * * /path/to/node /path/to/deployontime/queue/reaper.mjs >> "$HOME/Library/Logs/dotime-reaper.log" 2>&1
```

Replace `/path/to/node` with what `command -v node` prints, and the second path with the place of your clone. The
`PATH` line lets the reaper find the system tools it reads (`sysctl` lives in `/usr/sbin`); it applies to every
line below it in your crontab. If you use `DOTIME_HOME`, add a `DOTIME_HOME=...` line the same way. If the clone
sits in a folder that macOS protects, such as Documents, cron may be refused access to it; a clone elsewhere in your
home folder avoids that. Notices always reach `notify.log`, also when no desktop notice shows.

To stop it, run `crontab -e` again and delete the reaper line, plus the `PATH` and `DOTIME_HOME` lines if nothing
else in your crontab needs them.

## Scheduled-job report

```
node queue/schedule-check.mjs [--dry] [--json]
```

An optional extra, separate from the queue: a health report on your own scheduled jobs. It reads every job file in
`~/Library/LaunchAgents`, not only ones made for this project, and checks each job: loaded, last exit code
accepted, scripts present, log as recent as the schedule implies. It changes no job; it only adds to its own log
files in the state folder. Problems go out as one notice;
`--dry` only prints. It exits 1 when it cannot read the job list from `launchctl`, and 2, without running, for an
option other than `--dry` and `--json` or for one of them given twice, as for an option given twice to `run`. Optional rules in
`$DOTIME_HOME/schedule-check.json`, where `skip` leaves jobs out:

```json
{ "skip": ["com.example.*"], "okExit": { "com.example.sync": [0, 2] }, "maxLogAgeH": { "com.example.weekly": 200 } }
```

A rules file that cannot be read, is not valid JSON or is not one JSON object is ignored, and the report runs
without rules. The warning goes to stderr, to the front of the notice and into the `warnings` field of the line in
`schedule-check.jsonl`. A missing file simply means no rules.

## Notices

A notice is always appended to `$DOTIME_HOME/notify.log`. It is also shown as a macOS desktop notice through
`osascript`; if none appear, look at the notification settings in System Settings. When `DOTIME_NOTIFY_CMD` is set,
the notice is also handed to that command through `/bin/sh`, with the texts in the environment variables
`DOTIME_TITLE` and `DOTIME_MESSAGE`:

```
export DOTIME_NOTIFY_CMD='printf "%s: %s\n" "$DOTIME_TITLE" "$DOTIME_MESSAGE" >> "$HOME/queue-notices.txt"'
```

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
- a number the table rules out. "Above 0": 0 is too low. "At least 1": anything under 1 is too low;
- a time in milliseconds (a key ending in `Ms`) above 2147483647, about 24 days;
- a pattern that does not compile.

An unknown name is skipped, also with one warning. A `config.json` that is not valid JSON, or that exists but cannot
be read (no permission, or a folder in its place), is ignored with one warning, and every setting keeps its
default. Only a missing file is silent.

| Key | Default | Meaning |
| --- | --- | --- |
| `slots` | 2 | Jobs that may run at once. At least 1; a fraction is rounded down. |
| `maxWaitMin` | 60 | Default for `--max-wait`. `0`: no limit. |
| `pollMs` | 3000 | How often a waiting job looks at the line and reads the health. Above 0. |
| `health.loadPerCore` | 1.0 | Gate shuts above this 1-minute load per core, while the CPU is busy now. Above 0. |
| `health.busyCpuPct` | 90 | A load above `health.loadPerCore` shuts the gate only while this percent of CPU time, or more, is in use over one second. Above 0, at most 100. |
| `health.minFreeMemPct` | 20 | Gate shuts below this free memory, in percent, as `memory_pressure` reports it. |
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

Default `reaper.serverPattern`: `vite` (but not `vite build`), `vitest`, `next dev`, `wrangler dev`,
`webpack serve`, `webpack-dev-server` and `nodemon`. A one-shot test run, such as `vitest run`, `vitest --run`,
`node --test`, `playwright test` or `jest` without `--watch`, is never taken for a dev server.

Default `reaper.keepPattern`: the regular expression `/Applications/` or `LaunchAgents`, written as one pattern with
a `|` between the two. Programs inside `/Applications/` and scripts kept in a `LaunchAgents` folder are never
stopped. To protect your own server too, add a part of its command line, for example
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

## Files in the state folder

| File | Content |
| --- | --- |
| `config.json` | Settings. Optional. |
| `slots/`, `line/` | One small file per running and per waiting job. The files of ended processes are removed by a `run` that waits in line and by the reaper (not with `--dry`); `status` leaves them. |
| `journal.jsonl` | One line per job. |
| `notices/` | Long-run and idle-slot notices, one file each. |
| `notify.log` | Every notice sent. |
| `reaper-state.json` | CPU samples between reaper runs. |
| `health.json` | The last health reading of a waiting job, with the live CPU reading when one was taken, the time the reading ended and the CPU times it ended on. Other waiting jobs reuse the reading for up to `pollMs`, and never once it is 5 seconds old; the next reading measures the CPU from the saved CPU times. |
| `schedule-check.json`, `schedule-check.jsonl` | Rules and results of the scheduled-job report. |

A file in `slots/` or `line/` is also removed when its pid now belongs to a process that started later.

Each line of `journal.jsonl` is one JSON object with `v` (the format, now 1), `label`, `project`, `projectKey`,
`cwd`, `priority`, `queuedAt`, `startedAt`, `endedAt` (times in ISO form), `waitMin`, `runMin`, `outcome`, `exit`,
`waitBy` (minutes waited per gate), `cmd`, `head` and `clean` (the commit and whether the tree was clean), `kind`,
`limitMin`, `limitBasis` and `fp` (the hash of the code, used by the repeated-failure stop). Some lines add `stem`,
`afterFix`, `signal`, `stopFailed`, `stoppedAt`, `longRunAt` or `warnedAt`. Copies of the queue that share a state
folder all read the same fields, so a field keeps its name; a new field is only ever added.

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
| `cli.mjs` | The `dotime-queue` command: reads the command line and runs `status`, `passed`, `history` or `run`. | entry point | Prints to stdout and stderr; ends the process, in one place. |
| `run.mjs` | The `run` command in steps: plan the limit, wait for a slot, run the job. | library | Starts the job wrapper, signals the job, handles INT, TERM and HUP; writes through slots, journal and notices. |
| `job-wrapper.mjs` | Starts the job in a process group of its own and ends the way the job ended. | entry point | Starts the job, signals its own process group, writes to file descriptor 3. |
| `reaper.mjs` | One reaper run: idle dev servers, stray test runs, idle slots, overload, low disk. | entry point | Stops idle dev-server groups, writes `reaper-state.json`, prunes `slots/` and `line/`. |
| `schedule-check.mjs` | The report on scheduled jobs in `~/Library/LaunchAgents`. | entry point | Reads job files, appends to `schedule-check.jsonl`. |
| `args.mjs` | The flags each command accepts, their values, and the usage text. | library | None. |
| `settings.mjs` | Defaults, `config.json`, and the file names in the state folder. | library | Reads `config.json` and the `DOTIME_` variables, when an entry point asks. |
| `slots.mjs` | Slot and waiting-line files: snapshot, join, take, release, update. | library | Reads and writes `slots/` and `line/`; runs `ps` for process ages. |
| `gate.mjs` | Who may take a free slot, what keeps a job out, when a waiting job gives up. | library | None. |
| `health.mjs` | The health gate: judges a reading, takes one, shares it for up to `pollMs` and at most 5 s. | library | Runs the health probes; reads and writes `health.json`. |
| `limits.mjs` | Run limits from the journal history. | library | None. |
| `kinds.mjs` | Job kinds and command stems. | library | None. |
| `failstop.mjs` | The stop for a check that failed twice on unchanged code. | library | None. |
| `fingerprint.mjs` | A short hash of the code under test. | library | Runs read-only git commands, reads files in the working tree. |
| `journal.mjs` | Journal lines, pass stamps and `history` totals. | library | Reads and appends `journal.jsonl`. |
| `notices.mjs` | Long-run and idle-slot notices and the notices store. | library | Writes `notices/`; runs `ps` for CPU samples. |
| `notify.mjs` | Sends a notice: log line, desktop notice, `DOTIME_NOTIFY_CMD`. | library | Appends `notify.log`, runs `osascript` and the notify command. |
| `idle.mjs` | Idle verdicts from CPU samples; the dev-server test. | library | None. |
| `stray.mjs` | Finds large test runs outside the queue. | library | None. |
| `commands.mjs` | The test, shell and launcher command patterns, each with its reason. | library | None. |
| `git.mjs` | The queue's git calls, read-only and with time limits. | library | Runs `git`. |
| `project.mjs` | The project of a job: label prefix, repository name or folder name. | library | Runs `git` through `git.mjs`. |
| `probes.mjs` | Readings from macOS tools, one function each. | library | Runs `ps`, `memory_pressure`, `df`, `sysctl`, `pmset`, `osascript`, `launchctl`, `plutil`. |
| `ps.mjs` | Parsers for `ps` output. | library | None. |
| `proctree.mjs` | Process trees: descendants, ancestors, a job's pids and CPU; group signals and stops. | library | Sends signals; runs `ps` when no listing is given. |
| `files.mjs` | JSON read with warnings, atomic JSON write, append with folder. | library | Reads and writes the files it is handed. |
| `timer.mjs` | Timers longer than one Node timer can hold, and a sleep that can be ended early. | library | Sets timers. |
| `clock.mjs` | Clock times, days and zone offsets. | library | None. |
| `stats.mjs` | The percentile that limits and `history` share. | library | None. |
| `units.mjs` | Time units and rounding. | library | None. |
| `testkit.mjs` | Test helpers: temp folders, started processes, isolated git and state folder, stored notices. | test helper | Creates and removes temp folders, signals processes the tests started. |

## Tests

From the repository's top folder:

```
npm test                         # everything (the same as node --test)
node --test queue/slots.test.mjs # one file
```

The code has no switch for the tests. A test that needs a made-up health reading, or a clock that jumps ahead, runs
the steps of `run` inside the test process and hands them stand-ins for the clock, the health reading and the
signals (see `queue/run.test.mjs`). Every test file gets a state folder of its own inside the temp folder.
