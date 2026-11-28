// Runs cut off by a restart or a dead queue process. The first tests drive the claim and the journal line in this
// process with slot files written by hand; the last ones start the real cli.mjs, kill the run, its wrapper and the
// job with KILL as a restart would, and read the journal that `status` leaves.
import { cleanEnv, isolateProcess, pause, tempDir, track, until } from "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

isolateProcess("lost");
const { claimPending, finishAbandoned, isLost, lostRow, recordLost, rerunOfEnv } = await import("./lost.mjs");
const { snapshot } = await import("./slots.mjs");
const { paths, DEFAULTS } = await import("./settings.mjs");
const { failStop } = await import("./failstop.mjs");
const { flakyChecks } = await import("./flaky.mjs");
const { kindStats } = await import("./limits.mjs");
const { skipStamp, summarize } = await import("./journal.mjs");
const { reasonsLines, reasonsReport } = await import("./reasons.mjs");
const { historyRow } = await import("./cli.mjs");

const NODE = process.execPath;
const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const WIDE_OPEN = { loadPerCore: 1000, minFreeMemPct: 0, minFreeDiskGB: 0, minBatteryPct: 0 };
const T0 = Date.UTC(2031, 4, 6, 10, 0);
const iso = (ms) => new Date(ms).toISOString();
const rowsOf = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A pid that has just ended. */
const deadPid = () => Number(spawnSync(NODE, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout);

/** A slot file as `run` leaves it once its command has started; started: false leaves out the start. */
function putSlot(files, n, pid, { started = true, more = {} } = {}) {
    mkdirSync(files.slots, { recursive: true });
    const run = {
        label: "shop-api: unit tests", project: "shop-api", cwd: "/srv/shop-api", priority: false, queuedAt: T0, startedAt: T0 + 2000,
        cmd: "npm test", head: "ab12cd34ef", clean: true, tally: { slots: 2000 }, extra: { pid, kind: "test", ...more },
    };
    const entry = {
        pid, label: run.label, at: T0 + 1000, born: T0 - 5000, kind: "test", project: "shop-api", cwd: run.cwd,
        ...(started ? { pgid: pid + 1, startedAt: T0 + 2000, run } : {}),
    };
    const file = join(files.slots, `slot-${n}.json`);
    writeFileSync(file, JSON.stringify(entry));
    return { file, entry };
}
const home = () => paths({ DOTIME_HOME: tempDir("lost-home") });

test("recordLost: a started run whose holder is gone gets one lost line with what its slot knew, and its slot goes", () => {
    const files = home();
    const { file, entry } = putSlot(files, 0, 4242, { more: { isolate: { id: "0a1b2c3d", path: "/srv/wt/0a1b2c3d", branch: "dotime/0a1b2c3d" } } });
    const row = recordLost(file, entry, files, T0 + 60_000);
    assert.equal(existsSync(file), false);
    assert.deepEqual(rowsOf(files.journal), [row]);
    assert.deepEqual(
        [row.outcome, row.exit, row.label, row.project, row.cwd, row.cmd, row.head, row.clean, row.pid, row.kind],
        ["lost", null, "shop-api: unit tests", "shop-api", "/srv/shop-api", "npm test", "ab12cd34ef", true, 4242, "test"],
    );
    assert.deepEqual([row.queuedAt, row.startedAt, row.endedAt, row.runMin], [iso(T0), iso(T0 + 2000), iso(T0 + 60_000), 1]);
    assert.deepEqual(row.reason, { class: "lost", source: "slot" });
    assert.deepEqual(row.isolate, { id: "0a1b2c3d", path: "/srv/wt/0a1b2c3d", branch: "dotime/0a1b2c3d" }, "the kept worktree is named");
    assert.equal(recordLost(file, entry, files, T0 + 61_000), null, "a second claim finds nothing");
    assert.equal(rowsOf(files.journal).length, 1);
    assert.deepEqual(readdirSync(files.lost), [], "no claim is left behind");
});

test("recordLost: no line for a holder that never started, nor for a run that has its own line already", () => {
    const files = home();
    const waiting = putSlot(files, 0, 4243, { started: false });
    assert.equal(recordLost(waiting.file, waiting.entry, files, T0 + 60_000), null);
    const ended = putSlot(files, 1, 4244);
    writeFileSync(files.journal, `${JSON.stringify({ pid: 4244, startedAt: iso(T0 + 2000), outcome: "ran", exit: 0 })}\n`);
    assert.equal(recordLost(ended.file, ended.entry, files, T0 + 60_000), null, "the run wrote its line and died before it freed its slot");
    assert.equal(rowsOf(files.journal).length, 1);
});

test("recordLost: a slot taken again by a newer holder between the read and the claim is given back to it", () => {
    const files = home();
    const old = putSlot(files, 0, 4245);
    const newer = putSlot(files, 0, 4246);
    assert.equal(recordLost(old.file, old.entry, files, T0 + 60_000), null);
    assert.deepEqual(JSON.parse(readFileSync(newer.file, "utf8")), newer.entry);
    assert.deepEqual(rowsOf(files.journal), []);
});

test("finishAbandoned: a claim left by a claimer that died is finished once it is a minute old, and never twice", () => {
    const files = home();
    const { file } = putSlot(files, 0, 4247);
    mkdirSync(files.lost, { recursive: true });
    const claim = join(files.lost, `4247-slot-0-1-ffff.claim`);
    renameSync(file, claim);
    assert.equal(claimPending(files, 4247), true);
    assert.deepEqual(finishAbandoned(files, Date.now()), [], "a young claim is a claimer still at work");
    const rows = finishAbandoned(files, Date.now() + 61_000);
    assert.deepEqual(rows.map((r) => [r.outcome, r.pid]), [["lost", 4247]]);
    assert.equal(claimPending(files, 4247), false);
    assert.deepEqual(finishAbandoned(files, Date.now() + 120_000), []);
    assert.equal(rowsOf(files.journal).length, 1);
});

test("snapshot: status and other readers record a lost run; the reaper's dry run, with lost false, does not", () => {
    const files = home();
    const pid = deadPid();
    putSlot(files, 0, pid);
    const dry = snapshot({ dirs: files, lost: false });
    assert.deepEqual([dry.holders.length, rowsOf(files.journal).length], [0, 0]);
    assert.equal(existsSync(join(files.slots, "slot-0.json")), true);
    snapshot({ dirs: files });
    assert.deepEqual(rowsOf(files.journal).map((r) => [r.outcome, r.pid]), [["lost", pid]]);
    assert.equal(existsSync(join(files.slots, "slot-0.json")), false);
    snapshot({ dirs: files, prune: true });
    assert.equal(rowsOf(files.journal).length, 1);
});

test("snapshot: many readers at the same moment write one line per lost run", async () => {
    const files = home();
    const pids = [deadPid(), deadPid(), deadPid()];
    pids.forEach((pid, n) => putSlot(files, n, pid));
    const script = `const { snapshot } = await import(${JSON.stringify(new URL("./slots.mjs", import.meta.url).href)});`
        + `snapshot({ dirs: ${JSON.stringify(files)} });`;
    const readers = Array.from({ length: 6 }, () => track(spawn(NODE, ["--input-type=module", "-e", script], { stdio: "ignore" })));
    await Promise.all(readers.map((child) => new Promise((done) => child.on("exit", done))));
    const rows = rowsOf(files.journal);
    assert.deepEqual(rows.map((r) => r.pid).sort(), [...pids].sort());
});

test("lost lines are no failure: the repeated-failure stop, the flaky flag, run limits and pass stamps never count them", () => {
    const check = { label: "shop-api: unit tests", cmd: "npm test", project: "shop-api", cwd: "/srv/shop-api", head: "ab12cd34ef" };
    const draft = (n) => ({
        label: check.label, project: "shop-api", cwd: check.cwd, priority: false, queuedAt: T0 + n * 60_000,
        startedAt: T0 + n * 60_000, cmd: check.cmd, head: check.head, clean: true, extra: { pid: 100 + n, kind: "test", fp: "f00d" },
    });
    const lost = [1, 2, 3].map((n) => JSON.stringify(lostRow(draft(n), T0 + n * 60_000 + 30_000, "slot")));
    const at = T0 + 10 * 60_000;
    assert.equal(failStop(lost, { ...check, fingerprint: "f00d", at }, DEFAULTS.limits, "UTC").refuse, false);
    assert.deepEqual(flakyChecks(lost, { now: at }), []);
    assert.equal(kindStats(lost, { project: "shop-api", kind: "test", now: at, windowDays: 30 }).n ?? 0, 0);
    const pass = JSON.stringify({ ...lostRow(draft(0), T0 + 30_000, "slot"), outcome: "ran", exit: 0, reason: undefined });
    const folder = { project: "shop-api", head: check.head, clean: true };
    const job = { label: check.label, cmd: check.cmd, cwd: check.cwd, fp: "f00d" };
    assert.notEqual(skipStamp([pass, ...lost], folder, job, { tz: "UTC", at }), null, "a lost run after a pass takes no stamp away");
    assert.equal(skipStamp(lost, folder, job, { tz: "UTC", at }), null, "and gives none");
    assert.equal(isLost(JSON.parse(lost[0])), true);
});

test("history counts lost runs, and reasons gives them a line of their own outside every class", () => {
    const draft = { label: "shop-api: unit tests", project: "shop-api", cwd: "/srv/shop-api", queuedAt: T0, startedAt: T0, extra: { pid: 9 } };
    const lines = [JSON.stringify(lostRow(draft, T0 + 60_000, "slot")), JSON.stringify(lostRow({ ...draft, extra: { pid: 10 } }, T0 + 90_000, "tick"))];
    const { all } = summarize(lines, T0 - 1, T0 + 120_000);
    assert.deepEqual([all.jobs, all.lost, all.failed], [2, 2, 0]);
    assert.match(historyRow("all projects", all), /^all projects: jobs 2, failed 0, stopped 0, timed out 0, refused 0, gave up 0, lost 2, flaky 0/);
    const report = reasonsReport(lines, { now: T0 + 120_000 });
    assert.deepEqual([report.lost, report.classes, report.total.failures], [2, [], 0]);
    assert.deepEqual(reasonsLines(report), ["reasons: no failures in 7 days", "lost: 2 runs cut off by a restart or a dead queue process"]);
    assert.deepEqual(reasonsLines(reasonsReport([], { now: T0 })), ["reasons: no failures in 7 days"]);
});

test("rerunOfEnv: only a job id counts", () => {
    assert.equal(rerunOfEnv({ DOTIME_RERUN_OF: "ab".repeat(12) }), "ab".repeat(12));
    assert.equal(rerunOfEnv({ DOTIME_RERUN_OF: "../x" }), null);
    assert.equal(rerunOfEnv({}), null);
});

// ---- the real command, cut off as a restart would ----

function realHome(slots) {
    const dir = tempDir("lost-real-home");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ pollMs: 60, slots, health: WIDE_OPEN, limits: { killGraceMs: 250 } }));
    return { dir, env: cleanEnv(dir), files: paths({ DOTIME_HOME: dir }) };
}

/** Starts a run of a job that sleeps for a minute and gives its slot file once the job has started. */
async function startSleeper(box, name) {
    const words = [CLI, "run", "--label", `shop-api: ${name}`, "--", NODE, "-e", "setTimeout(() => {}, 60000)"];
    const child = track(spawn(NODE, words, { env: box.env, cwd: box.dir, stdio: "ignore" }));
    let slot = null;
    await until(() => {
        const names = existsSync(box.files.slots) ? readdirSync(box.files.slots).filter((n) => n.endsWith(".json")) : [];
        for (const n of names) {
            const entry = JSON.parse(readFileSync(join(box.files.slots, n), "utf8"));
            if (entry.pid === child.pid && entry.startedAt && entry.run) slot = entry;
        }
        return slot;
    }, 20_000);
    track(slot.pgid, { group: true });
    return { child, slot };
}
/** KILL to the run, and to the wrapper and the job in their process group, as a restart would. */
function cutOff({ child, slot }) {
    process.kill(child.pid, "SIGKILL");
    try { process.kill(-slot.pgid, "SIGKILL"); } catch { /* already gone */ }
}
const runStatus = (box) => new Promise((done) => {
    const child = track(spawn(NODE, [CLI, "status"], { env: box.env, stdio: "ignore" }));
    child.on("exit", done);
});

test("acceptance: a run killed with its wrapper and job gets one lost line from the next status, and a slot free again", async () => {
    const box = realHome(1);
    const run = await startSleeper(box, "unit tests");
    cutOff(run);
    await until(() => spawnSync("kill", ["-0", String(run.child.pid)]).status !== 0);
    await pause(50);
    await runStatus(box);
    const rows = rowsOf(box.files.journal);
    assert.deepEqual(rows.map((r) => [r.outcome, r.label, r.pid, r.reason?.class]), [["lost", "shop-api: unit tests", run.child.pid, "lost"]]);
    assert.equal(rows[0].startedAt, iso(run.slot.startedAt));
    assert.match(rows[0].cmd, /setTimeout/);
    const history = spawnSync(NODE, [CLI, "history", "--days", "1"], { env: box.env, encoding: "utf8" });
    assert.match(history.stdout, /all projects: jobs 1, failed 0, stopped 0, timed out 0, refused 0, gave up 0, lost 1,/);
    const reasons = spawnSync(NODE, [CLI, "reasons"], { env: box.env, encoding: "utf8" });
    assert.match(reasons.stdout, /^lost: 1 run cut off by a restart or a dead queue process$/m);
    const next = spawnSync(NODE, [CLI, "run", "--label", "shop-api: unit tests", "--", NODE, "-e", "0"], { env: box.env, encoding: "utf8" });
    assert.equal(next.status, 0, next.stderr);
});

test("acceptance: four runs cut off at once and three status calls at the same moment give exactly four lost lines", async () => {
    const box = realHome(4);
    const runs = [];
    for (const n of [1, 2, 3, 4]) runs.push(await startSleeper(box, `shard ${n}`));
    for (const run of runs) cutOff(run);
    await until(() => runs.every((run) => spawnSync("kill", ["-0", String(run.child.pid)]).status !== 0));
    await Promise.all([runStatus(box), runStatus(box), runStatus(box)]);
    const rows = rowsOf(box.files.journal);
    assert.deepEqual(rows.map((r) => r.pid).sort(), runs.map((r) => r.child.pid).sort());
    assert.equal(rows.every((r) => r.outcome === "lost"), true);
});
