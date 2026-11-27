// The steps of `run`, driven in this process: a made-up health reading, a clock that moves only when a test moves it,
// and a timer in minutes that the test fires by hand. Jobs are real processes started through the real wrapper;
// signals go only to processes started here, and a stand-in takes the signal handlers instead of this process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { isolateProcess, readNotices, tempDir, track, until } from "./testkit.mjs";

isolateProcess("run");
const { EXIT, journalWriter, planJob, realDeps, runCommand, runJob, waitForSlot } = await import("./run.mjs");
const { cmdStatus, runDeps } = await import("./cli.mjs");
const { readHealth } = await import("./health.mjs");
const { DEFAULTS, paths } = await import("./settings.mjs");
const { alive } = await import("./proctree.mjs");
const { enqueue, takePlace, takeSlot } = await import("./slots.mjs");
const { placeKey } = await import("./nested.mjs");
const { notify } = await import("./notify.mjs");
const { addNotice } = await import("./notices.mjs");
const { gitState } = await import("./git.mjs");
const { afterMs } = await import("./timer.mjs");
const { probeGroupOf, probeProcessAges } = await import("./probes.mjs");
const { parseElapsed } = await import("./ps.mjs");

const NODE = process.execPath, MINUTE = 60_000;
const CALM = { load: 0.4, cores: 4, freePct: 70, diskGB: 150, battery: null };
const NOW = Date.UTC(2031, 3, 7, 9, 0);

// Job scripts, run with `node -e`.
const FOREVER = "setInterval(() => {}, 1000)";
const untilFile = (file) => "const fs = require(\"node:fs\"); "
    + `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(file)})) { clearInterval(t); } }, 20);`;
const savePid = (file) => `require("node:fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); ${FOREVER}`;
const withChild = (file) => "const c = require(\"node:child_process\")"
    + `.spawn(process.execPath, ["-e", ${JSON.stringify(FOREVER)}], { stdio: "ignore" }); `
    + `require("node:fs").writeFileSync(${JSON.stringify(file)}, String(c.pid)); ${FOREVER}`;
const pidIn = (file) => Number(readFileSync(file, "utf8"));
const count = (lines, part) => lines.filter((line) => line.includes(part)).length;

/** A state folder and a work folder, with the settings the e2e tests use: short polls and a short kill grace. */
function sandbox(config = {}) {
    const home = tempDir("run-home"), work = tempDir("run-work");
    const settings = {
        ...DEFAULTS, pollMs: 60, ...config,
        health: { ...DEFAULTS.health, ...config.health }, limits: { ...DEFAULTS.limits, killGraceMs: 250, ...config.limits },
    };
    return { home, work, ctx: { settings, files: paths({ DOTIME_HOME: home }), tz: "UTC", cwd: work } };
}
const journal = (box) => {
    try {
        return readFileSync(box.ctx.files.journal, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
};
const slots = (box) => {
    try {
        return readdirSync(join(box.home, "slots"))
            .filter((name) => name.endsWith(".json"))
            .map((name) => JSON.parse(readFileSync(join(box.home, "slots", name), "utf8")));
    } catch { return []; }
};

/** A timer in minutes that fires only when the test says how many minutes have passed. advanceTo() returns the
 *  marks it fired, so a test can see that a moment was reached and nothing was due. A cancelled timer counts as
 *  fired. */
function fakeMinutes() {
    const timers = [];
    return {
        after: (min, fn) => {
            const timer = { min, fn, fired: false };
            timers.push(timer);
            return () => { timer.fired = true; };
        },
        advanceTo(minutes) {
            const due = timers.filter((t) => !t.fired && t.min <= minutes).sort((a, b) => a.min - b.min);
            for (const t of due) { t.fired = true; t.fn(); }
            return due.map((t) => t.min);
        },
        get pending() { return timers.filter((t) => !t.fired).map((t) => t.min).sort((a, b) => a - b); },
    };
}
/** A wall clock that moves only by sleeping. */
function fakeClock(start = NOW) {
    let t = start;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
}
/** Deps for runCommand and its steps. Jobs start with their output dropped, and their groups are tracked. */
function makeDeps(box, overrides = {}) {
    const said = [], clock = fakeMinutes(), signals = new EventEmitter();
    const deps = {
        now: Date.now, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), readHealth: () => CALM,
        spawn: (program, args, options) => track(spawn(program, args, { ...options, stdio: ["ignore", "ignore", "ignore", "pipe"] }), { group: true }),
        say: (text) => said.push(text), usage: (text) => said.push(text), after: clock.after,
        later: afterMs, kill: (pid, signal) => process.kill(pid, signal),
        notify: (title, message) => notify(title, message, { env: { DOTIME_NOTIFY: "log" }, logFile: box.ctx.files.notifyLog }),
        addNotice, gitState, signals, ...overrides,
    };
    return { said, clock, signals, deps };
}
const settle = (promise) => {
    const state = { done: false };
    state.result = promise.then((code) => { state.done = true; return code; });
    return state;
};

// ---- planJob ----

const passedRun = (fields = {}) => ({
    projectKey: "docs-site", label: "docs-site: build", cmd: "pnpm run build", kind: "build", outcome: "ran", exit: 0, runMin: 8,
    endedAt: new Date(NOW - 60 * MINUTE).toISOString(), ...fields,
});
const failedRun = (minutesAgo) => ({
    projectKey: "shop-api", label: "shop-api: unit tests", cmd: "pnpm test", cwd: "/srv/shop-api", outcome: "ran", exit: 4,
    head: "ab12cd34ef", fp: "f00d", endedAt: new Date(NOW - minutesAgo * MINUTE).toISOString(),
});
const request = (fields = {}) => ({
    label: "docs-site: build", command: "pnpm run build", maxRun: null, priority: false, afterFix: null, project: "docs-site",
    cwd: "/srv/docs-site", head: "ab12cd34ef", fingerprint: "f00d", queuedAt: NOW, tz: "UTC", ...fields,
});

test("planJob: the limit comes from the journal rows, and the details name it", () => {
    const rows = Array.from({ length: 5 }, () => passedRun());
    const plan = planJob(request(), DEFAULTS, rows);
    assert.deepEqual([plan.kind, plan.stem, plan.limit.limitMin, plan.refusal, plan.afterFixUsed], ["build", "pnpm run build", 12, null, false]);
    assert.deepEqual(plan.details, { kind: "build", stem: "pnpm run build", limitMin: 12, limitBasis: plan.limit.basis, fp: "f00d" });
    assert.equal(planJob(request({ maxRun: 45 }), DEFAULTS, rows).limit.basis, "the --max-run flag");
    assert.equal(planJob(request({ kind: "Deploy" }), DEFAULTS, []).kind, "deploy");
});

test("planJob: refuses a check that failed twice on unchanged code, unless --after-fix is given", () => {
    const rows = [failedRun(90), failedRun(30)];
    const asked = request({ label: "shop-api: unit tests", command: "pnpm test", project: "shop-api", cwd: "/srv/shop-api" });
    const refused = planJob(asked, DEFAULTS, rows);
    assert.equal(refused.refusal.reason.startsWith('same check failed twice on unchanged code: "shop-api: unit tests", commit ab12cd34, exit 4 at '), true);
    const allowed = planJob({ ...asked, afterFix: "raised the pool size" }, DEFAULTS, rows);
    assert.deepEqual([allowed.refusal, allowed.afterFixUsed, allowed.details.afterFix], [null, true, "raised the pool size"]);
    assert.deepEqual([planJob({ ...asked, fingerprint: "beef" }, DEFAULTS, rows).refusal, planJob(asked, DEFAULTS, []).refusal], [null, null]);
});

// ---- waitForSlot ----

const waiter = (box, fields = {}) => ({
    pid: process.pid, label: "shop-api: lint", maxWait: 60, slotMeta: { kind: "lint" },
    settings: box.ctx.settings, files: box.ctx.files, ...fields,
});

test("waitForSlot: takes a free slot at once when the gate is open", async () => {
    const box = sandbox(), clock = fakeClock(), said = [];
    enqueue(process.pid, "shop-api: lint", false, box.ctx.files);
    const got = await waitForSlot(waiter(box), { ...clock, readHealth: () => CALM, say: (t) => said.push(t) });
    assert.deepEqual([typeof got.slot, got.tally, got.waitFrom, said], ["string", {}, NOW, []]);
    assert.deepEqual(slots(box).map((s) => [s.pid, s.label, s.kind]), [[process.pid, "shop-api: lint", "lint"]]);
});

test("waitForSlot: books the wait to the full slots, says why, and starts once a slot is free", async () => {
    const box = sandbox({ slots: 1 }), clock = fakeClock(), said = [];
    const blocker = takeSlot(process.pid, "docs-site: build", 1, {}, box.ctx.files);
    enqueue(process.pid, "shop-api: lint", false, box.ctx.files);
    let polls = 0;
    const sleep = async (ms) => { await clock.sleep(ms); if (++polls === 3) writeFileSync(blocker, "{}"); };
    const got = await waitForSlot(waiter(box), { now: clock.now, sleep, readHealth: () => CALM, say: (t) => said.push(t) });
    assert.equal(polls, 3);
    assert.deepEqual([typeof got.slot, got.tally], ["string", { slots: 3 * 60 }]);
    assert.deepEqual(said, ['in line: position 1, 0 min waited, wait limit 60 min; no free slot: 1 of 1 taken, by "docs-site: build"']);
});

test("waitForSlot: takes one health reading per poll, also when it prints why it waits", async () => {
    const box = sandbox({ slots: 2, health: { minFreeDiskGB: 12 } }), clock = fakeClock(), said = [];
    enqueue(process.pid, "shop-api: lint", false, box.ctx.files);
    let readings = 0;
    const readHealth = () => { readings++; return { ...CALM, diskGB: 3 }; };
    const got = await waitForSlot(waiter(box, { maxWait: 0.003 }), { ...clock, readHealth, say: (t) => said.push(t) });
    assert.equal(got.gaveUp, true);
    assert.deepEqual([said.length, readings], [2, 4], "four polls, each with one reading");
});

test("waitForSlot: carries on an earlier wait, so the wait limit counts from its start and its time is booked with it", async () => {
    const box = sandbox({ slots: 1 }), clock = fakeClock(), said = [];
    takeSlot(process.pid, "docs-site: build", 1, {}, box.ctx.files);
    enqueue(process.pid, "shop-api: lint", false, box.ctx.files);
    const earlier = { waitFrom: NOW - 2 * MINUTE, tally: { nested: 2 * MINUTE } };
    const got = await waitForSlot(waiter(box, { maxWait: 2, ...earlier }), { ...clock, readHealth: () => CALM, say: (t) => said.push(t) });
    assert.deepEqual([got.gaveUp, got.tally], [true, { nested: 2 * MINUTE }]);
    assert.equal(said[0].startsWith("gave up: exit 75, position 1, 2 min waited; "), true, said[0]);
});

test("waitForSlot: leaves the line when a signal asks for it", async () => {
    const box = sandbox({ slots: 1 }), clock = fakeClock();
    takeSlot(process.pid, "docs-site: build", 1, {}, box.ctx.files);
    let leaving = null;
    const sleep = async (ms) => { await clock.sleep(ms); leaving = "SIGTERM"; };
    const got = await waitForSlot(waiter(box), { now: clock.now, sleep, readHealth: () => CALM, say: () => {}, leaving: () => leaving });
    assert.deepEqual(got, { left: "SIGTERM", tally: {} }, "a poll that ends with a signal pending is not booked");
});

// ---- realDeps ----

test("realDeps: the real command reads git and stores notices through the same deps the tests replace", () => {
    const real = realDeps({ readHealth: () => CALM, notify: () => {}, after: () => null });
    assert.deepEqual([real.gitState, real.addNotice, real.signals], [gitState, addNotice, process]);
});

// ---- journalWriter ----

test("journalWriter: note() fills in the start, commit, wait and details, and finish() writes one line", () => {
    const box = sandbox();
    const writer = journalWriter({
        label: "docs-site: build", folder: "docs-site", cwd: box.work, priority: false, queuedAt: NOW,
        command: "pnpm run build", details: { kind: "build" }, file: box.ctx.files.journal, now: () => NOW + 3 * MINUTE,
    });
    writer.note({ commit: { head: "ab12cd34ef", clean: true }, tally: { slots: 60_000 } });
    writer.note({ startedAt: NOW + MINUTE, details: { kind: "lint" } });
    writer.finish("ran", 0);
    writer.finish("ran", 1);
    const lines = journal(box);
    assert.deepEqual(lines.map((line) => [line.outcome, line.exit, line.head, line.clean, line.waitBy.slots, line.runMin, line.kind]), [
        ["ran", 0, "ab12cd34ef", true, 1, 2, "lint"],
    ]);
});

// ---- runJob ----

function startJob(box, cmd, fields = {}) {
    const d = makeDeps(box, fields.deps);
    const slot = takeSlot(process.pid, "docs-site: build", 1, {}, box.ctx.files);
    const writer = journalWriter({
        label: "docs-site: build", folder: "docs-site", cwd: box.work, priority: false, queuedAt: Date.now(),
        command: cmd.join(" "), details: { kind: "build" }, file: box.ctx.files.journal, now: Date.now,
    });
    const limit = { limitMin: 30, killMin: 30, longRunMin: 20, notifyLongRun: false, basis: "the default" };
    const job = {
        pid: process.pid, label: "docs-site: build", project: "docs-site", cwd: box.work, cmd, priority: false, kind: "build",
        limit, waitFrom: Date.now(), ...box.ctx, journal: writer,
    };
    return { ...d, slot, run: settle(runJob(job, slot, d.deps)) };
}

test("runJob: passes the job's exit code on, journals the run and frees the slot", async () => {
    const box = sandbox(), job = startJob(box, [NODE, "-e", "process.exit(4)"]);
    assert.equal(await job.run.result, 4);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit, line.kind, typeof line.startedAt]), [["ran", 4, "build", "string"]]);
    assert.deepEqual([slots(box), job.clock.pending, job.signals.eventNames()], [[], [], []]);
});

test("runJob: a signal on the watched process goes on to the job, and the run is journalled as stopped", async () => {
    const box = sandbox(), pidFile = join(box.work, "job.pid"), job = startJob(box, [NODE, "-e", savePid(pidFile)]);
    await until(() => existsSync(pidFile));
    const pid = pidIn(pidFile);
    job.signals.emit("SIGTERM");
    assert.equal(await job.run.result, 1);
    await until(() => !alive(pid), 3000);
    const [line] = journal(box);
    assert.deepEqual([line.outcome, line.signal, typeof line.stoppedAt], ["stopped", "SIGTERM", "string"]);
    assert.deepEqual(job.said, ["stopped: signal SIGTERM, 0 min run, journalled as stopped and not as failed"]);
});

test("runJob: a command that cannot start ends with 127 and is journalled as could-not-start", async () => {
    const box = sandbox(), job = startJob(box, ["dotime-command-that-is-not-installed"]);
    assert.equal(await job.run.result, EXIT.noStart);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit]), [["could-not-start", 127]]);
    assert.equal(job.said[0].startsWith("start failed: exit 127, "), true);
});

test("runJob: the job finds the marker of its slot in DOTIME_JOB and DOTIME_PARENT, for a run of the queue inside it", async () => {
    const box = sandbox(), seen = join(box.work, "marker");
    const script = `const e = process.env; require("node:fs").writeFileSync(${JSON.stringify(seen)}, e.DOTIME_JOB + " " + e.DOTIME_PARENT)`;
    const job = startJob(box, [NODE, "-e", script]);
    assert.equal(await job.run.result, 0);
    assert.equal(readFileSync(seen, "utf8"), "slot-0 slot-0");
});

// ---- nested runs: this file's parent stands in for the queue process of the outer job ----

const nestedNotes = (box) => {
    try { return readdirSync(join(box.home, "nested")); } catch { return []; }
};
const places = (box) => {
    try { return readdirSync(join(box.home, "places")); } catch { return []; }
};
/** A sandbox whose only slot is held by an ancestor of this process, and deps whose environment names that slot. The
 *  slot file carries the start time and process group a real holder has. */
function nestedBox() {
    const box = sandbox({ slots: 1 });
    const born = Date.now() - parseElapsed(probeProcessAges([process.ppid])).get(process.ppid) * 1000;
    takeSlot(process.ppid, "docs-site: test suite", 1, { born, pgid: probeGroupOf(process.ppid) }, box.ctx.files);
    return box;
}
const nestedDeps = (box, overrides = {}) => makeDeps(box, { env: { DOTIME_JOB: "slot-0" }, readHealth: assert.fail, ...overrides });

test("run: a nested run takes no slot, joins no line, skips the gate, passes the markers on and journals nested", async () => {
    const box = nestedBox(), seen = join(box.work, "marker"), d = nestedDeps(box);
    const script = `require("node:fs").writeFileSync(${JSON.stringify(seen)}, process.env.DOTIME_JOB + " " + process.env.DOTIME_PARENT)`;
    const args = ["run", "--label", "docs-site: unit tests", "--max-wait", "0.01", "--", NODE, "-e", script];
    assert.equal(await runCommand(args, box.ctx, d.deps), 0);
    assert.equal(readFileSync(seen, "utf8"), `slot-0 nested-${process.pid}`,
        "the outer slot stays in DOTIME_JOB, and a run nested one level deeper finds this run as its parent");
    assert.deepEqual(d.said, [`nested: inside "docs-site: test suite", pid ${process.ppid}; starts at once: no slot, no place in line, no health gate`]);
    const [line] = journal(box);
    assert.deepEqual([line.outcome, line.exit, line.nested, line.waitBy, line.waitMin, typeof line.startedAt], ["ran", 0, true, {}, 0, "string"]);
    assert.deepEqual(slots(box).map((slot) => slot.pid), [process.ppid]);
    assert.deepEqual([readdirSync(join(box.home, "line")), nestedNotes(box), places(box), d.signals.eventNames()], [[], [], [], []]);
});

test("run: a nested run keeps the repeated-failure stop and its own run limit", async () => {
    const box = nestedBox(), failing = ["run", "--label", "shop-api: unit tests", "--", NODE, "-e", "process.exit(4)"];
    for (const attempt of [1, 2]) assert.equal(await runCommand(failing, box.ctx, nestedDeps(box).deps), 4, `attempt ${attempt}`);
    const refused = nestedDeps(box);
    assert.equal(await runCommand(failing, box.ctx, refused.deps), EXIT.refused);
    assert.equal(refused.said.at(-1).startsWith("refused: exit 3; same check failed twice on unchanged code: "), true);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit, line.nested]), [["ran", 4, true], ["ran", 4, true], ["refused", 3, true]]);
    const pidFile = join(box.work, "job.pid"), limited = nestedDeps(box);
    const run = settle(runCommand(["run", "--label", "shop-api: e2e", "--max-run", "2", "--", NODE, "-e", savePid(pidFile)], box.ctx, limited.deps));
    await until(() => existsSync(pidFile));
    assert.deepEqual(limited.clock.advanceTo(2), [2]);
    assert.equal(await run.result, EXIT.timedOut);
    await until(() => !alive(pidIn(pidFile)), 3000);
    assert.deepEqual([journal(box).at(-1).outcome, journal(box).at(-1).nested, nestedNotes(box)], ["timed-out", true, []]);
});

test("run: a signal reaches a nested job, which is journalled as stopped", async () => {
    const box = nestedBox(), pidFile = join(box.work, "job.pid"), d = nestedDeps(box);
    const run = settle(runCommand(["run", "--label", "docs-site: unit tests", "--", NODE, "-e", savePid(pidFile)], box.ctx, d.deps));
    await until(() => existsSync(pidFile));
    d.signals.emit("SIGTERM");
    assert.equal(await run.result, 1);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.signal, line.nested]), [["stopped", "SIGTERM", true]]);
    assert.deepEqual([nestedNotes(box), d.signals.eventNames()], [[], []]);
});

/** A nested sandbox with nestedPerJob 1 whose one place under the outer job is held by this file's parent. */
function fullPlacesBox(config = {}) {
    const box = sandbox({ slots: 1, nestedPerJob: 1, ...config });
    const born = Date.now() - parseElapsed(probeProcessAges([process.ppid])).get(process.ppid) * 1000;
    const slot = takeSlot(process.ppid, "docs-site: test suite", 1, { born, pgid: probeGroupOf(process.ppid) }, box.ctx.files);
    const outer = JSON.parse(readFileSync(slot, "utf8"));
    const blocker = takePlace(process.ppid, "docs-site: lint", placeKey({ file: slot, born: outer.born }), 1, box.ctx.files);
    return { box, blocker };
}

test("run: a nested run whose parent's places are all taken waits for one, and gives up with exit 75 at its wait limit", async () => {
    const { box, blocker } = fullPlacesBox({ pollMs: 3000 }), clock = fakeClock();
    const d = nestedDeps(box, { now: clock.now, sleep: clock.sleep, spawn: assert.fail });
    const args = ["run", "--label", "docs-site: unit tests", "--max-wait", "0.5", "--", NODE, "-e", "process.exit(0)"];
    assert.equal(await runCommand(args, box.ctx, d.deps), EXIT.gaveUp);
    const why = `no free nested place: 1 of 1 taken under "docs-site: test suite", pid ${process.ppid}`;
    assert.deepEqual(d.said, [
        `in line for a nested place: position 1, 0 min waited, wait limit 0.5 min; ${why}`,
        `gave up: exit 75, nested position 1, 1 min waited; ${why}; hint: --max-wait 0 waits without limit, and nestedPerJob in config.json sets the places`,
    ]);
    const [line] = journal(box);
    assert.deepEqual([line.outcome, line.exit, line.nested, line.startedAt, line.waitBy], ["gave-up", 75, true, null, { nested: 0.5 }]);
    assert.equal(line.waitMin, 0.5, "the wait is journalled");
    assert.deepEqual([nestedNotes(box), places(box), readdirSync(join(box.home, "line")), d.signals.eventNames()], [[], [blocker.split("/").at(-1)], [], []]);
    assert.deepEqual(slots(box).map((slot) => slot.pid), [process.ppid], "no slot was taken or freed");
});

test("run: a nested run that waits for a place starts once its parent's place is freed, without the health gate", async () => {
    const { box, blocker } = fullPlacesBox(), d = nestedDeps(box);
    const run = settle(runCommand(["run", "--label", "docs-site: unit tests", "--max-wait", "0", "--", NODE, "-e", "process.exit(0)"], box.ctx, d.deps));
    await until(() => d.said.length === 1);
    assert.equal(nestedNotes(box).length, 1);
    assert.equal(JSON.parse(readFileSync(join(box.home, "nested", nestedNotes(box)[0]), "utf8")).waiting, true);
    assert.equal(run.done, false);
    rmSync(blocker);
    assert.equal(await run.result, 0);
    const started = "starts now that a nested place is free: no slot, no place in line, no health gate";
    assert.equal(d.said.at(-1), `nested: inside "docs-site: test suite", pid ${process.ppid}; ${started}`);
    assert.deepEqual([journal(box)[0].outcome, journal(box)[0].nested, nestedNotes(box), places(box)], ["ran", true, [], []]);
});

test("run: a nested run whose parent ends while it waits for a place stops waiting and joins the line as a normal run", async () => {
    const { box, blocker } = fullPlacesBox(), other = track(spawn(NODE, ["-e", FOREVER], { stdio: "ignore" }));
    const d = nestedDeps(box, { readHealth: () => CALM });
    const run = settle(runCommand(["run", "--label", "docs-site: unit tests", "--max-wait", "0", "--", NODE, "-e", "process.exit(0)"], box.ctx, d.deps));
    await until(() => d.said.length === 1);
    // The parent ends: its place is freed and another job takes its slot.
    rmSync(join(box.home, "slots", "slot-0.json"));
    takeSlot(other.pid, "shop-api: e2e", 1, {}, box.ctx.files);
    rmSync(blocker);
    await until(() => d.said.some((line) => line.startsWith("in line: position 1")));
    const gone = `parent gone: "docs-site: test suite", pid ${process.ppid}, ended while this run waited for a nested place`;
    assert.equal(d.said[1], `${gone}; joins the line as a normal run`);
    assert.equal(d.said[2].endsWith('no free slot: 1 of 1 taken, by "shop-api: e2e"'), true, d.said[2]);
    assert.equal(run.done, false, "it waits for the slot and does not run beside the job in it");
    assert.deepEqual([nestedNotes(box), places(box), readdirSync(join(box.home, "line")).length], [[], [], 1]);
    other.kill("SIGKILL");
    assert.equal(await run.result, 0);
    const [line] = journal(box);
    assert.deepEqual([line.outcome, line.exit, line.nested, Object.keys(line.waitBy).sort()], ["ran", 0, undefined, ["nested", "slots"]]);
    assert.deepEqual([slots(box), nestedNotes(box), places(box), readdirSync(join(box.home, "line")), d.signals.eventNames()], [[], [], [], [], []]);
});

test("run: a signal while a nested run waits for a place ends it with 130 and leaves no place, note or line entry", async () => {
    const { box, blocker } = fullPlacesBox(), d = nestedDeps(box, { spawn: assert.fail });
    const run = settle(runCommand(["run", "--label", "docs-site: unit tests", "--max-wait", "0", "--", NODE, "-e", "process.exit(0)"], box.ctx, d.deps));
    await until(() => d.said.length === 1);
    d.signals.emit("SIGTERM");
    assert.equal(await run.result, EXIT.left);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit, line.signal, line.nested]), [["left", 130, "SIGTERM", true]]);
    assert.deepEqual([nestedNotes(box), places(box), readdirSync(join(box.home, "line")), d.signals.eventNames()], [[], [blocker.split("/").at(-1)], [], []]);
});

// ---- runCommand, with a made-up reading or a clock moved by hand ----

test("run: when the wait limit runs out, exit 75 names each health reading that kept the gate shut", async () => {
    const box = sandbox({ health: { loadPerCore: 2, minFreeDiskGB: 12 } }), clock = fakeClock();
    const reading = { load: 50, cores: 4, freePct: 70, diskGB: 0, battery: null };
    const d = makeDeps(box, { now: clock.now, sleep: clock.sleep, readHealth: () => reading, spawn: assert.fail });
    const code = await runCommand(["run", "--label", "docs-site: build", "--max-wait", "0.01", "--", NODE, "-e", "console.log('started')"], box.ctx, d.deps);
    assert.equal(code, 75);
    const why = "load too high: 50.0 now, 8.0 allowed; disk too low: 0.0 GB free, 12 GB needed";
    assert.equal(d.said.includes(`in line: position 1, 0 min waited, wait limit 0.01 min; ${why}`), true);
    assert.equal(d.said.at(-1), `gave up: exit 75, position 1, 0 min waited; ${why}; hint: --max-wait 0 waits without limit`);
    const [line] = journal(box);
    assert.deepEqual([line.outcome, line.exit, Object.keys(line.waitBy).sort(), line.startedAt], ["gave-up", 75, ["disk", "load"], null]);
    assert.deepEqual(readdirSync(join(box.home, "line")), []);
    const printed = [];
    assert.equal(cmdStatus(box.ctx, { readHealth: () => reading, print: (text) => printed.push(text) }), 0);
    assert.equal(`${printed.join("\n")}\n`, `slots: 0 of ${DEFAULTS.slots} taken, 0 waiting\ngate: shut; ${why}\n`);
});

test("run and status: a high load with an idle CPU starts the job, with a busy CPU it waits, both judged alike", async () => {
    const box = sandbox({ health: { loadPerCore: 2 } });
    const calmed = { load: 14.8, cores: 4, busyCpuPct: 12, freePct: 70, diskGB: 100, battery: null };
    const status = (reading) => {
        const printed = [], asked = [];
        cmdStatus(box.ctx, { readHealth: (options) => { asked.push(options); return reading; }, print: (text) => printed.push(text) });
        assert.deepEqual(asked, [{ limits: box.ctx.settings.health, cpuSince: null }], "status takes the reading with the gate limits");
        return printed.at(-1);
    };
    const start = fakeClock(), d = makeDeps(box, { now: start.now, sleep: start.sleep, readHealth: () => calmed });
    assert.equal(await runCommand(["run", "--label", "docs-site: build", "--max-wait", "0.01", "--", NODE, "-e", "process.exit(0)"], box.ctx, d.deps), 0);
    assert.equal(status(calmed), "gate: open");
    const busy = { ...calmed, busyCpuPct: 97 }, clock = fakeClock();
    const held = makeDeps(box, { now: clock.now, sleep: clock.sleep, readHealth: () => busy, spawn: assert.fail });
    const code = await runCommand(["run", "--label", "docs-site: build", "--max-wait", "0.01", "--", NODE, "-e", "process.exit(0)"], box.ctx, held.deps);
    const why = "load too high: 14.8 now, 8.0 allowed; CPU 97% busy now";
    assert.deepEqual([code, held.said.at(-1)], [75, `gave up: exit 75, position 1, 0 min waited; ${why}; hint: --max-wait 0 waits without limit`]);
    assert.equal(status(busy), `gate: shut; ${why}`);
});

test("run: the shared reading the cli hands to run is taken with the gate limits, so an idle CPU lets a job start", async () => {
    const box = sandbox({ health: { loadPerCore: 2 } }), clock = fakeClock(), asked = [];
    // One core, a quarter busy, on a CPU clock that moves only while the reading waits.
    let cpuMs = 0;
    const probes = {
        load: () => ({ load: 14.8, cores: 4 }), memory: () => 70, disk: () => 100, battery: () => null,
        cpuTimes: () => ({ at: cpuMs, cpus: [{ times: { user: cpuMs / 4, nice: 0, sys: 0, idle: (cpuMs * 3) / 4, irq: 0 } }] }),
        wait: (ms) => { cpuMs += ms; },
    };
    const read = (options) => { asked.push(options); return readHealth({ ...options, probes }); };
    const { readHealth: shared } = runDeps(box.ctx, read);
    const d = makeDeps(box, { now: clock.now, sleep: clock.sleep, readHealth: shared });
    const code = await runCommand(["run", "--label", "docs-site: build", "--max-wait", "0.01", "--", NODE, "-e", "process.exit(0)"], box.ctx, d.deps);
    assert.deepEqual(asked.map((options) => options.limits), [box.ctx.settings.health], "run reads the health with the gate limits");
    assert.deepEqual([code, d.said.filter((text) => text.startsWith("gave up"))], [0, []]);
    assert.equal(JSON.parse(readFileSync(box.ctx.files.healthCache, "utf8")).reading.busyCpuPct, 25);
});

test("status: measures the CPU against the CPU times saved with the shared reading, and leaves the file as it was", () => {
    const box = sandbox();
    const cpuTimes = { at: 40_000, cpus: [{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }] };
    const saved = JSON.stringify({ at: 40_000, reading: { load: 1, cores: 4, freePct: 70, diskGB: 100, battery: null }, cpuTimes });
    writeFileSync(box.ctx.files.healthCache, saved);
    const asked = [];
    const reading = { load: 1, cores: 4, busyCpuPct: null, freePct: 70, diskGB: 100, battery: null };
    cmdStatus(box.ctx, { readHealth: (options) => { asked.push(options); return reading; }, print: () => {} });
    assert.deepEqual(asked, [{ limits: box.ctx.settings.health, cpuSince: cpuTimes }]);
    assert.equal(readFileSync(box.ctx.files.healthCache, "utf8"), saved);
});

test("run: the journal line stores the fingerprint as fp, the name older copies of the queue read", async () => {
    const box = sandbox(), d = makeDeps(box);
    const args = ["run", "--label", "docs-site: build", "--", NODE, "-e", "process.exit(0)"];
    assert.equal(await runCommand(args, box.ctx, d.deps), 0);
    const [line] = journal(box);
    assert.deepEqual([typeof line.fp, /^[0-9a-f]+$/.test(line.fp), "fingerprint" in line], ["string", true, false]);
});

test("run: exit 124 at the run limit stops the whole process group", async () => {
    const box = sandbox(), pidFile = join(box.work, "child.pid"), d = makeDeps(box);
    const run = settle(runCommand(["run", "--label", "shop-api: e2e", "--max-run", "3", "--", NODE, "-e", withChild(pidFile)], box.ctx, d.deps));
    await until(() => existsSync(pidFile));
    const jobChild = pidIn(pidFile);
    assert.deepEqual(d.clock.advanceTo(2), [], "minute 2 is reached and nothing is due");
    assert.deepEqual([run.done, alive(jobChild)], [false, true]);
    assert.deepEqual(d.clock.advanceTo(3), [3]);
    assert.equal(await run.result, 124);
    assert.equal(d.said.includes('run limit: stopping "shop-api: e2e", KILL follows TERM after 0.25 s; '
        + "ran 3 min against a limit of 3 min, set by the --max-run flag"), true);
    assert.equal(d.said.some((line) => line.startsWith("timed out: exit 124, stopped after 3 min; hint: ")), true);
    await until(() => !alive(jobChild), 3000);
    assert.deepEqual([journal(box).map((line) => [line.outcome, line.exit]), slots(box)], [[["timed-out", 124]], []]);
});

test("run: a run-limit stop whose KILL is refused is reported and journalled as a failed stop", async () => {
    const box = sandbox(), pidFile = join(box.work, "job.pid"), timers = [];
    const refuse = (pid, signal) => {
        if (signal === 0) return process.kill(pid, 0);
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    const d = makeDeps(box, { later: (ms, fn) => { timers.push({ ms, fn }); return () => {}; }, kill: refuse });
    const args = ["run", "--label", "shop-api: e2e", "--max-run", "2", "--", NODE, "-e", savePid(pidFile)];
    const run = settle(runCommand(args, box.ctx, d.deps));
    await until(() => existsSync(pidFile));
    const job = pidIn(pidFile);
    assert.deepEqual(d.clock.advanceTo(2), [2]);
    assert.deepEqual(timers.map((t) => t.ms), [250, 5250], "the KILL after the grace, then the backstop");
    timers[0].fn();
    assert.equal(alive(job), true);
    timers[1].fn();
    assert.equal(await run.result, 124);
    const refused = /^KILL refused for group \d+ \(EPERM\), pid \d+ \(EPERM\)/;
    const said = d.said.find((line) => line.startsWith("timed out: "));
    assert.equal(said.startsWith("timed out: exit 124, stop failed after 2 min, KILL refused for group "), true, said);
    const [line] = journal(box);
    assert.deepEqual([line.outcome, line.exit, refused.test(line.stopFailed)], ["timed-out", 124, true]);
    process.kill(job, "SIGKILL");
    await until(() => !alive(job), 3000);
});

test("run: at the end every timer is cancelled: the warning, the long-run notice, the KILL and the backstop", async () => {
    const box = sandbox({ limits: { longRunUnmeasuredMin: 3 } }), pidFile = join(box.work, "job.pid"), short = [];
    const later = (ms, fn) => {
        const timer = { ms, fn, cancelled: false };
        short.push(timer);
        return () => { timer.cancelled = true; };
    };
    const d = makeDeps(box, { later });
    const args = ["run", "--priority", "--label", "shop-api: e2e", "--max-run", "2", "--", NODE, "-e", savePid(pidFile)];
    const run = settle(runCommand(args, box.ctx, d.deps));
    await until(() => existsSync(pidFile));
    assert.deepEqual(d.clock.pending, [2, 3, 4], "the warning, the long-run notice and the stop");
    assert.deepEqual(d.clock.advanceTo(2), [2]);
    process.kill(pidIn(pidFile), "SIGKILL");
    assert.equal(await run.result, 1, "the job ended by itself before its stop");
    assert.deepEqual([d.clock.pending, short], [[], []], "no timer is left once the job has ended");
    const box2 = sandbox(), pidFile2 = join(box2.work, "job.pid"), short2 = [];
    const later2 = (ms, fn) => {
        const timer = { ms, fn, cancelled: false };
        short2.push(timer);
        return () => { timer.cancelled = true; };
    };
    const d2 = makeDeps(box2, { later: later2 });
    const args2 = ["run", "--label", "shop-api: e2e", "--max-run", "2", "--", NODE, "-e", savePid(pidFile2)];
    const run2 = settle(runCommand(args2, box2.ctx, d2.deps));
    await until(() => existsSync(pidFile2));
    assert.deepEqual(d2.clock.advanceTo(2), [2]);
    assert.equal(await run2.result, 124);
    assert.deepEqual(short2.map((t) => [t.ms, t.cancelled]), [[250, true], [5250, true]],
        "the KILL after the grace and the backstop are cancelled once the job ended by its TERM");
});

test("run: with --priority the limit only warns, and the stop comes at double the limit", async () => {
    const box = sandbox(), pidFile = join(box.work, "job.pid"), d = makeDeps(box);
    const run = settle(runCommand(
        ["run", "--priority", "--label", "mobile-app: store upload", "--max-run", "4", "--", NODE, "-e", savePid(pidFile)],
        box.ctx,
        d.deps,
    ));
    await until(() => existsSync(pidFile));
    const job = pidIn(pidFile);
    assert.deepEqual([slots(box)[0].priority, slots(box)[0].limitMin, slots(box)[0].killMin], [true, 4, 8]);
    assert.deepEqual(d.clock.advanceTo(4), [4]);
    assert.deepEqual(d.clock.advanceTo(7), [], "minute 7 is reached and nothing is due");
    assert.deepEqual([run.done, alive(job), slots(box).length], [false, true, 1]);
    assert.deepEqual(d.said, ['priority warning: hard stop at 8 min, the 4 min limit (set by the --max-run flag) was passed by "mobile-app: store upload"']);
    assert.deepEqual(d.clock.advanceTo(8), [8]);
    assert.equal(await run.result, 124);
    assert.equal(d.said.some((line) => line.includes('run limit: stopping "mobile-app: store upload"')
        && line.includes("ran 8 min against a limit of 4 min")), true);
    await until(() => !alive(job), 3000);
    const [line] = journal(box);
    assert.deepEqual([line.outcome, line.priority, typeof line.warnedAt], ["timed-out", true, "string"]);
});

test("run: the long-run notice fires once", async () => {
    const box = sandbox({ limits: { longRunUnmeasuredMin: 20 } }), release = join(box.work, "release"), d = makeDeps(box);
    const run = settle(runCommand(["run", "--label", "docs-site: build", "--max-run", "50", "--", NODE, "-e", untilFile(release)], box.ctx, d.deps));
    await until(() => slots(box)[0]?.pgid);
    assert.deepEqual(d.clock.advanceTo(19), []);
    assert.equal(existsSync(box.ctx.files.notifyLog), false);
    assert.deepEqual(d.clock.advanceTo(20), [20]);
    for (const minutes of [21, 35, 49]) assert.deepEqual(d.clock.advanceTo(minutes), [], `minute ${minutes}`);
    writeFileSync(release, "");
    assert.equal(await run.result, 0);
    assert.equal(count(d.said, "long run:"), 1);
    assert.equal(d.said.some((line) => line.startsWith('long run: "docs-site: build" of project docs-site, pid ')), true);
    const logged = readFileSync(box.ctx.files.notifyLog, "utf8").split("\n").filter(Boolean);
    assert.deepEqual(logged.map((line) => line.split("\t")[1]), ["dotime: job running long"]);
    const stored = Object.values(readNotices(box.ctx.files.notices));
    assert.deepEqual(stored.map((entry) => [entry.type, entry.label, entry.waiting]), [["long-run", "docs-site: build", []]]);
    assert.equal(typeof journal(box)[0].longRunAt, "string");
});

test("run: a signal while waiting comes back as exit 130 through the return value, with the line cleaned up", async () => {
    const box = sandbox({ slots: 1 }), d = makeDeps(box, { spawn: assert.fail });
    takeSlot(process.pid, "docs-site: build", 1, {}, box.ctx.files);
    const run = settle(runCommand(["run", "--label", "shop-api: lint", "--", NODE, "-e", "console.log('started')"], box.ctx, d.deps));
    await until(() => d.said.some((line) => line.startsWith("in line")));
    d.signals.emit("SIGINT");
    assert.equal(await run.result, EXIT.left);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit, line.signal, line.waitBy]), [["left", 130, "SIGINT", {}]]);
    assert.deepEqual([readdirSync(join(box.home, "line")), d.signals.eventNames()], [[], []]);
});

/** A stand-in for how a process takes a signal: with no listener the process ends at once, as Node's default does,
 *  and with one the listeners present when the code running now has finished receive it, as a real signal is
 *  delivered between steps of the event loop. */
function signalStandIn() {
    const signals = new EventEmitter();
    signals.endedBy = null;
    signals.arrive = (signal) => {
        if (signals.listenerCount(signal) === 0) signals.endedBy = signal;
        else setImmediate(() => signals.emit(signal));
    };
    return signals;
}

test("run: a signal while the commit is read for a job that just got its slot stops the job and frees the slot", async () => {
    const box = sandbox(), signals = signalStandIn();
    let reads = 0;
    const slowGit = (cwd) => {
        if (++reads === 2) signals.arrive("SIGINT");
        return gitState(cwd);
    };
    const d = makeDeps(box, { gitState: slowGit, signals });
    const args = ["run", "--label", "docs-site: build", "--", NODE, "-e", "setTimeout(() => {}, 1500)"];
    const code = await runCommand(args, box.ctx, d.deps);
    assert.equal(signals.endedBy, null, "the signal found no listener and would have ended the process");
    assert.equal(code, 1);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit, line.signal]), [["stopped", 1, "SIGINT"]]);
    assert.deepEqual([slots(box), readdirSync(join(box.home, "line")), signals.eventNames()], [[], [], []]);
});

test("run: a signal while the commit is read for a nested job stops the job and removes its note", async () => {
    const box = nestedBox(), signals = signalStandIn();
    let reads = 0, notesThen = null;
    const slowGit = (cwd) => {
        if (++reads === 2) {
            notesThen = nestedNotes(box).length;
            signals.arrive("SIGINT");
        }
        return gitState(cwd);
    };
    const d = nestedDeps(box, { gitState: slowGit, signals });
    const args = ["run", "--label", "docs-site: unit tests", "--", NODE, "-e", "setTimeout(() => {}, 1500)"];
    const code = await runCommand(args, box.ctx, d.deps);
    assert.equal(notesThen, 1, "the signal came after the nested run was noted");
    assert.equal(signals.endedBy, null, "the signal found no listener and would have ended the process");
    assert.equal(code, 1);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit, line.signal, line.nested]), [["stopped", 1, "SIGINT", true]]);
    assert.deepEqual([nestedNotes(box), signals.eventNames()], [[], []]);
    assert.deepEqual(slots(box).map((slot) => slot.pid), [process.ppid], "the outer job keeps its slot");
});

// ---- skipping a check that already passed on the same clean commit ----

const HEAD = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", OTHER_HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const skippedText = (label, minutes = 0, head = HEAD) =>
    `skipped: "${label}" already passed on commit ${head.slice(0, 8)} (${minutes} min ago); --no-skip runs it anyway`;
/** A job script that counts its runs in a folder of its own, outside the work folder, so the code fingerprint never
 *  changes, and ends with the code set by failWith(), 0 until then. args(label, { flags, tail }) gives the words of
 *  `run`; a tail is one more word for the script and makes another command line. */
function countingJob() {
    const dir = tempDir("run-skip"), runs = join(dir, "runs"), exit = join(dir, "exit"), script = join(dir, "job.js");
    writeFileSync(script, `const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(runs)}, "x"); `
        + `process.exit(fs.existsSync(${JSON.stringify(exit)}) ? Number(fs.readFileSync(${JSON.stringify(exit)}, "utf8")) : 0);\n`);
    return {
        args: (label, { flags = [], tail } = {}) => ["run", "--label", label, ...flags, "--", NODE, script, ...(tail ? [tail] : [])],
        runs: () => (existsSync(runs) ? readFileSync(runs, "utf8").length : 0),
        failWith: (n) => (n ? writeFileSync(exit, String(n)) : rmSync(exit, { force: true })),
    };
}
/** Runs the words with git reporting the given commit and tree for the work folder. nested: with the deps of a run
 *  inside the job that holds the slot. */
async function runAt(box, args, { head = HEAD, clean = true, nested = false, now } = {}) {
    const overrides = { gitState: () => ({ head, clean }), ...(now ? { now } : {}) };
    const d = (nested ? nestedDeps : makeDeps)(box, overrides);
    return { code: await runCommand(args, box.ctx, d.deps), said: d.said, signals: d.signals };
}
const outcomes = (box) => journal(box).map((line) => line.outcome);

test("run: a test check that passed on this clean commit is skipped: exit 0 at once, no slot, no run, one skipped line", async () => {
    const box = sandbox({ slots: 1 }), job = countingJob(), label = "shop-api: unit tests";
    assert.equal((await runAt(box, job.args(label))).code, 0);
    // With the only slot taken, a job that waited for one would give up with exit 75.
    takeSlot(process.pid, "docs-site: build", 1, {}, box.ctx.files);
    const again = await runAt(box, job.args(label, { flags: ["--max-wait", "0.01"] }), { now: () => Date.now() + 7 * MINUTE });
    assert.equal(again.code, 0);
    assert.deepEqual(again.said, [skippedText(label, 7)]);
    assert.equal(job.runs(), 1, "the job ran once");
    const [passed, skipped] = journal(box);
    assert.deepEqual(
        [skipped.outcome, skipped.exit, skipped.label, skipped.cmd, skipped.head, skipped.clean, skipped.kind, skipped.startedAt, skipped.runMin],
        ["skipped", 0, label, passed.cmd, HEAD, true, "test", null, 0],
    );
    assert.deepEqual(skipped.stamp, { head: HEAD, endedAt: passed.endedAt, runMin: passed.runMin }, "the stamp it relied on");
    assert.deepEqual(skipped.waitBy, {});
    assert.deepEqual([slots(box).map((slot) => slot.pid), readdirSync(join(box.home, "line")), again.signals.eventNames()], [[process.pid], [], []]);
});

test("run: no skip with uncommitted changes, on another commit, without a git answer, or for another label or command", async () => {
    for (const [what, label, options, tail] of [
        ["uncommitted changes", "shop-api: unit tests", { clean: false }, null],
        ["another commit", "shop-api: unit tests", { head: OTHER_HEAD }, null],
        ["no git answer", "shop-api: unit tests", { head: null, clean: null }, null],
        ["another label", "shop-api: api tests", {}, null],
        ["another command", "shop-api: unit tests", {}, "--verbose"],
    ]) {
        const box = sandbox(), job = countingJob();
        assert.equal((await runAt(box, job.args("shop-api: unit tests"))).code, 0, what);
        const other = await runAt(box, job.args(label, { tail }), options);
        assert.deepEqual([other.code, other.said, job.runs()], [0, [], 2], what);
        // The first check itself, on its clean commit, is still skipped.
        assert.deepEqual((await runAt(box, job.args("shop-api: unit tests"))).said, [skippedText("shop-api: unit tests")], what);
        assert.deepEqual([outcomes(box), job.runs()], [["ran", "ran", "skipped"], 2], what);
    }
});

test("run: no skip once a file the command names has changed outside git, as the code fingerprint shows", async () => {
    const box = sandbox(), job = countingJob(), label = "shop-api: lint";
    assert.equal((await runAt(box, job.args(label))).code, 0);
    const script = job.args(label).at(-1);
    writeFileSync(script, `${readFileSync(script, "utf8")}// edited\n`);
    const edited = await runAt(box, job.args(label));
    assert.deepEqual([edited.code, edited.said, job.runs()], [0, [], 2]);
    assert.notEqual(journal(box)[1].fp, journal(box)[0].fp);
    // The edited script has passed now, and is skipped on that pass.
    assert.deepEqual((await runAt(box, job.args(label))).said, [skippedText(label)]);
    assert.deepEqual(outcomes(box), ["ran", "ran", "skipped"]);
});

test("run: only test and lint jobs are skipped, by the kind given with --kind when there is one", async () => {
    for (const [label, flags, second] of [
        ["shop-api: build", [], "ran"],
        ["shop-api: deploy to staging", [], "ran"],
        ["shop-api: refresh fixtures", [], "ran"],
        ["shop-api: unit tests", ["--kind", "build"], "ran"],
        ["shop-api: refresh fixtures", ["--kind", "lint"], "skipped"],
        ["shop-api: lint", [], "skipped"],
        ["shop-api: unit tests", [], "skipped"],
    ]) {
        const box = sandbox(), job = countingJob();
        for (let i = 0; i < 2; i++) assert.equal((await runAt(box, job.args(label, { flags }))).code, 0, label);
        assert.deepEqual(outcomes(box), ["ran", second], `${label} ${flags.join(" ")}`);
        assert.equal(job.runs(), second === "ran" ? 2 : 1, label);
    }
});

test("run: no skip after a failed run, while the newest failure on the commit comes after the pass", async () => {
    const box = sandbox(), job = countingJob(), label = "shop-api: unit tests";
    job.failWith(1);
    assert.equal((await runAt(box, job.args(label))).code, 1);
    job.failWith(0);
    assert.equal((await runAt(box, job.args(label))).code, 0, "a run that failed before is no stamp");
    assert.deepEqual((await runAt(box, job.args(label))).said, [skippedText(label)]);
    // A failure on the same commit after the pass, here with uncommitted changes, takes the stamp away.
    job.failWith(1);
    assert.equal((await runAt(box, job.args(label), { clean: false })).code, 1);
    job.failWith(0);
    const after = await runAt(box, job.args(label));
    assert.deepEqual([after.code, after.said], [0, []]);
    assert.deepEqual([outcomes(box), job.runs()], [["ran", "ran", "skipped", "ran", "ran"], 4]);
});

test("run: --no-skip runs a check that already passed, and a failure it finds takes the stamp away", async () => {
    const box = sandbox(), job = countingJob(), label = "shop-api: lint";
    assert.equal((await runAt(box, job.args(label))).code, 0);
    const forced = await runAt(box, job.args(label, { flags: ["--no-skip"] }));
    assert.deepEqual([forced.code, forced.said, job.runs()], [0, [], 2]);
    assert.deepEqual((await runAt(box, job.args(label))).said, [skippedText(label)]);
    assert.equal(journal(box)[2].stamp.endedAt, journal(box)[1].endedAt, "the newest pass is the stamp");
    job.failWith(2);
    assert.equal((await runAt(box, job.args(label, { flags: ["--no-skip"] }))).code, 2);
    job.failWith(0);
    assert.deepEqual((await runAt(box, job.args(label))).said, []);
    assert.deepEqual([outcomes(box), job.runs()], [["ran", "ran", "skipped", "ran", "ran"], 4]);
});

test("run: a skipped line is never a stamp, never a learned-limit sample and never a pass for the repeated-failure stop", async () => {
    const { kindStats, stemStats } = await import("./limits.mjs");
    const box = sandbox(), job = countingJob(), label = "shop-api: unit tests";
    for (let i = 0; i < 6; i++) assert.equal((await runAt(box, job.args(label))).code, 0);
    assert.deepEqual([outcomes(box), job.runs()], [["ran", "skipped", "skipped", "skipped", "skipped", "skipped"], 1]);
    const rows = journal(box), window = { project: rows[0].projectKey, now: Date.now(), windowDays: 30 };
    assert.deepEqual([kindStats(rows, { ...window, kind: "test" }).n, stemStats(rows, { ...window, stem: rows[0].stem }).n], [1, 1]);
    // Without the passing run, the skipped lines alone vouch for nothing.
    writeFileSync(box.ctx.files.journal, readFileSync(box.ctx.files.journal, "utf8").split("\n").slice(1).join("\n"));
    assert.deepEqual((await runAt(box, job.args(label))).said, []);
    assert.equal(job.runs(), 2);

    // Two failures on another commit, with a skip on the passed commit between them, are still two in a row.
    const stop = sandbox(), check = countingJob();
    assert.equal((await runAt(stop, check.args(label))).code, 0);
    check.failWith(4);
    assert.equal((await runAt(stop, check.args(label), { head: OTHER_HEAD })).code, 4);
    assert.deepEqual((await runAt(stop, check.args(label))).said, [skippedText(label)]);
    assert.equal((await runAt(stop, check.args(label), { head: OTHER_HEAD })).code, 4);
    assert.equal((await runAt(stop, check.args(label), { head: OTHER_HEAD })).code, EXIT.refused);
    assert.deepEqual(outcomes(stop), ["ran", "ran", "skipped", "ran", "refused"]);
});

test("run: a nested run is skipped by the same rules, without waiting for a place, and journalled as nested", async () => {
    const { box, blocker } = fullPlacesBox(), job = countingJob(), label = "docs-site: unit tests";
    rmSync(blocker);
    const first = await runAt(box, job.args(label), { nested: true });
    assert.equal(first.code, 0);
    assert.equal(first.said[0].startsWith('nested: inside "docs-site: test suite"'), true, first.said[0]);
    // With the one place under the parent taken again, a nested run that did not skip would give up with exit 75.
    const [slotName] = readdirSync(join(box.home, "slots")), slot = join(box.home, "slots", slotName);
    const key = placeKey({ file: slot, born: JSON.parse(readFileSync(slot, "utf8")).born });
    const held = takePlace(process.ppid, "docs-site: lint", key, 1, box.ctx.files);
    assert.equal(typeof held, "string");
    const again = await runAt(box, job.args(label, { flags: ["--max-wait", "0.01"] }), { nested: true });
    assert.deepEqual([again.code, again.said, job.runs()], [0, [skippedText(label)], 1]);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.nested]), [["ran", true], ["skipped", true]]);
    assert.deepEqual([nestedNotes(box), places(box), again.signals.eventNames()], [[], [held.split("/").at(-1)], []]);
    rmSync(held);
    const dirty = await runAt(box, job.args(label), { nested: true, clean: false });
    assert.deepEqual([dirty.code, job.runs(), outcomes(box).at(-1)], [0, 2, "ran"], "a nested run with changes runs");
});
