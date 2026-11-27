// The steps of `run`, driven in this process: a made-up health reading, a clock that moves only when a test moves it,
// and a timer in minutes that the test fires by hand. Jobs are real processes started through the real wrapper;
// signals go only to processes started here, and a stand-in takes the signal handlers instead of this process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { isolateProcess, readNotices, tempDir, track, until } from "./testkit.mjs";

isolateProcess("run");
const { EXIT, journalWriter, planJob, realDeps, runCommand, runJob, waitForSlot } = await import("./run.mjs");
const { cmdStatus } = await import("./cli.mjs");
const { DEFAULTS, paths } = await import("./settings.mjs");
const { alive } = await import("./proctree.mjs");
const { enqueue, takeSlot } = await import("./slots.mjs");
const { notify } = await import("./notify.mjs");
const { addNotice } = await import("./notices.mjs");
const { gitState } = await import("./git.mjs");

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
 *  marks it fired, so a test can see that a moment was reached and nothing was due. */
function fakeMinutes() {
    const timers = [];
    return {
        after: (min, fn) => { timers.push({ min, fn, fired: false }); return null; },
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
        later: (ms, fn) => setTimeout(fn, ms).unref(), kill: (pid, signal) => process.kill(pid, signal),
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

test("waitForSlot: leaves the line when a signal asks for it", async () => {
    const box = sandbox({ slots: 1 }), clock = fakeClock();
    takeSlot(process.pid, "docs-site: build", 1, {}, box.ctx.files);
    let leaving = null;
    const sleep = async (ms) => { await clock.sleep(ms); leaving = "SIGTERM"; };
    const got = await waitForSlot(waiter(box), { now: clock.now, sleep, readHealth: () => CALM, say: () => {}, leaving: () => leaving });
    assert.deepEqual(got, { left: "SIGTERM", tally: { slots: 60 } });
});

// ---- realDeps ----

test("realDeps: the real command reads git and stores notices through the same deps the tests replace", () => {
    const real = realDeps({ readHealth: () => CALM, notify: () => {}, after: () => null });
    assert.deepEqual([real.gitState, real.addNotice, real.signals], [gitState, addNotice, process]);
});

// ---- journalWriter ----

test("journalWriter: note() fills in the start, commit and wait, and finish() writes one line", () => {
    const box = sandbox();
    const writer = journalWriter({
        label: "docs-site: build", folder: "docs-site", cwd: box.work, priority: false, queuedAt: NOW,
        command: "pnpm run build", details: { kind: "build" }, file: box.ctx.files.journal, now: () => NOW + 3 * MINUTE,
    });
    writer.note({ commit: { head: "ab12cd34ef", clean: true }, tally: { slots: 60_000 } });
    writer.note({ startedAt: NOW + MINUTE });
    writer.finish("ran", 0);
    writer.finish("ran", 1);
    const lines = journal(box);
    assert.deepEqual(lines.map((line) => [line.outcome, line.exit, line.head, line.clean, line.waitBy.slots, line.runMin]), [
        ["ran", 0, "ab12cd34ef", true, 1, 2],
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
    assert.deepEqual([slots(box), job.clock.pending, job.signals.eventNames()], [[], [30], []]);
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
    const d = makeDeps(box, { later: (ms, fn) => timers.push({ ms, fn }), kill: refuse });
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
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit, line.signal]), [["left", 130, "SIGINT"]]);
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
