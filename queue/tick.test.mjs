// The schedule tick. Most tests drive it in this process with a clock that moves only when the test moves it and a
// stand-in for starting a run; the last ones start real runs of the real cli.mjs through the real `run` path, with
// the tick's clock still moved by hand, and read the journal and `history` they leave.
import { cleanEnv, git as testGit, isolateProcess, makeRepo, tempDir, track, until } from "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

isolateProcess("tick");
const { GRACE_MS, NO_PID_MS, noticeBook, planTick, runTick, SCHEDULED_MARKER, startRun, stillGoing, tickRow } = await import("./tick.mjs");
// A run may be writing its journal line while a test reads, so a line that does not parse yet is left out, as the
// journal reader does.
const parse = (line) => { try { return [JSON.parse(line)]; } catch { return []; } };
const { summarize } = await import("./journal.mjs");
const { zoneWall } = await import("./cron.mjs");
const { readSchedule, writeSchedule } = await import("./timetable.mjs");
const { readJson } = await import("./files.mjs");
const { paths } = await import("./settings.mjs");
const { cmdSchedule } = await import("./schedule.mjs");
const { historyLines, scheduleDeps } = await import("./cli.mjs");
const { BORN, processGone } = await import("./slots.mjs");

const MINUTE = 60_000, NODE = process.execPath;
const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const UTC = zoneWall("UTC");
const T0 = Date.UTC(2031, 4, 6, 10, 0);
const iso = (ms) => new Date(ms).toISOString();
const WIDE_OPEN = { loadPerCore: 1000, minFreeMemPct: 0, minFreeDiskGB: 0, minBatteryPct: 0 };

const job = (more = {}) => ({
    id: "0a1b2c3d", label: "shop-api: lint", cwd: tempDir("tick-work"), command: ["npm", "run", "lint"], every: "1m",
    enabled: true, createdAt: iso(T0), ...more,
});

/** A state folder with the given jobs, a clock, a stand-in spawn and every message, notice and start kept. */
function bench(jobs, { live = new Set() } = {}) {
    const files = paths({ DOTIME_HOME: tempDir("tick-home") });
    writeSchedule(files.schedule, jobs);
    const seen = { starts: [], printed: [], said: [], notices: [] };
    let nextPid = 5001;
    const clock = { now: T0 };
    const deps = {
        now: () => clock.now, wall: UTC, zone: "UTC", uid: process.getuid(), owner: { pid: process.pid, born: BORN },
        isGone: (owner) => owner.pid !== process.pid && !live.has(owner.pid),
        spawn: (program, words, options) => {
            const pid = nextPid++;
            seen.starts.push({ program, words, options, pid });
            return { pid, on() {}, unref() {} };
        },
        env: { PATH: "/usr/bin:/bin", DOTIME_HOME: files.home, DOTIME_JOB: "slot-0", DOTIME_PARENT: "slot-0", DOTIME_NO_SKIP: "1" },
        node: "/opt/node/bin/node", cli: "/opt/deployontime/queue/cli.mjs",
        notify: (title, message) => seen.notices.push([title, message]),
        print: (line) => seen.printed.push(line), say: (line) => seen.said.push(line),
    };
    const journal = () => (existsSync(files.journal) ? readFileSync(files.journal, "utf8").trim().split("\n").flatMap(parse) : []);
    const tick = (at) => { clock.now = at; return runTick(files, deps); };
    return { files, seen, deps, clock, journal, tick, stored: () => readSchedule(files.schedule).jobs, live };
}

test("planTick: nothing before the first due time, the newest due time once one is due, and missed times older than 2 min", () => {
    const j = job();
    assert.equal(planTick(j, T0 + 59_000, UTC), null);
    assert.deepEqual(planTick(j, T0 + MINUTE, UTC), { due: T0 + MINUTE, missed: null });
    assert.deepEqual(planTick(j, T0 + MINUTE + GRACE_MS, UTC), { due: T0 + 3 * MINUTE, missed: null }, "a due time just 2 min old is on time");
    const late = planTick(j, T0 + 10 * MINUTE, UTC);
    assert.deepEqual([late.due, late.missed], [T0 + 10 * MINUTE, { count: 7, oldest: T0 + MINUTE, newest: T0 + 7 * MINUTE }]);
    assert.equal(planTick({ ...j, lastDue: iso(T0 + 10 * MINUTE) }, T0 + 10 * MINUTE + 30_000, UTC), null, "due times count from lastDue");
    assert.equal(planTick({ ...j, enabled: false }, T0 + 10 * MINUTE, UTC), null);
    const nightly = job({ every: undefined, cron: "0 2 * * *" });
    assert.equal(planTick(nightly, Date.UTC(2031, 4, 7, 1, 59), UTC), null);
    assert.deepEqual(planTick(nightly, Date.UTC(2031, 4, 7, 2, 0, 40), UTC), { due: Date.UTC(2031, 4, 7, 2, 0), missed: null });
});

test("stillGoing: only the pid of the last start counts, and only while it is the same process", () => {
    assert.equal(stillGoing(job(), () => false), false, "never started");
    assert.equal(stillGoing(job({ lastPid: 5001, lastBorn: T0 }), () => false), true);
    assert.equal(stillGoing(job({ lastPid: 5001, lastBorn: T0 }), () => true), false);
    const asked = [];
    stillGoing(job({ lastPid: 5001, lastBorn: T0 }), (owner) => asked.push(owner));
    assert.deepEqual(asked, [{ pid: 5001, born: T0 }]);
    assert.equal(processGone({ pid: process.pid, born: BORN }), false, "this process, checked the way the slots are");
    assert.equal(processGone({ pid: process.pid, born: BORN - 3_600_000 }), true, "the same pid with another start time");
});

test("tick: nothing due prints nothing, starts nothing, writes nothing and exits 0", () => {
    const b = bench([job()]);
    const before = readFileSync(b.files.schedule, "utf8");
    assert.equal(b.tick(T0 + 30_000), 0);
    assert.deepEqual(b.seen, { starts: [], printed: [], said: [], notices: [] });
    assert.equal(readFileSync(b.files.schedule, "utf8"), before);
    assert.deepEqual(b.journal(), []);
    assert.equal(existsSync(b.files.scheduleLock), false, "the lock is freed");
});

test("tick: a due job starts exactly once, as dotime-queue run in its folder, with DOTIME_SCHEDULED and no job markers", () => {
    const j = job({ isolate: true, label: "--odd: label" });
    const b = bench([j]);
    assert.equal(b.tick(T0 + MINUTE + 5000), 0);
    assert.equal(b.seen.starts.length, 1);
    const [start] = b.seen.starts;
    assert.equal(start.program, "/opt/node/bin/node");
    assert.deepEqual(start.words, ["/opt/deployontime/queue/cli.mjs", "run", "--label=--odd: label", "--isolate", "--", "npm", "run", "lint"]);
    assert.equal(start.options.cwd, j.cwd);
    assert.equal(start.options.detached, true);
    assert.equal(start.options.env[SCHEDULED_MARKER], "0a1b2c3d");
    assert.deepEqual(["DOTIME_JOB", "DOTIME_PARENT", "DOTIME_NO_SKIP"].filter((k) => k in start.options.env), []);
    assert.equal(start.options.env.PATH, "/usr/bin:/bin");
    assert.deepEqual(b.seen.printed, ['schedule tick: started 0a1b2c3d "--odd: label", pid 5001, due 2031-05-06 10:01 UTC']);
    const [stored] = b.stored();
    assert.deepEqual([stored.lastDue, stored.lastStart, stored.lastPid, stored.lastBorn],
        [iso(T0 + MINUTE), iso(T0 + MINUTE + 5000), 5001, T0 + MINUTE + 5000]);
    assert.equal(existsSync(join(b.files.scheduleRuns, "0a1b2c3d.log")), true, "the run's output goes to its own log");
    assert.equal(b.tick(T0 + MINUTE + 40_000), 0);
    assert.equal(b.seen.starts.length, 1, "the same due time never starts twice");
    assert.deepEqual(b.journal(), [], "the run writes its own journal line; the tick none");
});

test("tick: a disabled job is never started, also long after its due times", () => {
    const b = bench([job({ enabled: false })]);
    assert.equal(b.tick(T0 + 90 * MINUTE), 0);
    assert.deepEqual(b.seen, { starts: [], printed: [], said: [], notices: [] });
    assert.deepEqual(b.journal(), []);
});

test("tick: after a gap, one missed line, one notice and one catch-up run, never a burst", () => {
    const b = bench([job()]);
    assert.equal(b.tick(T0 + 90 * MINUTE + 10_000), 0);
    assert.equal(b.seen.starts.length, 1);
    const rows = b.journal();
    assert.equal(rows.length, 1);
    const [missed] = rows;
    assert.deepEqual([missed.outcome, missed.scheduled, missed.missed, missed.missedFrom, missed.missedTo, missed.exit],
        ["missed", "0a1b2c3d", 88, iso(T0 + MINUTE), iso(T0 + 88 * MINUTE), null]);
    assert.deepEqual([missed.label, missed.cmd, missed.startedAt, missed.runMin], ["shop-api: lint", "npm run lint", null, 0]);
    assert.deepEqual(b.seen.notices, [["dotime: missed shop-api: lint", "88 runs missed while the tick did not run; running once now"]]);
    assert.deepEqual(b.seen.printed, [
        'schedule tick: missed 0a1b2c3d "shop-api: lint", 88 runs, from 2031-05-06 10:01 UTC to 2031-05-06 11:28 UTC',
        'schedule tick: started 0a1b2c3d "shop-api: lint", pid 5001, due 2031-05-06 11:30 UTC',
    ]);
    assert.equal(b.stored()[0].lastDue, iso(T0 + 90 * MINUTE));
    b.tick(T0 + 91 * MINUTE + 5000);
    assert.deepEqual([b.seen.starts.length, b.journal().length, b.seen.notices.length], [2, 1, 1], "then the normal cadence");
});

test("tick: a gap with one due time only is reported as one run missed", () => {
    const b = bench([job({ every: "1h" })]);
    b.tick(T0 + 65 * MINUTE);
    assert.deepEqual(b.seen.notices, [["dotime: missed shop-api: lint", "1 run missed while the tick did not run; running once now"]]);
    assert.equal(b.journal()[0].missed, 1);
    assert.equal(b.seen.starts.length, 1);
});

test("tick: while the last run still waits or runs, no second start; one busy line per due time, then a start once it ended", () => {
    const b = bench([job()], { live: new Set([5001]) });
    b.tick(T0 + MINUTE);
    b.tick(T0 + 2 * MINUTE);
    b.tick(T0 + 2 * MINUTE + 30_000);
    b.tick(T0 + 3 * MINUTE);
    assert.equal(b.seen.starts.length, 1);
    const busy = b.journal();
    assert.deepEqual(busy.map((r) => [r.outcome, r.scheduled, r.busyPid, r.queuedAt]), [
        ["busy", "0a1b2c3d", 5001, iso(T0 + 2 * MINUTE)], ["busy", "0a1b2c3d", 5001, iso(T0 + 3 * MINUTE)],
    ]);
    assert.equal(b.seen.printed[1], 'schedule tick: busy 0a1b2c3d "shop-api: lint", not started; the last run, pid 5001, still waits or runs');
    b.live.clear();
    b.tick(T0 + 4 * MINUTE);
    assert.equal(b.seen.starts.length, 2);
    assert.equal(b.journal().length, 2);
});

test("tick: a gap while the last run still goes is reported, and nothing starts", () => {
    const b = bench([job({ lastPid: 5000, lastBorn: T0 })], { live: new Set([5000]) });
    b.tick(T0 + 10 * MINUTE);
    assert.deepEqual(b.journal().map((r) => r.outcome), ["missed", "busy"]);
    assert.deepEqual(b.seen.notices, [
        ["dotime: missed shop-api: lint", "7 runs missed while the tick did not run; not started now: the last run is still going"],
    ]);
    assert.equal(b.seen.starts.length, 0);
});

const failing = (code) => () => { throw Object.assign(new Error(`${code}: cannot write`), { code }); };

test("tick: when schedule.json cannot be saved, nothing starts, one notice is sent, and each tick exits 1", () => {
    const b = bench([job()]);
    b.deps.writeSchedule = failing("ENOSPC");
    for (let m = 1; m <= 5; m++) assert.equal(b.tick(T0 + m * MINUTE + 5000), 1, `tick ${m}`);
    assert.equal(b.seen.starts.length, 0, "the due time could not be saved, so it is not started");
    assert.deepEqual(b.journal(), [], "and no missed line every minute");
    assert.deepEqual(b.seen.notices, [
        ["dotime: schedule tick stopped", `${b.files.schedule} could not be saved (ENOSPC); no scheduled job starts until it can`],
    ]);
    assert.equal(b.seen.said.length, 5);
    assert.equal(b.seen.said[0], `schedule tick: ${b.files.schedule} could not be saved (ENOSPC); nothing was started`);
    assert.equal(b.stored()[0].lastDue, undefined);
    delete b.deps.writeSchedule;
    assert.equal(b.tick(T0 + 6 * MINUTE + 5000), 0);
    assert.equal(b.seen.starts.length, 1, "once it can save again: one missed line and one catch-up run");
    assert.deepEqual(b.journal().map((r) => [r.outcome, r.missed]), [["missed", 4]]);
    assert.equal(readJson(b.files.tickNotes).save, undefined, "the problem is forgotten once it is gone");
    b.deps.writeSchedule = failing("ENOSPC");
    b.tick(T0 + 7 * MINUTE + 5000);
    assert.equal(b.seen.notices.at(-1)[0], "dotime: schedule tick stopped", "so a new failure is told again");
});

test("tick: a run whose pid could not be saved counts as going until its journal line comes", () => {
    const b = bench([job()]);
    let writes = 0;
    b.deps.writeSchedule = (file, jobs) => { if (++writes === 2) failing("EACCES")(); writeSchedule(file, jobs); };
    assert.equal(b.tick(T0 + MINUTE), 0);
    assert.equal(b.seen.starts.length, 1);
    assert.match(b.seen.said[0], /^schedule tick: .*schedule\.json could not be saved after the start of 0a1b2c3d "shop-api: lint" \(EACCES\); /);
    const [stored] = b.stored();
    assert.deepEqual([stored.lastDue, stored.lastStart, stored.lastPid], [iso(T0 + MINUTE), iso(T0 + MINUTE), undefined]);
    assert.equal(b.tick(T0 + 2 * MINUTE), 0);
    assert.equal(b.seen.starts.length, 1, "no second start");
    assert.deepEqual(b.journal().map((r) => [r.outcome, r.busyPid]), [["busy", undefined]]);
    assert.equal(b.seen.printed.at(-1),
        'schedule tick: busy 0a1b2c3d "shop-api: lint", not started; the last run, whose pid was not saved, still waits or runs');
    const ended = { v: 1, label: "shop-api: lint", scheduled: "0a1b2c3d", queuedAt: iso(T0 + MINUTE + 1000), outcome: "ran", exit: 0 };
    appendFileSync(b.files.journal, `${JSON.stringify(ended)}\n`);
    assert.equal(b.tick(T0 + 3 * MINUTE), 0);
    assert.equal(b.seen.starts.length, 2, "its journal line came, so it ended");
    const lost = { ...job(), lastStart: iso(T0) };
    assert.equal(stillGoing(lost, () => true, T0 + NO_PID_MS - 1), true);
    assert.equal(stillGoing(lost, () => true, T0 + NO_PID_MS), false, "at most a day");
});

test("tick: a schedule.json another user owns, or the group or others may write, runs nothing; one notice names the fix", () => {
    const b = bench([job()]);
    chmodSync(b.files.schedule, 0o664);
    const fix = `${b.files.schedule} may be written by its group; chmod 600 ${b.files.schedule} fixes it`;
    assert.equal(b.tick(T0 + MINUTE), 1);
    assert.equal(b.tick(T0 + 2 * MINUTE), 1);
    assert.equal(b.seen.starts.length, 0);
    assert.deepEqual(b.seen.said, [`schedule tick: nothing runs; ${fix}`, `schedule tick: nothing runs; ${fix}`]);
    assert.deepEqual(b.seen.notices, [["dotime: schedule not run", fix]]);
    chmodSync(b.files.schedule, 0o600);
    assert.equal(b.tick(T0 + 3 * MINUTE), 0);
    assert.equal(b.seen.starts.length, 1);
    assert.equal(runTick(b.files, { ...b.deps, uid: process.getuid() + 1, now: () => T0 + 4 * MINUTE }), 1);
    assert.match(b.seen.said.at(-1), /^schedule tick: nothing runs; .*schedule\.json belongs to user \d+, not to you/);
    assert.equal(b.seen.starts.length, 1);
    assert.equal(statSync(b.files.tickNotes).mode & 0o777, 0o600);
});

test("tick: a broken schedule.json is told in one notice, again only once the file changes, and its jobs are kept", () => {
    const b = bench([]);
    writeFileSync(b.files.schedule, "{ not json", { mode: 0o600 });
    assert.equal(b.tick(T0 + MINUTE), 1);
    assert.equal(b.tick(T0 + 2 * MINUTE), 1);
    assert.deepEqual(b.seen.notices.map((n) => n[0]), ["dotime: schedule cannot be used"]);
    assert.match(b.seen.notices[0][1], /schedule\.json cannot be used: it is not valid JSON; fix or remove it; no scheduled job runs until then$/);
    const later = new Date(Date.now() + 60_000);
    utimesSync(b.files.schedule, later, later);
    b.tick(T0 + 3 * MINUTE);
    assert.equal(b.seen.notices.length, 2, "a new change of the file is told again");
    assert.equal(readFileSync(b.files.schedule, "utf8"), "{ not json", "nothing is wiped");
});

test("tick: a lastDue that is not a time or lies ahead counts from now, said once", () => {
    for (const lastDue of [iso(T0 + 24 * 60 * MINUTE), "soon"]) {
        const b = bench([job({ lastDue })]);
        assert.equal(b.tick(T0 + 5 * MINUTE), 0);
        const why = lastDue === "soon" ? "is not a time" : "lies ahead of now";
        assert.deepEqual(b.seen.said, [`schedule tick: job 0a1b2c3d lastDue ${JSON.stringify(lastDue)} ${why}; its due times count from now`]);
        assert.equal(b.stored()[0].lastDue, iso(T0 + 5 * MINUTE));
        assert.equal(b.seen.starts.length, 0);
        assert.equal(b.tick(T0 + 6 * MINUTE), 0);
        assert.deepEqual([b.seen.starts.length, b.seen.said.length, b.journal().length], [1, 1, 0], "then the normal cadence");
    }
    const b = bench([job({ lastDue: iso(T0 + MINUTE + GRACE_MS) })]);
    b.tick(T0 + MINUTE);
    assert.deepEqual(b.seen.said, [], "a lastDue up to 2 min ahead is a clock that moved back a little, and is kept");
});

test("tick: a run with noSkip is started with run --no-skip, and its log is for its owner alone", () => {
    const b = bench([job({ noSkip: true })]);
    b.tick(T0 + MINUTE);
    assert.deepEqual(b.seen.starts[0].words, ["/opt/deployontime/queue/cli.mjs", "run", "--label=shop-api: lint", "--no-skip", "--", "npm", "run", "lint"]);
    assert.equal(statSync(join(b.files.scheduleRuns, "0a1b2c3d.log")).mode & 0o777, 0o600);
});

test("history: the tick's own could-not-start lines count as jobs but not in the wait median and p90", () => {
    const j = job({ cwd: "/srv/shop-api" });
    const run = (wait) => JSON.stringify({
        v: 1, label: j.label, project: "shop-api", cwd: j.cwd, queuedAt: iso(T0), startedAt: iso(T0 + wait * MINUTE),
        endedAt: iso(T0 + (wait + 1) * MINUTE), waitMin: wait, runMin: 1, outcome: "ran", exit: 0, scheduled: j.id,
    });
    const noStart = JSON.stringify(tickRow(j, "could-not-start", T0, {}, 127));
    const { all } = summarize([run(10), run(20), run(30), noStart, noStart, noStart, noStart]);
    const alone = summarize([run(10), run(20), run(30)]).all;
    assert.equal(all.jobs, 7);
    assert.deepEqual([all.waitMedian, all.waitP90], [alone.waitMedian, alone.waitP90]);
    assert.ok(all.waitMedian >= 10);
});

test("tick: a second tick while one holds the lock returns 0 at once and does nothing", () => {
    const b = bench([job()]);
    writeFileSync(b.files.scheduleLock, JSON.stringify({ pid: process.pid, born: BORN }));
    const other = { ...b.deps, owner: { pid: 5999, born: T0 } };
    assert.equal(runTick(b.files, { ...other, now: () => T0 + MINUTE }), 0);
    assert.deepEqual(b.seen, { starts: [], printed: [], said: [], notices: [] });
    assert.equal(b.stored()[0].lastDue, undefined);
});

test("tick: a job whose folder is gone is journalled as could-not-start, and its due time is used up", () => {
    const b = bench([job({ cwd: "/nonexistent/shop-api" })]);
    b.tick(T0 + MINUTE);
    assert.equal(b.seen.starts.length, 0);
    assert.deepEqual(b.journal().map((r) => [r.outcome, r.exit, r.scheduled]), [["could-not-start", 127, "0a1b2c3d"]]);
    assert.deepEqual(b.seen.printed, ['schedule tick: not started 0a1b2c3d "shop-api: lint"; the folder /nonexistent/shop-api is missing']);
    assert.equal(b.stored()[0].lastDue, iso(T0 + MINUTE));
});

test("tick: a broken schedule.json exits 1 with a message; a broken job is skipped and the others still run", () => {
    const b = bench([]);
    writeFileSync(b.files.schedule, "{");
    assert.equal(b.tick(T0 + MINUTE), 1);
    assert.match(b.seen.said[0], /^schedule tick: .*schedule\.json cannot be used: it is not valid JSON; fix or remove it$/);
    const c = bench([job({ id: "ffffffff", every: "5s" }), job()]);
    assert.equal(c.tick(T0 + MINUTE), 0);
    assert.match(c.seen.said[0], /^schedule tick: job ffffffff skipped; "5s" is not a step/);
    assert.equal(c.seen.starts.length, 1);
});

test("startRun: a missing folder gives an error and starts nothing", () => {
    const files = paths({ DOTIME_HOME: tempDir("tick-home") });
    assert.deepEqual(startRun(job({ cwd: "/nonexistent" }), files, { spawn: () => assert.fail("no start") }), { error: "the folder /nonexistent is missing" });
});

// ---- real runs through the real `run` path ----

/** A state folder whose config lets any reading of this computer through, and the deps of the real command with the
 *  tick's clock in the test's hand. */
function realBench() {
    const home = tempDir("tick-real-home");
    writeFileSync(join(home, "config.json"), JSON.stringify({ pollMs: 60, health: WIDE_OPEN, limits: { killGraceMs: 250, orphanCheckMs: 80 } }));
    const env = cleanEnv(home);
    const files = paths({ DOTIME_HOME: home });
    const clock = { now: Date.now() };
    const printed = [];
    const deps = {
        ...scheduleDeps({ files }, "UTC", env), now: () => clock.now, wall: UTC, print: (l) => printed.push(l), say: (l) => printed.push(l),
        installed: () => true, newId: (() => { let n = 0; return () => `00000a0${n++}`; })(),
        spawn: (...a) => track(spawn(...a)),
    };
    const journal = () => (existsSync(files.journal) ? readFileSync(files.journal, "utf8").trim().split("\n").flatMap(parse) : []);
    const cli = (args, cwd) => spawnSync(NODE, [CLI, ...args], { env, cwd: cwd ?? home, encoding: "utf8" });
    return { home, files, env, clock, deps, printed, journal, cli };
}
const addJob = (r, words, cwd) => {
    assert.equal(cmdSchedule(["add", ...words], r.files, { ...r.deps, cwd: () => cwd }), 0, r.printed.join("\n"));
    return readSchedule(r.files.schedule).jobs.at(-1);
};
const rowsOf = (r, id) => r.journal().filter((row) => row.scheduled === id);
/** Waits until the job has n lines that are not busy lines and its last run has ended. */
const runFinished = (r, id, n) => until(() => rowsOf(r, id).filter((row) => row.outcome !== "busy").length >= n
    && !stillGoing(readSchedule(r.files.schedule).jobs.find((j) => j.id === id), processGone));

test("acceptance: a job every minute runs through the real run path, history counts it scheduled, and disable stops it", async () => {
    const r = realBench(), work = tempDir("tick-real-work");
    const j = addJob(r, ["--label", "docs-site: link check", "--every", "1m", "--", NODE, "-e", "console.log('links ok')"], work);
    const created = Date.parse(j.createdAt);
    r.clock.now = created + MINUTE + 1000;
    assert.equal(cmdSchedule(["tick"], r.files, r.deps), 0);
    await runFinished(r, j.id, 1);
    const [first] = rowsOf(r, j.id);
    assert.deepEqual([first.outcome, first.exit, first.label, first.scheduled, first.cwd], ["ran", 0, "docs-site: link check", j.id, j.cwd]);
    assert.equal(readFileSync(join(r.files.scheduleRuns, `${j.id}.log`), "utf8"), "links ok\n");
    r.clock.now = created + 2 * MINUTE + 1000;
    cmdSchedule(["tick"], r.files, r.deps);
    await runFinished(r, j.id, 2);
    const history = r.cli(["history", "--days", "1"]);
    assert.deepEqual(history.stdout.trim().split("\n").slice(1).map((row) => row.split(";")[0]), [
        "all projects: jobs 2, failed 0, stopped 0, timed out 0, refused 0, gave up 0, flaky 0, scheduled 2",
        "docs-site: jobs 2, failed 0, stopped 0, timed out 0, refused 0, gave up 0, flaky 0, scheduled 2",
    ]);
    const list = r.cli(["schedule", "list"]);
    assert.match(list.stdout, new RegExp(`^schedule ${j.id}: "docs-site: link check", every 1m, enabled; next: .*; last: ran, exit 0\\n$`));
    assert.equal(cmdSchedule(["disable", j.id], r.files, r.deps), 0);
    r.clock.now = created + 5 * MINUTE;
    r.printed.length = 0;
    assert.equal(cmdSchedule(["tick"], r.files, r.deps), 0);
    assert.deepEqual(r.printed, []);
    assert.equal(rowsOf(r, j.id).length, 2, "nothing more started");
    const manual = r.cli(["run", "--label", "docs-site: link check", "--", NODE, "-e", "0"], work);
    assert.equal(manual.status, 0, manual.stderr);
    assert.equal("scheduled" in r.journal().at(-1), false, "a manual run's line has no scheduled field");
});

test("acceptance: two failed scheduled runs, and the third scheduled start is refused with exit 3, journalled with scheduled", async () => {
    const r = realBench(), repo = makeRepo(join(tempDir("tick-real-repo"), "shop-api"));
    const j = addJob(r, ["--label", "shop-api: nightly check", "--every", "1m", "--", NODE, "-e", "process.exit(1)"], repo);
    const created = Date.parse(j.createdAt);
    for (let n = 1; n <= 3; n++) {
        r.clock.now = created + n * MINUTE + 1000;
        cmdSchedule(["tick"], r.files, r.deps);
        await runFinished(r, j.id, n);
    }
    assert.deepEqual(rowsOf(r, j.id).map((row) => [row.outcome, row.exit]), [["ran", 1], ["ran", 1], ["refused", 3]]);
    assert.match(readFileSync(join(r.files.scheduleRuns, `${j.id}.log`), "utf8"), /refused: exit 3; same check failed twice on unchanged code/);
    const manual = r.cli(["run", "--label", "shop-api: nightly check", "--", NODE, "-e", "process.exit(1)"], repo);
    assert.equal(manual.status, 3, "a manual run of the same check is refused the same way");
    assert.equal("scheduled" in r.journal().at(-1), false);
    assert.match(r.cli(["schedule", "list"]).stdout, /last: refused, exit 3\n$/);
});

test("acceptance: a scheduled check that passed and then failed on one commit gets the flaky note, as a manual one does", async () => {
    const r = realBench(), repo = makeRepo(join(tempDir("tick-real-repo"), "shop-api"));
    const marker = join(tempDir("tick-real-marker"), "seen");
    const script = `const fs = require("node:fs"); const seen = fs.existsSync(${JSON.stringify(marker)}); `
        + `fs.writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(seen ? 1 : 0)`;
    // A job kind that is never skipped: a passed test on the same commit would be, as for a manual run.
    const j = addJob(r, ["--label", "shop-api: nightly job", "--every", "1m", "--", NODE, "-e", script], repo);
    const created = Date.parse(j.createdAt);
    for (let n = 1; n <= 2; n++) {
        r.clock.now = created + n * MINUTE + 1000;
        cmdSchedule(["tick"], r.files, r.deps);
        await runFinished(r, j.id, n);
    }
    const head = testGit(repo, "rev-parse", "HEAD").trim();
    assert.deepEqual(rowsOf(r, j.id).map((row) => [row.outcome, row.exit, row.head]), [["ran", 0, head], ["ran", 1, head]]);
    assert.match(readFileSync(join(r.files.scheduleRuns, `${j.id}.log`), "utf8"), /flaky: this check passed and failed on the same commit once/);
    assert.match(r.cli(["flaky"], repo).stdout, /^shop-api: nightly job; mixed on 1 commit, 1 pass and 1 failure/);
});

test("acceptance: a run that still goes at the next due time is not started again, and the busy line shows in history", async () => {
    const r = realBench(), work = tempDir("tick-real-work"), done = join(tempDir("tick-real-done"), "done");
    const wait = `const fs = require("node:fs"); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(done)})) clearInterval(t); }, 20);`;
    const added = addJob(r, ["--label", "docs-site: long check", "--every", "1m", "--", NODE, "-e", wait], work);
    // Due a moment ago on the real clock, since the busy check compares the run's start with its real age.
    const created = Date.now() - MINUTE - 1000;
    const j = { ...added, createdAt: iso(created) };
    writeSchedule(r.files.schedule, [j]);
    r.clock.now = Date.now();
    cmdSchedule(["tick"], r.files, r.deps);
    await until(() => existsSync(join(r.home, "slots", "slot-0.json")) || existsSync(join(r.home, "slots", "slot-1.json")));
    r.clock.now = created + 2 * MINUTE;
    cmdSchedule(["tick"], r.files, r.deps);
    assert.deepEqual(rowsOf(r, j.id).map((row) => row.outcome), ["busy"]);
    writeFileSync(done, "");
    await runFinished(r, j.id, 1);
    assert.deepEqual(rowsOf(r, j.id).map((row) => row.outcome), ["busy", "ran"]);
    // The tick's clock is a minute ahead of the real one here, so the range ends later than now.
    const history = historyLines(readFileSync(r.files.journal, "utf8").trim().split("\n"), { from: 0, to: Date.now() + 5 * MINUTE, title: "all" }).lines;
    assert.equal(history[0], "history: all, jobs 1", "a busy line is no job");
    assert.equal(history[1].split(";")[0], "all projects: jobs 1, failed 0, stopped 0, timed out 0, refused 0, gave up 0, flaky 0, scheduled 1, busy 1");
});

test("acceptance: two real ticks started at once start the due job once", async () => {
    const r = realBench(), work = tempDir("tick-real-work");
    const j = addJob(r, ["--label", "docs-site: link check", "--every", "1m", "--", NODE, "-e", "0"], work);
    writeSchedule(r.files.schedule, [{ ...j, createdAt: iso(Date.now() - MINUTE - 5000) }]);
    const tick = () => new Promise((done) => track(spawn(NODE, [CLI, "schedule", "tick"], { env: r.env, stdio: "ignore" })).on("close", done));
    assert.deepEqual(await Promise.all([tick(), tick()]), [0, 0]);
    await runFinished(r, j.id, 1);
    assert.equal(rowsOf(r, j.id).length, 1);
    assert.equal(existsSync(r.files.scheduleLock), false);
});

test("noticeBook: when its own file cannot be saved either, as on a full disk, a notice still goes out, at most once an hour", () => {
    const blocker = join(tempDir("tick-notes-full"), "a-file");
    writeFileSync(blocker, "");
    const notes = join(blocker, "schedule-notes.json");
    const sent = [];
    const tickAt = (iso) => noticeBook(notes, (title, message) => sent.push([iso, title, message]), Date.parse(iso));
    for (const iso of ["2040-01-01T10:57:05Z", "2040-01-01T10:58:05Z", "2040-01-01T10:59:05Z", "2040-01-01T11:00:05Z",
        "2040-01-01T11:01:05Z", "2040-01-01T11:59:05Z", "2040-01-01T12:00:05Z"]) {
        tickAt(iso).once("save", "ENOSPC", "dotime: schedule tick stopped", "schedule.json could not be saved (ENOSPC)");
    }
    assert.deepEqual(sent.map(([iso]) => iso), ["2040-01-01T11:00:05Z", "2040-01-01T12:00:05Z"]);
    assert.equal(existsSync(notes), false);
    const book = join(tempDir("tick-notes-ok"), "schedule-notes.json");
    const told = [];
    for (const minute of ["05", "06"]) {
        noticeBook(book, (title) => told.push(title), Date.parse(`2040-01-01T10:${minute}:05Z`)).once("save", "ENOSPC", "stopped", "x");
    }
    assert.deepEqual(told, ["stopped"], "with a file that saves, still once, at any minute");
});
