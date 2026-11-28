// Runs cut off by a restart or a dead queue process. The first tests drive the claim and the journal line in this
// process with slot files written by hand; the last ones start the real cli.mjs, kill the run, its wrapper and the
// job with KILL as a restart would, and read the journal that `status` leaves.
import { cleanEnv, isolateProcess, pause, tempDir, track, until } from "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

isolateProcess("lost");
const { claimBase, claimPending, finishAbandoned, freeBroken, isLost, lostRow, recordLost, rerunOfEnv } = await import("./lost.mjs");
const { processGone, snapshot } = await import("./slots.mjs");
const { sameProcess } = await import("./proctree.mjs");
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

test("recordLost: a slot taken again by a newer holder between the read and the claim is left to it", () => {
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
    const claim = join(files.lost, `${claimBase(JSON.parse(readFileSync(file, "utf8")))}.claim`);
    renameSync(file, claim);
    assert.equal(claimPending(files, 4247), true);
    assert.deepEqual(finishAbandoned(files, Date.now()), [], "a young claim is a claimer still at work");
    const rows = finishAbandoned(files, Date.now() + 61_000);
    assert.deepEqual(rows.map((r) => [r.outcome, r.pid]), [["lost", 4247]]);
    assert.equal(claimPending(files, 4247), false);
    assert.deepEqual(finishAbandoned(files, Date.now() + 120_000), []);
    assert.equal(rowsOf(files.journal).length, 1);
});

test("recordLost: a claimer paused just before its line keeps its claim; a finisher never takes a done claim over", () => {
    const files = home();
    const { file, entry } = putSlot(files, 0, 4248);
    let taken = null;
    const row = recordLost(file, entry, files, T0 + 60_000, { beforeAppend: () => { taken = finishAbandoned(files, Date.now() + 61_000); } });
    assert.deepEqual(taken, [], "the claim was done already, so the finisher left it");
    assert.deepEqual(rowsOf(files.journal), [row]);
    assert.deepEqual(readdirSync(files.lost), []);
});

test("recordLost: a line that could not be written keeps the claim, and the next finder writes it", () => {
    const files = home();
    const { file, entry } = putSlot(files, 0, 4249);
    mkdirSync(files.journal);
    assert.equal(recordLost(file, entry, files, T0 + 60_000), null);
    assert.equal(existsSync(file), false, "the slot is free");
    assert.equal(claimPending(files, 4249), true, "the claim is kept");
    renameSync(files.journal, `${files.journal}.not`);
    const rows = finishAbandoned(files, Date.now() + 61_000);
    assert.deepEqual(rows.map((r) => [r.outcome, r.pid]), [["lost", 4249]]);
    assert.deepEqual(rowsOf(files.journal), rows);
    assert.deepEqual(readdirSync(files.lost), []);
});

test("recordLost: a finder with an old reading of a slot leaves the newer holder's file where it is, the same file", () => {
    const files = home();
    const dead = putSlot(files, 0, 4250);
    assert.equal(recordLost(dead.file, dead.entry, files, T0 + 60_000)?.outcome, "lost");
    const live = putSlot(files, 0, 4251);
    const before = statSync(live.file).ino;
    assert.equal(recordLost(dead.file, dead.entry, files, T0 + 61_000), null);
    assert.equal(statSync(live.file).ino, before);
    assert.deepEqual(readdirSync(files.lost), []);
    assert.equal(rowsOf(files.journal).length, 1);
});

test("freeBroken: a slot file that cannot be read goes only once it is old; a young or readable one stays", () => {
    const files = home();
    mkdirSync(files.slots, { recursive: true });
    const slot = join(files.slots, "slot-0.json");
    writeFileSync(slot, "{ cut");
    snapshot({ dirs: files, prune: true });
    assert.equal(existsSync(slot), true, "a young file may be a holder's that was just taken");
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(slot, old, old);
    snapshot({ dirs: files, prune: true });
    assert.equal(existsSync(slot), false);
    writeFileSync(slot, JSON.stringify({ pid: process.pid, label: "shop-api: unit tests", at: 1 }));
    utimesSync(slot, old, old);
    freeBroken(slot, files.lost);
    assert.equal(existsSync(slot), true, "a file that reads whole now is a holder's");
    assert.deepEqual(readdirSync(files.lost), []);
});

test("snapshot: after the wall clock is set, a live holder whose age alone disagrees is kept while its job's group lives", () => {
    const files = home();
    const { entry } = putSlot(files, 0, 4252);
    // ps says the process started an hour later than its slot says, as after the clock was set back an hour on Linux.
    const shifted = { isAlive: () => true, ages: (pids) => new Map(pids.map((pid) => [pid, 1])), now: entry.born + 3_600_000 + 1000 };
    const groups = [];
    const kept = snapshot({ dirs: files, ...shifted, hasGroup: (pgid) => (groups.push(pgid), true) });
    assert.deepEqual([kept.holders.map((h) => h.pid), groups, rowsOf(files.journal).length], [[4252], [4253], 0]);
    assert.equal(processGone(entry, { ...shifted, hasGroup: () => true }), false);
    assert.equal(processGone(entry, { ...shifted, hasGroup: () => false }), true);
    const gone = snapshot({ dirs: files, ...shifted, hasGroup: () => false });
    assert.deepEqual([gone.holders.length, rowsOf(files.journal).map((r) => r.outcome)], [0, ["lost"]], "with its group gone it was reused");
});

test("sameProcess: a live pid whose age alone disagrees is the same process while its group lives, never when strict", () => {
    const at = Date.UTC(2031, 4, 6, 10, 0);
    const opts = { isAlive: () => true, ages: () => new Map([[4300, 1]]), now: at + 3_600_000 };
    assert.equal(sameProcess(4300, at, opts), false, "no group given: reused");
    assert.equal(sameProcess(4300, at, { ...opts, group: 4300, hasGroup: () => true }), true);
    assert.equal(sameProcess(4300, at, { ...opts, group: 4300, hasGroup: () => false }), false);
    assert.equal(sameProcess(4300, at, { ...opts, group: 4300, hasGroup: () => true, strict: true }), false);
    assert.equal(sameProcess(4300, at, { ...opts, ages: () => new Map([[4300, 3600]]) }), true, "an age that agrees");
});

test("claim race: finders with old readings of dead holders, in a loop, never free the slot of a live holder", async () => {
    const files = home();
    mkdirSync(files.slots, { recursive: true });
    const dead = deadPid();
    const slot = join(files.slots, "slot-0.json");
    const deadline = Date.now() + 2500;
    const lostUrl = JSON.stringify(new URL("./lost.mjs", import.meta.url).href);
    const slotsUrl = JSON.stringify(new URL("./slots.mjs", import.meta.url).href);
    // The holder puts a dead holder's file in the slot, waits until a finder frees it, takes the slot itself and
    // checks while it holds it that its file stays.
    const holder = `import fs from "node:fs";
        const slot = ${JSON.stringify(slot)}, temp = slot + ".tmp-h"; let holds = 0, stolen = 0, k = 0;
        const put = (entry) => { fs.writeFileSync(temp, JSON.stringify(entry)); try { fs.linkSync(temp, slot); return true; }
            catch { return false; } finally { fs.rmSync(temp, { force: true }); } };
        while (Date.now() < ${deadline}) {
            k++;
            put({ pid: ${dead}, born: 1000, at: k, label: "shop-api: unit tests", ...(k % 2 ? { pgid: ${dead}, startedAt: k } : {}) });
            const by = Date.now() + 200; while (fs.existsSync(slot) && Date.now() < by) { /* a finder frees it */ }
            if (!put({ pid: process.pid, born: 2000, at: k, label: "shop-api: live" })) continue;
            holds++;
            let ino = null; try { ino = fs.statSync(slot).ino; } catch { stolen++; continue; }
            for (let i = 0; i < 300; i++) { let now = null; try { now = fs.statSync(slot).ino; } catch {} if (now !== ino) { stolen++; break; } }
            try { if (fs.statSync(slot).ino === ino) fs.rmSync(slot); } catch {}
        }
        console.log(JSON.stringify({ holds, stolen }));`;
    // A finder takes fresh readings, as status and run do, and also tries again the dead holders it read before.
    const finder = `import fs from "node:fs"; const { recordLost } = await import(${lostUrl}); const { snapshot } = await import(${slotsUrl});
        const dirs = ${JSON.stringify(files)}, slot = ${JSON.stringify(slot)}; const seen = []; let claims = 0;
        while (Date.now() < ${deadline}) {
            let entry = null; try { entry = JSON.parse(fs.readFileSync(slot, "utf8")); } catch {}
            if (entry?.pid === ${dead}) seen.push(entry);
            if (seen.length) { recordLost(slot, seen[Math.floor(Math.random() * seen.length)], dirs); claims++; }
            snapshot({ dirs, prune: true, ages: () => new Map() }); claims++;
        }
        console.log(JSON.stringify({ claims }));`;
    const start = (script) => {
        const child = track(spawn(NODE, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] }));
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        return new Promise((done) => child.on("exit", () => done(JSON.parse(out))));
    };
    const [held, ...found] = await Promise.all([start(holder), start(finder), start(finder)]);
    const claims = found.reduce((sum, f) => sum + f.claims, 0);
    process.stdout.write(`# claim race: ${held.stolen} stolen of ${held.holds} live holds, ${claims} claims\n`);
    assert.ok(held.holds > 20 && claims > 1000, JSON.stringify({ held, claims }));
    assert.equal(held.stolen, 0);
    const rows = rowsOf(files.journal);
    const dup = rows.filter((r, i) => rows.findIndex((o) => o.startedAt === r.startedAt) !== i);
    assert.deepEqual(dup, [], "one lost line per run");
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

test("acceptance: status during a live run writes no line and moves no file", async () => {
    const box = realHome(2);
    const run = await startSleeper(box, "unit tests");
    const look = () => readdirSync(box.files.slots).map((n) => {
        const file = join(box.files.slots, n);
        return [n, statSync(file).ino, readFileSync(file, "utf8")];
    });
    const before = look();
    await runStatus(box);
    await runStatus(box);
    assert.deepEqual(look(), before);
    assert.deepEqual(rowsOf(box.files.journal), []);
    assert.deepEqual(existsSync(box.files.lost) ? readdirSync(box.files.lost) : [], []);
    cutOff(run);
});

test("finishAbandoned: a stale claim named after a dead run but holding another holder's entry is removed, never journalled", () => {
    const files = home();
    const { file } = putSlot(files, 0, 4247);
    mkdirSync(files.lost, { recursive: true });
    const claim = join(files.lost, "9999-slot-0-1-ffff.claim");
    renameSync(file, claim);
    assert.deepEqual(finishAbandoned(files, Date.now() + 61_000), []);
    assert.deepEqual(readdirSync(files.lost), []);
    assert.deepEqual(rowsOf(files.journal), []);
});
