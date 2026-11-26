// The end-to-end tests start the real cli.mjs. Each one gets its own state folder inside the temp folder, a made-up
// health reading, short timers from that folder's config.json, and notices that go to the log file only. Signals are
// sent only to processes started here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv, isolateProcess, makeRepo, pause, settingEnv, tempDir, track, until } from "./testkit.mjs";

isolateProcess("cli");
const { historyRow, main, statusLines } = await import("./cli.mjs");
const { USAGE } = await import("./args.mjs");
const { takeSlot } = await import("./slots.mjs");
const { alive } = await import("./proctree.mjs");
const { DEFAULTS } = await import("./settings.mjs");

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url)), NODE = process.execPath, MINUTE = 60_000;
const CALM = { load: 0.4, cores: 4, freePct: 70, diskGB: 150, battery: null };

function sandbox({ config = {}, health = CALM, env = {} } = {}) {
    const home = tempDir("cli-home"), work = tempDir("cli-work");
    writeFileSync(join(home, "config.json"), JSON.stringify({ pollMs: 60, ...config, limits: { killGraceMs: 250, orphanCheckMs: 80, ...config.limits } }));
    return { home, work, env: cleanEnv(home, { DOTIME_FAKE_HEALTH: JSON.stringify(health), ...env }), clock: join(home, "fake-minutes") };
}
function start(box, args, { cwd = box.work, env = box.env } = {}) {
    const child = track(spawn(NODE, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] }));
    const seen = { stdout: "", stderr: "" };
    child.stdout.on("data", (text) => { seen.stdout += text; });
    child.stderr.on("data", (text) => { seen.stderr += text; });
    return { child, seen, done: new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, ...seen }))) };
}
const cli = (box, args, options) => start(box, args, options).done;
const withClock = (box) => ({ env: { ...box.env, DOTIME_FAKE_CLOCK: box.clock } });
const journal = (box) => { try { return readFileSync(join(box.home, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
const slots = (box) => { try { return readdirSync(join(box.home, "slots")).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(box.home, "slots", name), "utf8"))); } catch { return []; } };
const count = (text, part) => text.split(part).length - 1;

// Job scripts, run with `node -e`.
const FOREVER = "setInterval(() => {}, 1000)";
const untilFile = (file) => `const fs = require("node:fs"); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(file)})) { clearInterval(t); } }, 20);`;
const savePid = (file) => `require("node:fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); ${FOREVER}`;
const withChild = (file) => `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(FOREVER)}], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(file)}, String(c.pid)); ${FOREVER}`;
const pidIn = (file) => Number(readFileSync(file, "utf8"));

// ---- functions ----

test("main: returns the exit code of each command instead of ending the process", async () => {
    assert.equal(await main(["run", "--label", "docs-site: build"]), 2);
    assert.equal(await main(["history", "--days", "abc"]), 2);
    assert.equal(await main(["passed", "--mach", "lint"]), 2);
    assert.equal(await main(["history", "--day", "2040-01-01"]), 0);
});

test("statusLines: one line per running job, per waiting job and for the gate", () => {
    const now = Date.UTC(2031, 5, 9, 10, 0);
    const holders = [
        { label: "docs-site: build", pid: 3101, startedAt: now - 23 * MINUTE, kind: "build", limitMin: 30, killMin: 30, longRunMin: 20 },
        { label: "mobile-app: store upload", pid: 3102, startedAt: now - 9 * MINUTE, kind: "deploy", limitMin: 12, killMin: 24, longRunMin: 20, priority: true },
        { label: "shop-api: lint", pid: 3103, at: now - 2 * MINUTE },
    ];
    const queue = [{ label: "shop-api: integration suite", pid: 3104, at: now - 6 * MINUTE, priority: true }, { label: "docs-site: link check", pid: 3105, at: now - 30_000 }];
    assert.deepEqual(statusLines({ holders, queue, gate: "no free slot: 3 of 3 taken", max: 3, now }), [
        "slots: 3 of 3 taken, 2 waiting",
        'running "docs-site: build": pid 3101, kind build, 23 min so far, limit 30 min, 7 min left, past the 20 min long-run mark',
        'running "mobile-app: store upload": pid 3102, kind deploy, 9 min so far, limit 12 min, priority (warning at 12 min, stop at 24 min), 15 min left',
        'running "shop-api: lint": pid 3103, 2 min so far, limit unknown',
        'waiting 1 "shop-api: integration suite": pid 3104, 6 min so far, priority',
        'waiting 2 "docs-site: link check": pid 3105, 1 min so far',
        "gate: shut; no free slot: 3 of 3 taken",
    ]);
});

test("statusLines: an empty queue with an open gate", () => {
    assert.deepEqual(statusLines({ holders: [], queue: [], gate: "", max: 2 }), ["slots: 0 of 2 taken, 0 waiting", "gate: open"]);
});

test("historyRow: how jobs ended, then how long they waited, then what held them back", () => {
    const totals = { jobs: 9, waited: 4, waitMinTotal: 31.5, waitWallMin: 18, blockedOnlyMin: 2.5, waitMedian: 0.5, waitP90: 11, gaveUp: 1, failed: 2, stopped: 0, timedOut: 1, refused: 3, waitBy: { slots: 27, disk: 4.5 } };
    assert.equal(historyRow("shop-api", totals), "shop-api: jobs 9, failed 2, stopped 0, timed out 1, refused 3, gave up 1; waited: jobs 4, sum 31.5 min, clock 18 min, clock with no job running 2.5 min, median 0.5 min, p90 11 min; held by: slots 27 min, disk 4.5 min");
    assert.equal(historyRow("docs-site", { ...totals, waitBy: {} }).endsWith("; held by: nothing"), true);
});

// ---- end to end ----

test("run: passes the job's output and exit code through and writes one journal line", async () => {
    const box = sandbox();
    const result = await cli(box, ["run", "--label", "mobile-app: bundle", "--", NODE, "-e", "console.log('bundled'); console.error('1 warning'); process.exit(4)"]);
    assert.deepEqual([result.code, result.stdout, result.stderr], [4, "bundled\n", "1 warning\n"]);
    const lines = journal(box);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0].outcome, lines[0].exit, lines[0].projectKey, lines[0].kind, lines[0].limitMin, lines[0].priority], ["ran", 4, "mobile-app", "build", DEFAULTS.limits.defaultMin, false]);
    assert.deepEqual([slots(box), readdirSync(join(box.home, "line"))], [[], []]);
});

test("run: a job that ends by SIGUSR1 exits 158 and opens no debugger on the way", async () => {
    const box = sandbox();
    const result = await cli(box, ["run", "--label", "shop-api: suite", "--", "/bin/sh", "-c", "kill -USR1 $$"]);
    assert.equal(result.code, 158);
    assert.equal(result.stderr.includes("Debugger"), false);
});

test("run: a job that ends by a signal Node does not die by exits with 128 plus its number", async () => {
    const result = await cli(sandbox(), ["run", "--label", "shop-api: suite", "--", "/bin/sh", "-c", "kill -PIPE $$"]);
    assert.equal(result.code, 141);
});

test("run: a run limit longer than one timer can hold does not stop the job early", async () => {
    const box = sandbox();
    const result = await cli(box, ["run", "--max-run", "99999", "--label", "shop-api: suite", "--", NODE, "-e", "setTimeout(() => {}, 300)"]);
    assert.equal(result.code, 0);
    assert.equal(journal(box)[0].outcome, "ran");
});

test("run: a job without a label still runs", async () => {
    const box = sandbox();
    assert.equal((await cli(box, ["run", "--", NODE, "-e", "process.exit(0)"])).code, 0);
    assert.equal(journal(box)[0].label, "unnamed");
});

test("run: with the only slot taken, the next job waits, says why, and starts when the slot is free", async () => {
    const box = sandbox({ config: { slots: 1 } }), release = join(box.work, "release");
    const first = start(box, ["run", "--label", "docs-site: build", "--", NODE, "-e", untilFile(release)]);
    await until(() => slots(box)[0]?.pgid);
    const status = await cli(box, ["status"]);
    assert.equal(status.stdout.startsWith('slots: 1 of 1 taken, 0 waiting\nrunning "docs-site: build": pid '), true);
    assert.equal(status.stdout.endsWith('gate: shut; no free slot: 1 of 1 taken, by "docs-site: build"\n'), true);
    const second = start(box, ["run", "--label", "shop-api: lint", "--", NODE, "-e", "process.exit(0)"]);
    await until(() => second.seen.stderr.includes("in line"));
    assert.equal((await cli(box, ["status"])).stdout.includes('waiting 1 "shop-api: lint": pid '), true);
    writeFileSync(release, "");
    assert.deepEqual([(await first.done).code, (await second.done).code], [0, 0]);
    assert.equal(second.seen.stderr.startsWith(`dotime-queue: in line: position 1, 0 min waited, wait limit ${DEFAULTS.maxWaitMin} min; no free slot: 1 of 1 taken, by "docs-site: build"\n`), true);
    const [build, lint] = ["docs-site: build", "shop-api: lint"].map((label) => journal(box).find((line) => line.label === label));
    assert.equal(Date.parse(lint.startedAt) >= Date.parse(build.endedAt), true);
    assert.deepEqual(Object.keys(lint.waitBy), ["slots"]);
});

test("run: a caller's environment cannot raise the slot count", async () => {
    const box = sandbox({ config: { slots: 1 } });
    takeSlot(process.pid, "docs-site: build", 1, {}, { slots: join(box.home, "slots"), line: join(box.home, "line") });
    // One made-up variable per setting, so the check does not depend on guessing a variable name.
    const pushy = { ...box.env, ...settingEnv(DEFAULTS, 999) };
    const result = await cli(box, ["run", "--label", "shop-api: lint", "--max-wait", "0.01", "--", NODE, "-e", "console.log('started')"], { env: pushy });
    assert.deepEqual([result.code, result.stdout], [75, ""]);
    assert.equal(result.stderr.includes('no free slot: 1 of 1 taken, by "docs-site: build"'), true);
    assert.equal((await cli(box, ["status"], { env: pushy })).stdout.startsWith("slots: 1 of 1 taken"), true);
});

test("run: when the wait limit runs out, exit 75 names each health reading that kept the gate shut", async () => {
    const box = sandbox({ config: { health: { loadPerCore: 2, minFreeDiskGB: 12 } }, health: { load: 50, cores: 4, freePct: 70, diskGB: 0 } });
    const result = await cli(box, ["run", "--label", "docs-site: build", "--max-wait", "0.01", "--", NODE, "-e", "console.log('started')"]);
    assert.deepEqual([result.code, result.stdout], [75, ""]);
    const why = "load too high: 50.0 now, 8.0 allowed; disk too low: 0.0 GB free, 12 GB needed";
    assert.equal(result.stderr.includes(`in line: position 1, 0 min waited, wait limit 0.01 min; ${why}\n`), true);
    assert.equal(result.stderr.endsWith(`gave up: exit 75, position 1, 0 min waited; ${why}; hint: --max-wait 0 waits without limit\n`), true);
    const [line] = journal(box);
    assert.deepEqual([line.outcome, line.exit, Object.keys(line.waitBy).sort(), line.startedAt], ["gave-up", 75, ["disk", "load"], null]);
    assert.deepEqual(readdirSync(join(box.home, "line")), []);
    assert.equal((await cli(box, ["status"])).stdout, `slots: 0 of ${DEFAULTS.slots} taken, 0 waiting\ngate: shut; ${why}\n`);
});

test("run: exit 124 at the run limit stops the whole process group", async () => {
    const box = sandbox(), pidFile = join(box.work, "child.pid");
    const run = start(box, ["run", "--label", "shop-api: e2e", "--max-run", "3", "--", NODE, "-e", withChild(pidFile)], withClock(box));
    await until(() => existsSync(pidFile));
    const jobChild = pidIn(pidFile);
    writeFileSync(box.clock, "2");
    await pause(200);
    assert.deepEqual([run.child.exitCode, alive(jobChild)], [null, true]);
    writeFileSync(box.clock, "3");
    const result = await run.done;
    assert.equal(result.code, 124);
    assert.equal(result.stderr.includes('run limit: stopping "shop-api: e2e", KILL follows TERM after 0.25 s; ran 3 min against a limit of 3 min, set by the --max-run flag\n'), true);
    assert.equal(result.stderr.includes("timed out: exit 124, stopped after 3 min; hint: "), true);
    await until(() => !alive(jobChild), 3000);
    assert.deepEqual([journal(box).map((line) => [line.outcome, line.exit]), slots(box)], [[["timed-out", 124]], []]);
});

test("run: with --priority the limit only warns, and the stop comes at double the limit", async () => {
    const box = sandbox(), pidFile = join(box.work, "job.pid");
    const run = start(box, ["run", "--priority", "--label", "mobile-app: store upload", "--max-run", "4", "--", NODE, "-e", savePid(pidFile)], withClock(box));
    await until(() => existsSync(pidFile));
    const job = pidIn(pidFile);
    assert.deepEqual([slots(box)[0].priority, slots(box)[0].limitMin, slots(box)[0].killMin], [true, 4, 8]);
    writeFileSync(box.clock, "4");
    await until(() => run.seen.stderr.includes("priority warning"));
    writeFileSync(box.clock, "7");
    await pause(300);
    assert.deepEqual([run.child.exitCode, alive(job), slots(box).length], [null, true, 1]);
    assert.equal(run.seen.stderr, 'dotime-queue: priority warning: hard stop at 8 min, the 4 min limit (set by the --max-run flag) was passed by "mobile-app: store upload"\n');
    writeFileSync(box.clock, "8");
    const result = await run.done;
    assert.equal(result.code, 124);
    assert.equal(result.stderr.includes('run limit: stopping "mobile-app: store upload"') && result.stderr.includes("ran 8 min against a limit of 4 min"), true);
    await until(() => !alive(job), 3000);
    const [line] = journal(box);
    assert.deepEqual([line.outcome, line.priority, typeof line.warnedAt], ["timed-out", true, "string"]);
});

test("run: the long-run notice fires once", async () => {
    const box = sandbox({ config: { limits: { longRunUnmeasuredMin: 20 } } }), release = join(box.work, "release");
    const run = start(box, ["run", "--label", "docs-site: build", "--max-run", "50", "--", NODE, "-e", untilFile(release)], withClock(box));
    await until(() => slots(box)[0]?.pgid);
    writeFileSync(box.clock, "19");
    await pause(200);
    assert.equal(existsSync(join(box.home, "notify.log")), false);
    writeFileSync(box.clock, "20");
    await until(() => existsSync(join(box.home, "notices.json")));
    for (const minutes of ["21", "35", "49"]) { writeFileSync(box.clock, minutes); await pause(120); }
    writeFileSync(release, "");
    const result = await run.done;
    assert.equal(result.code, 0);
    assert.equal(count(result.stderr, "long run:"), 1);
    assert.equal(result.stderr.includes('long run: "docs-site: build" of project docs-site, pid '), true);
    const logged = readFileSync(join(box.home, "notify.log"), "utf8").split("\n").filter(Boolean);
    assert.deepEqual(logged.map((line) => line.split("\t")[1]), ["dotime: job running long"]);
    const stored = Object.values(JSON.parse(readFileSync(join(box.home, "notices.json"), "utf8")));
    assert.deepEqual(stored.map((entry) => [entry.type, entry.label, entry.waiting]), [["long-run", "docs-site: build", []]]);
    assert.equal(typeof journal(box)[0].longRunAt, "string");
});

test("run: when the queue process is killed, its job is stopped", async () => {
    const box = sandbox(), pidFile = join(box.work, "job.pid");
    const run = start(box, ["run", "--label", "shop-api: integration suite", "--", NODE, "-e", savePid(pidFile)]);
    await until(() => existsSync(pidFile));
    const job = pidIn(pidFile), wrapper = track(slots(box)[0].pgid, { group: true });
    assert.deepEqual([alive(job), alive(wrapper)], [true, true]);
    run.child.kill("SIGKILL");
    assert.equal((await run.done).signal, "SIGKILL");
    await until(() => !alive(job) && !alive(wrapper), 5000);
    assert.equal((await cli(box, ["status"])).stdout, `slots: 0 of ${DEFAULTS.slots} taken, 0 waiting\ngate: open\n`);
});

test("run: the same check is refused after failing twice, unless --after-fix is given", async () => {
    const box = sandbox(), failing = ["--", NODE, "-e", "process.exit(4)"], label = ["--label", "shop-api: integration suite"];
    for (const attempt of [1, 2]) assert.equal((await cli(box, ["run", ...label, ...failing])).code, 4, `attempt ${attempt}`);
    const refused = await cli(box, ["run", ...label, ...failing]);
    assert.equal(refused.code, 3);
    assert.equal(refused.stderr.startsWith('dotime-queue: refused: exit 3; same check failed twice on unchanged code: "shop-api: integration suite", exit 4 at '), true);
    assert.equal(refused.stderr.includes("--after-fix"), true);
    const allowed = await cli(box, ["run", ...label, "--after-fix", "raised the database pool size", ...failing]);
    assert.equal(allowed.code, 4);
    assert.equal(allowed.stderr, 'dotime-queue: --after-fix accepted: note "raised the database pool size", the check had failed twice on unchanged code\n');
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit, line.afterFix ?? null]), [["ran", 4, null], ["ran", 4, null], ["refused", 3, null], ["ran", 4, "raised the database pool size"]]);
});

test("run: an edit to the script it runs lifts the refusal", async () => {
    const box = sandbox(), script = join(box.work, "check.mjs"), args = ["run", "--label", "docs-site: link check", "--", NODE, script];
    writeFileSync(script, "process.exit(6);\n");
    assert.deepEqual([(await cli(box, args)).code, (await cli(box, args)).code, (await cli(box, args)).code], [6, 6, 3]);
    writeFileSync(script, "process.exit(0);\n");
    assert.equal((await cli(box, args)).code, 0);
});

test("run: Ctrl-C before the start removes the job from the line, exit 130", async () => {
    const box = sandbox({ config: { slots: 1 } });
    takeSlot(process.pid, "docs-site: build", 1, {}, { slots: join(box.home, "slots"), line: join(box.home, "line") });
    const waiter = start(box, ["run", "--label", "shop-api: lint", "--", NODE, "-e", "console.log('started')"]);
    await until(() => waiter.seen.stderr.includes("in line"));
    waiter.child.kill("SIGINT");
    const result = await waiter.done;
    assert.deepEqual([result.code, result.stdout], [130, ""]);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit, line.signal]), [["left", 130, "SIGINT"]]);
    assert.deepEqual(readdirSync(join(box.home, "line")), []);
});

test("run: a signal while running stops the job and is journalled as stopped", async () => {
    const box = sandbox(), pidFile = join(box.work, "job.pid");
    const run = start(box, ["run", "--label", "docs-site: build", "--", NODE, "-e", savePid(pidFile)]);
    await until(() => existsSync(pidFile));
    const job = pidIn(pidFile);
    run.child.kill("SIGTERM");
    const result = await run.done;
    assert.notEqual(result.code, 0);
    assert.equal(result.stderr, "dotime-queue: stopped: signal SIGTERM, 0 min run, journalled as stopped and not as failed\n");
    await until(() => !alive(job), 3000);
    const [line] = journal(box);
    assert.deepEqual([line.outcome, line.signal, typeof line.stoppedAt, slots(box)], ["stopped", "SIGTERM", "string", []]);
});

test("run: a setting that does not fit is reported once and replaced by its default", async () => {
    const box = sandbox({ config: { limits: { defaultMin: 0 }, idle: { serverIdleMin: -5 } } });
    const result = await cli(box, ["run", "--label", "docs-site: build", "--", NODE, "-e", "process.exit(0)"]);
    assert.equal(result.code, 0);
    const kept = (name, value, fallback) => `dotime-queue: setting ignored: ${name} is ${value}, needs a number above 0, default ${fallback} kept\n`;
    assert.equal(result.stderr, kept("limits.defaultMin", 0, DEFAULTS.limits.defaultMin) + kept("idle.serverIdleMin", -5, DEFAULTS.idle.serverIdleMin));
    assert.equal(journal(box)[0].limitMin, DEFAULTS.limits.defaultMin);
});

test("passed: finds a stamp for a clean commit that passed, and none once the tree changes", async () => {
    const box = sandbox(), repo = makeRepo(join(box.work, "shop-api"), { "src/cart.js": "export const items = [];\n" });
    const none = await cli(box, ["passed", "--cwd", repo]);
    assert.deepEqual([none.code, none.stdout], [1, "no stamp: no finished run on record, project shop-api\n"]);
    assert.equal((await cli(box, ["run", "--label", "shop-api: integration suite", "--", NODE, "-e", "process.exit(0)"], { cwd: repo })).code, 0);
    const found = await cli(box, ["passed", "--match", "integration"], { cwd: repo });
    assert.equal(found.code, 0);
    assert.equal(/^stamp: commit [0-9a-f]{8}, passed 0 min ago by "shop-api: integration suite", command .+, run time 0 min, tree clean at start, finished \d{4}-\d\d-\d\d \d\d:\d\d UTC\n$/.test(found.stdout), true);
    assert.deepEqual([(await cli(box, ["passed", "--match", "lint", "--cwd", repo])).code, (await cli(box, ["passed", "--cwd", box.work])).code], [1, 1]);
    writeFileSync(join(repo, "src", "cart.js"), "export const items = [1];\n");
    const dirty = await cli(box, ["passed", "--cwd", repo]);
    assert.deepEqual([dirty.code, dirty.stdout], [1, "no stamp: the working tree has uncommitted changes\n"]);
});

test("passed: a failing run on the commit gives no stamp", async () => {
    const box = sandbox(), repo = makeRepo(join(box.work, "docs-site"));
    assert.equal((await cli(box, ["run", "--label", "docs-site: link check", "--", NODE, "-e", "process.exit(2)"], { cwd: repo })).code, 2);
    const result = await cli(box, ["passed"], { cwd: repo });
    assert.equal(result.code, 1);
    assert.equal(result.stdout.startsWith('no stamp: newest clean run failed, "docs-site: link check", exit 2, commit '), true);
});

test("history: one row for all projects and one per project", async () => {
    const box = sandbox();
    assert.equal((await cli(box, ["history"])).stdout.endsWith(", jobs 0\n"), true);
    await cli(box, ["run", "--label", "docs-site: build", "--", NODE, "-e", "process.exit(0)"]);
    await cli(box, ["run", "--label", "shop-api: lint", "--", NODE, "-e", "process.exit(1)"]);
    const today = await cli(box, ["history", "--days", "1"]);
    const rows = today.stdout.trimEnd().split("\n");
    assert.equal(today.code, 0);
    assert.equal(/^history: \d{4}-\d\d-\d\d so far, zone UTC, jobs 2$/.test(rows[0]), true);
    assert.deepEqual(rows.slice(1).map((row) => row.split(";")[0]).sort(), ["all projects: jobs 2, failed 1, stopped 0, timed out 0, refused 0, gave up 0", "docs-site: jobs 1, failed 0, stopped 0, timed out 0, refused 0, gave up 0", "shop-api: jobs 1, failed 1, stopped 0, timed out 0, refused 0, gave up 0"]);
    assert.equal((await cli(box, ["history", "--day", "2040-01-01"])).stdout, "history: 2040-01-01, zone UTC, jobs 0\n");
});

test("usage: exit 2 with a message for bad input, exit 0 for help", async () => {
    const box = sandbox();
    const noCommand = await cli(box, ["run", "--label", "docs-site: build"]);
    assert.deepEqual([noCommand.code, noCommand.stdout, noCommand.stderr], [2, "", `${USAGE}\n`]);
    const badDay = await cli(box, ["history", "--day", "yesterday"]);
    assert.deepEqual([badDay.code, badDay.stderr], [2, "dotime-queue: --day: needs a date as YYYY-MM-DD\n"]);
    const badWait = await cli(box, ["run", "--max-wait", "1h", "--", "make"]);
    assert.deepEqual([badWait.code, badWait.stderr], [2, "dotime-queue: --max-wait wants a number of minutes, 0 or more; 0 means no limit\n"]);
    const misspelledMatch = await cli(box, ["passed", "--mach", "lint"]);
    assert.deepEqual([misspelledMatch.code, misspelledMatch.stdout, misspelledMatch.stderr], [2, "", "dotime-queue: unknown option --mach\n"]);
    const misspelledRun = await cli(box, ["run", "--max-runn", "90", "--", NODE, "-e", "console.log('started')"]);
    assert.deepEqual([misspelledRun.code, misspelledRun.stdout, misspelledRun.stderr], [2, "", "dotime-queue: unknown option --max-runn\n"]);
    const emptyMatch = await cli(box, ["passed", "--match", ""]);
    assert.deepEqual([emptyMatch.code, emptyMatch.stdout, emptyMatch.stderr], [2, "", "dotime-queue: option --match needs a value\n"]);
    const labelAsValue = await cli(box, ["run", "--label", "--priority", "--", NODE, "-e", "console.log('started')"]);
    assert.deepEqual([labelAsValue.code, labelAsValue.stdout, labelAsValue.stderr], [2, "", 'dotime-queue: option --label needs a value; for the value "--priority", write --label=--priority\n']);
    const badDays = await cli(box, ["history", "--days", "abc"]);
    assert.deepEqual([badDays.code, badDays.stdout, badDays.stderr], [2, "", "dotime-queue: --days: needs a whole number of days, 1 or more\n"]);
    const statusFlag = await cli(box, ["status", "--all"]);
    assert.deepEqual([statusFlag.code, statusFlag.stderr], [2, "dotime-queue: unknown option --all\n"]);
    for (const word of ["help", "--help"]) assert.deepEqual([(await cli(box, [word])).code, (await cli(box, [word])).stdout], [0, `${USAGE}\n`]);
    assert.deepEqual(journal(box), []);
});

test("run: a command that does not exist ends with exit 127", async () => {
    const box = sandbox();
    const result = await cli(box, ["run", "--label", "docs-site: build", "--", "dotime-command-that-is-not-installed"]);
    assert.equal(result.code, 127);
    assert.equal(result.stderr.startsWith("dotime-queue: start failed: exit 127, "), true);
});

test("run: a command that cannot start is journalled as could-not-start and never counts as a failed check", async () => {
    const box = sandbox(), args = ["run", "--label", "docs-site: unit tests", "--", "dotime-command-that-is-not-installed"];
    for (const attempt of [1, 2, 3]) assert.equal((await cli(box, args)).code, 127, `attempt ${attempt}`);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit]), [["could-not-start", 127], ["could-not-start", 127], ["could-not-start", 127]]);
    assert.equal((await cli(box, ["run", "--label", "docs-site: unit tests", "--", NODE, "-e", "process.exit(0)"])).code, 0);
    assert.equal((await cli(box, ["history", "--days", "1"])).stdout.includes("all projects: jobs 4, failed 0,"), true);
});

test("run: a job that leaves a background process behind ends at once and is journalled as ran", async () => {
    const box = sandbox(), began = Date.now();
    const { child } = start(box, ["run", "--label", "docs-site: build", "--", "sh", "-c", "(sleep 3 &); exit 0"]);
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 0);
    assert.equal(Date.now() - began < 2000, true, `${Date.now() - began} ms`);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit]), [["ran", 0]]);
});

test("run: a corrected command is not refused for a failure of the command before it", async () => {
    const box = sandbox(), label = ["--label", "shop-api: unit tests"];
    assert.equal((await cli(box, ["run", ...label, "--", NODE, "-e", "process.exit(4)", "wrong-argument"])).code, 4);
    for (const attempt of [1, 2]) assert.equal((await cli(box, ["run", ...label, "--", NODE, "-e", "process.exit(4)"])).code, 4, `attempt ${attempt}`);
    assert.equal((await cli(box, ["run", ...label, "--", NODE, "-e", "process.exit(4)"])).code, 3);
});

test("run: a job that exits 127 by itself still counts as a failed run", async () => {
    const box = sandbox();
    assert.equal((await cli(box, ["run", "--label", "docs-site: unit tests", "--", NODE, "-e", "process.exit(127)"])).code, 127);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit]), [["ran", 127]]);
});

test("run: a check that failed twice runs again once its command changes", async () => {
    const box = sandbox(), label = ["--label", "shop-api: unit tests"];
    for (const attempt of [1, 2]) assert.equal((await cli(box, ["run", ...label, "--", NODE, "-e", "process.exit(4)"])).code, 4, `attempt ${attempt}`);
    assert.equal((await cli(box, ["run", ...label, "--", NODE, "-e", "process.exit(4)"])).code, 3);
    const changed = await cli(box, ["run", ...label, "--", NODE, "-e", "process.exit(0)"]);
    assert.deepEqual([changed.code, changed.stderr], [0, ""]);
});
