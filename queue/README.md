# dotime-queue

One queue for the heavy jobs on a computer that several coding agents use at the same time: test suites, builds,
end-to-end runs.

What it does for every job:

1. **Line.** Jobs queue up first come, first served. Only a set number hold a slot at the same time (2 by
   default).
2. **Gate.** The first in line starts only when a slot is free and the computer has room: load, free memory, free
   disk, battery.
3. **Limit.** The job runs under a time limit. At the limit, the job and everything it started are stopped.
4. **Journal.** Each run leaves a record of its wait, its run time and its result. Later runs use that record.

Requirements: macOS, Node 20 or newer, git 2.31 or newer. Nothing to install besides this folder.

## Quick start

```
node queue/cli.mjs run --label "shop-api: unit tests" -- npm test
node queue/cli.mjs status
```

The package also exposes the command as `dotime-queue` once `npm link` in the repository's top folder puts it on your path; the
examples below use that name.

## Commands

### `run`

```
dotime-queue run --label "<project>: <task>" [options] -- <command> [args]
```

Waits for a slot, runs the command with its input and output passed through (in a process group of its own, so
without a controlling terminal), and exits with the command's exit code.

| Option | Effect |
| --- | --- |
| `--label "<project>: <task>"` | Names the job. The text in front of the colon is its project. Without a label the job is called `unnamed`. |
| `--max-wait <min>` | Leaves the line after this many minutes with exit 75. `0` waits without limit. Default: the `maxWaitMin` setting. |
| `--max-run <min>` | Sets the run limit for this job. |
| `--kind <name>` | Sets the job kind in place of the guessed one. |
| `--after-fix "<note>"` | Runs a check that would be refused for failing twice on unchanged code. The note is stored in the journal. |
| `--priority` | Joins the line at the front. Slots and the health gate still apply. |

Options go in front of the `--`. Everything behind it is the job's command.

While it waits, `run` prints its position and what holds it, at each change of position and at least once a minute.

Signals: before the job has started, Ctrl-C or TERM takes it out of the line and `run` exits 130. While the job runs, INT, TERM and HUP are passed
on to the whole job, and the run is journalled as `stopped`, which is neither a pass nor a failure. A stop signal
(HUP, INT, KILL or TERM) that the queue did not send is journalled as `stopped` as well, for example when the system ends a job because memory ran
out, so it does not count towards the repeated-failure stop. Exit status 128 plus a stop signal's number counts the
same way, because that is how a shell script reports a child it lost to that signal. Any other signal that ends a job counts as a failure. If the queue process itself dies, the job notices within `limits.orphanCheckMs` and stops.

### `status`

```
dotime-queue status
```

Prints the taken slots, each running job with its limit and time left, the waiting jobs in start order, and whether
the gate is open.

### `passed`

```
dotime-queue passed [--match <text>] [--cwd <dir>]
```

Answers "did this check already pass on exactly this code?". It looks only at runs that began with a clean tree on
the commit the folder is at now, and skips runs that were stopped or timed out, since those say nothing about the code.
If the newest of what is left exited 0, it prints a `stamp:` line and exits 0. In every other case it prints a
`no stamp:` line that says why and exits 1. `--match` keeps only runs whose label or command contains the text, in any letter case.
`--cwd` asks about another folder.

A stamp needs a clean working tree, both now and when the run started. One exception: an untracked entry named
`node_modules` that is not a folder (in practice a symlink) does not make the tree dirty. Git's usual `node_modules/`
ignore rule matches folders only, so such a link is listed by `git status` even though it is not source code.

### `history`

```
dotime-queue history [--days <n> | --day <YYYY-MM-DD>]
```

Sums up the journal: one row for all projects and one per project, with outcome counts, waiting time (summed per
job, and as time on the clock) and the gates that caused the waiting. `--days` covers the last n calendar days
including today (default 7); `--day` covers one day. Days are counted in the `DOTIME_TZ` zone.

## Projects and kinds

The project of a job is the label text in front of the colon, when that text is 40 characters or fewer. Without that, it is the name of the git repository the
job runs in (a linked worktree counts as its main repository), and outside git the name of the folder.

The kind groups similar jobs for the run limit. It is read from the label's task part (the text after the project
prefix) and, only when that matches nothing, from the command. In each, it is the first match in this list:

| Kind | Words |
| --- | --- |
| `debug` | `debug`, `repro`, `bisect`, `probe` (in the command not followed by `=`, so `DEBUG=1` does not count), or a question mark in the label |
| `deploy` | `deploy`, `release`, `publish` |
| `test` | `test`, `tests`, `check`, `suite`, `spec`, `e2e`, `vitest`, `jest`, `playwright`, `node --test` |
| `build` | `build`, `bundle`, `compile` |
| `lint` | `lint`, `typecheck`, `tsc`, `format` |
| `other` | anything else |

## Run limits

History decides the limit when `--max-run` is absent. Only runs that passed count, taken from the job's own project
and at most `limits.windowDays` days old:

- With at least `limits.minSamples` runs of the same command: `limits.p90Factor` times their 90th percentile.
- Otherwise, with that many runs of the same kind: the same formula over those runs.
- Otherwise: `limits.defaultMin`.

In the last two cases, a command with a few passed runs of its own raises the limit to `limits.p90Factor` times the
longest of them, when that is more. A measured limit is never below `limits.floorMin`. A `debug` job gets
`limits.debugMin` instead (still only when `--max-run` is absent).

Two commands count as the same when they have the same stem: the program and its task, without paths, flags and
variable assignments (`npm run build -- --watch` and `npm run build` share the stem `npm run build`).

A job that reaches its limit ends `run` with exit 124. Before that, its whole process group receives TERM and,
`limits.killGraceMs` later, KILL. With `--priority` the stop moves out to `limits.priorityGrace` times the limit,
and reaching the limit itself only prints a warning.

A job that runs past its long-run mark gets one notice and keeps running. The mark is `limits.longRunFactor` times
the 75th percentile of the same runs (at least `limits.floorMin`), or `limits.longRunUnmeasuredMin` when there are
fewer than `limits.minSamples` of them. A command with a few passed runs of its own raises the mark to `limits.longRunFactor` times their 75th
percentile, when that is more. No notice is sent when the mark is not earlier than the stop.

## Repeated failures

When the same check failed twice in a row within `limits.failWindowHours`, and neither the commit nor the
uncommitted and untracked files have changed since, a third run is refused with exit 3. Change the code, or pass
`--after-fix "<note>"`. Runs that were stopped by a signal do not count. Earlier runs belong to a check when they
carry its label; runs under another label still belong when command, project and folder are all identical.

What is compared between the failures and the new run:

- the commit;
- uncommitted changes to tracked files, wherever they are, and the list of changed and untracked paths as
  `git status` prints it;
- the content of untracked files that git does not ignore, up to 2000 files. A file above 1 MB, or one that would
  take the total past 32 MB, counts by its size and modification time;
- files the job's command mentions by path: their content, when they are smaller than 4 MB.

Two groups of untracked files are skipped, because a check rewrites them itself: files inside a folder named in
`outputDirs`, at any depth, and files ending in `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.ico`, `.bmp`,
`.mp4`, `.webm`, `.mov`, `.pdf`, `.zip`, `.gz`, `.tgz` or `.log`. Tracked files are never skipped.

## Exit codes

| Code | Meaning |
| --- | --- |
| the job's own | The job ran and ended by itself. A job ended by a signal gives 1, except for SIGUSR1 and signals Node does not die by (such as SIGPIPE): 128 plus the signal's number. |
| 2 | The command line was not understood. |
| 3 | Refused: the same check failed twice on unchanged code. |
| 75 | Gave up waiting after `--max-wait`. |
| 124 | Stopped at the run limit. |
| 127 | The job's command could not be started. |
| 130 | Left the line because of a signal. |

`passed` exits 0 with a stamp and 1 without. `schedule-check.mjs` exits 1 when it cannot read the job list.

## Message format

Every message has the same shape: clauses separated by `; `, each clause a topic, a colon, and facts separated by
commas. Durations are written as `12 min`, percentages as `20%`, sizes as `40 GB`, clock times on a 24-hour clock
with the zone name.

```
dotime-queue: in line: position 2, 3 min waited, wait limit 60 min; no free slot: 2 of 2 taken, by "shop-api: unit tests" and "docs-site: build"
dotime-queue: gave up: exit 75, position 1, 60 min waited; memory too low: 9% free, 20% needed; hint: --max-wait 0 waits without limit
stamp: commit 0a1b2c3d, passed 4 min ago by "shop-api: unit tests", command npm test, run time 2.5 min, tree clean at start, finished <YYYY-MM-DD HH:MM> UTC
```

A reading the computer cannot give (no battery, a tool that fails) never shuts the gate. A reading of 0, such as a
full disk, does.

## Reaper

```
node queue/reaper.mjs          # from a scheduler, every few minutes
node queue/reaper.mjs --dry    # print what a run would do, change nothing
```

Each run:

- stops dev-server process groups that are older than `idle.serverIdleMin` minutes and used less than
  `idle.serverCpuS` seconds of CPU in that time (TERM, then KILL);
- sends one notice for a job that used less than `idle.slotCpuS` seconds of CPU in `idle.slotIdleMin` minutes while
  holding a slot;
- reports large test runs that were not started through the queue, at most one notice an hour;
- reports an overloaded computer when two runs in a row see it, at most once an hour;
- reports low disk space, at most every six hours.

Only idle dev servers are ever stopped. A dev server is a process whose command matches `reaper.serverPattern`. The
reaper stops the server's whole process group, so it does so only when that group holds nothing else: the server,
the processes it started, and the processes above it that are package-script launchers (`npm`, `npx`, `pnpm`, `yarn`,
`bun`, or the script `node` runs for one of them, and `sh -c`, `bash -c`, `zsh -c`) or name a dev server themselves. The server is the innermost matching process, so a launcher that
names the server is never taken for it. An idle server that shares its group with another program is reported and
left running. A group is never stopped when it
holds a slot, runs a one-shot test command, matches `reaper.keepPattern`, or is the
reaper's own. A test run counts as started through the queue when it descends from a process that holds a slot.

## Scheduled-job report

```
node queue/schedule-check.mjs [--dry] [--json]
```

Reads the job files in `~/Library/LaunchAgents` and checks each job: loaded, last exit code accepted, scripts
present, log as recent as the schedule implies. It changes nothing. Problems go out as one notice; `--dry` only
prints. Optional rules in `$DOTIME_HOME/schedule-check.json`:

```json
{ "skip": ["com.example.*"], "okExit": { "com.example.sync": [0, 2] }, "maxLogAgeH": { "com.example.weekly": 200 } }
```

## Notices

A notice is always appended to `$DOTIME_HOME/notify.log`. It is also shown as a desktop notice and, when
`DOTIME_NOTIFY_CMD` is set, handed to that command through `/bin/sh`, with the texts in the environment variables
`DOTIME_TITLE` and `DOTIME_MESSAGE`:

```
export DOTIME_NOTIFY_CMD='printf "%s: %s\n" "$DOTIME_TITLE" "$DOTIME_MESSAGE" >> "$HOME/queue-notices.txt"'
```

`DOTIME_NOTIFY=log` keeps only the log line. Long-run and idle-slot notices are also stored in
`$DOTIME_HOME/notices.json`, one entry per job, as a record you can look through.

## Settings

Settings live in `$DOTIME_HOME/config.json`. That one file applies to every caller on the computer, and environment
variables cannot change a setting. A caller can still ask for more for one job through the flags of `run`
(`--max-run`, `--priority`, `--after-fix`, described above), and `DOTIME_HOME` points to a whole other state folder
with its own settings and its own slots.

```json
{ "slots": 3, "health": { "minFreeDiskGB": 25 }, "idle": { "serverIdleMin": 45 } }
```

A value that does not fit is replaced by its default, with one warning on stderr: a wrong type, a negative number,
a number the table rules out ("Above 0": 0 is too low; "At least 1": anything under 1 is too low), a time in
milliseconds (a key ending in `Ms`) above 2147483647, about 24 days, or a pattern that does not compile. An unknown name is skipped, also with one warning.

| Key | Default | Meaning |
| --- | --- | --- |
| `slots` | 2 | Jobs that may run at once. At least 1; a fraction is rounded down. |
| `maxWaitMin` | 60 | Default for `--max-wait`. `0`: no limit. |
| `pollMs` | 3000 | How often a waiting job looks at the line. Above 0. |
| `health.loadPerCore` | 1.0 | Gate shuts above this 1-minute load per core. Above 0. |
| `health.minFreeMemPct` | 20 | Gate shuts below this free memory. |
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
| `reaper.keepPattern` | `/Applications/\|LaunchAgents` | Regular expression for commands the reaper never stops: by default, programs inside `/Applications/` and scripts kept in a `LaunchAgents` folder. |
| `outputDirs` | see below | Folder names whose untracked files are left out when code is compared between failed runs. |

Default `reaper.serverPattern`: `vite`, `vitest` in watch mode, `next dev`, `wrangler dev`, `webpack serve`,
`webpack-dev-server` and `nodemon`.

Default `outputDirs`: `node_modules`, `dist`, `build`, `out`, `coverage`, `.cache`, `.next`, `.turbo`, `.wrangler`,
`.vercel`, `test-results`, `playwright-report`.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOTIME_HOME` | `~/.dotime` | The state folder. Callers share a queue only when they use the same folder. |
| `DOTIME_TZ` | `UTC` | Time zone for printed times and for calendar days. |
| `DOTIME_NOTIFY` | not set | `log`: notices go to the log file only. |
| `DOTIME_NOTIFY_CMD` | not set | Shell command that receives each notice. |

## Files in the state folder

| File | Content |
| --- | --- |
| `config.json` | Settings. |
| `slots/`, `line/` | One small file per running and per waiting job. A file whose process has ended, or whose pid now belongs to a process that started later, is removed. |
| `journal.jsonl` | One line per job. |
| `notices.json` | Long-run and idle-slot notices. |
| `notify.log` | Every notice sent. |
| `reaper-state.json` | CPU samples between reaper runs. |
| `schedule-check.json`, `schedule-check.jsonl` | Rules and results of the scheduled-job report. |

The journal and the logs are only ever added to; nothing trims them. Delete or move them when they grow too large: the
queue starts new ones. The run limits, the stamps and the repeated-failure stop then start again from no history.

These files stay on the computer, but they hold working folders, full command lines, job labels and the labels and
log paths of scheduled jobs. Keep that in mind before sharing them, and when `DOTIME_NOTIFY_CMD` forwards notices to
another service.

## Tests

```
node --test                      # everything
node --test queue/slots.test.mjs # one file
```

The tests use two switches that exist only for them: `DOTIME_FAKE_HEALTH` (a health reading as JSON) and
`DOTIME_FAKE_CLOCK` (path of a file whose number stands in for the minutes passed since a job started). Both are honoured only when the real path of
`DOTIME_HOME` is inside the real path of `os.tmpdir()`. With any other state folder they are ignored.
