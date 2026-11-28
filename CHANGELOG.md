# Changelog

What changed in each release of the `deployontime` package (`dotime-queue` and `dotime-mcp`). The full manual is
[queue/README.md](queue/README.md).

## Unreleased

- **The macOS tick fires on the minute.** The LaunchAgent uses an empty `StartCalendarInterval` instead of
  `StartInterval` 60, so it runs at the start of every minute as cron and the systemd timer do, does not drift, and
  runs once on wake for the minutes the Mac slept through. Run `dotime-queue schedule install` again to switch a tick
  installed by an older version.
- **A clock change on Linux no longer makes a live job look gone.** `ps` there counts a process's age from the boot,
  so after the wall clock was set, a job that had claimed a slot but not yet started its command could lose its slot
  to another job. Slot, line, nested-run and place files, the schedule lock, the tick's last run and the MCP runner
  now also keep the process start in clock ticks since boot, which the clock cannot move; macOS and files written by
  an older version are judged as before.
- A slot or lock file that names pid 0 or 1, or a pid that is no number, no longer holds its slot for ever: it is
  freed like the file of a holder that is gone. `queue/schedule-check.mjs` gives a job whose calendar entry sets
  neither `Minute` nor `Hour`, which fires every minute, the half-hour log age limit instead of three hours.

## 0.3.2

- **No missed due time is dropped without a word** ([#36](https://github.com/Moezat220/deployontime/pull/36)). When
  the schedule tick comes back after a gap, every due time before the newest is now counted as missed: before, due
  times from the last 2 minutes other than the newest were neither started nor reported. A single late due time just
  starts, and is no longer also reported as missed. Found by a real launchd test on macOS.
- Everything in 0.3.1, which was tagged but not published to npm.

## 0.3.1 (tagged, not published)

- **CPU-aware slots** ([#31](https://github.com/Moezat220/deployontime/pull/31)). The base `slots` (2) always stay.
  On a computer with more than 5 cores, a job may take an extra slot, up to half the cores, but only while the live
  CPU reading is below `extraSlotCpuPct` (60) and no job started in the last `extraSlotSettleSec` (5 s). The health
  gate applies to every job. A `slots` count you set yourself always wins: without `maxSlots` it means no extra slots.
  A computer with up to 5 cores behaves as before. `dotime-queue status` and `queue_status` show the effective count
  and why. The decision lives in `queue/capacity.mjs`. New settings: `maxSlots`, `extraSlotCpuPct`,
  `extraSlotSettleSec`.
- **Failure reasons** ([#32](https://github.com/Moezat220/deployontime/pull/32),
  [#33](https://github.com/Moezat220/deployontime/pull/33)). A failed run's journal line gets a reason class (port,
  network, disk, files, memory, test, build, run-limit, signal or unknown), read back from the file its output
  went to. Only a fixed token such as `EADDRINUSE` is stored, never output text; the job's own output is untouched.
  New command `dotime-queue reasons [--days N] [--json]`, and `queue_job` carries `reason`. Nothing is retried: this
  only measures.
- **Cut-off runs are recorded as lost** ([#34](https://github.com/Moezat220/deployontime/pull/34)). A run cut off by
  a restart or a dead queue process gets one `lost` journal line instead of vanishing, and its slot is freed safely.
  `lost` never counts for fail-stop, flaky checks or run limits. `history` shows `lost N`. MCP tasks of such a run end
  failed with a plain message; the new `queue_run` argument `rerunIfLost` starts one lost job again, once.
- **Full-disk notice** ([#30](https://github.com/Moezat220/deployontime/pull/30)). When the schedule tick cannot save
  even its notes file, its notice goes out once an hour instead of not at all.

## 0.3.0

- Isolated runs: `run --isolate`, `integrate`, `discard` and `worktrees`
  ([#27](https://github.com/Moezat220/deployontime/pull/27)).
- Scheduled jobs: `dotime-queue schedule` with one system entry that runs the tick every minute
  ([#28](https://github.com/Moezat220/deployontime/pull/28)); the entry names a `node` that survives an upgrade
  ([#29](https://github.com/Moezat220/deployontime/pull/29)).

## 0.2.0

- Flaky checks flagged from the journal, and `dotime-queue flaky`
  ([#23](https://github.com/Moezat220/deployontime/pull/23)).
- MCP tasks: long-job results without polling, and a done notice
  ([#24](https://github.com/Moezat220/deployontime/pull/24)).
- The website deployontime.com as the package homepage ([#25](https://github.com/Moezat220/deployontime/pull/25)).

## 0.1.1

- Listed in the MCP Registry ([#20](https://github.com/Moezat220/deployontime/pull/20)), and a hint on what to do
  when low memory or disk holds a job ([#21](https://github.com/Moezat220/deployontime/pull/21)).

## 0.1.0

- The first release: the machine queue `dotime-queue` and the MCP server `dotime-mcp`.
