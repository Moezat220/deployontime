import { constants as osConstants } from "node:os";
// The end-to-end tests start the real cli.mjs. Each one gets its own state folder inside the temp folder, short timers
// and health limits so wide that no reading of this computer shuts the gate, both from that folder's config.json,
// and notices that go to the log file only. Tests that need a made-up health reading or a clock that jumps ahead
// run the same command in this process instead, in run.test.mjs. Signals are sent only to processes started here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    asPlatform, cleanEnv, git as testGit, isolateProcess, makeRepo, settingEnv, tempDir, track, until,
} from "./testkit.mjs";

isolateProcess("cli");
const { historyRow, main, statusLines } = await import("./cli.mjs");
const { USAGE } = await import("./args.mjs");
const { takeSlot } = await import("./slots.mjs");
const { alive } = await import("./proctree.mjs");
const { DEFAULTS } = await import("./settings.mjs");

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url)), NODE = process.execPath, MINUTE = 60_000;
const WIDE_OPEN = { loadPerCore: 1000, minFreeMemPct: 0, minFreeDiskGB: 0, minBatteryPct: 0 };

function sandbox({ config = {}, env = {} } = {}) {
    const home = tempDir("cli-home"), work = tempDir("cli-work");
    const limits = { killGraceMs: 250, orphanCheckMs: 80, ...config.limits };
    writeFileSync(join(home, "config.json"), JSON.stringify({ pollMs: 60, ...config, health: { ...WIDE_OPEN, ...config.health }, limits }));
    return { home, work, env: cleanEnv(home, env) };
}
function start(box, args, { cwd = box.work, env = box.env } = {}) {
    const child = track(spawn(NODE, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] }));
    const seen = { stdout: "", stderr: "" };
    child.stdout.on("data", (text) => { seen.stdout += text; });
    child.stderr.on("data", (text) => { seen.stderr += text; });
    return { child, seen, done: new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, ...seen }))) };
}
const cli = (box, args, options) => start(box, args, options).done;
const journal = (box) => {
    try {
        return readFileSync(join(box.home, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
};
const slots = (box) => {
    try {
        return readdirSync(join(box.home, "slots"))
            .filter((name) => name.endsWith(".json"))
            .map((name) => JSON.parse(readFileSync(join(box.home, "slots", name), "utf8")));
    } catch { return []; }
};
const count = (text, part) => text.split(part).length - 1;

// Job scripts, run with `node -e`.
const FOREVER = "setInterval(() => {}, 1000)";
const untilFile = (file) => `const fs = require("node:fs"); `
    + `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(file)})) { clearInterval(t); } }, 20);`;
const savePid = (file) => `require("node:fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); ${FOREVER}`;
const withChild = (file) => `const c = require("node:child_process").spawn(`
    + `process.execPath, ["-e", ${JSON.stringify(FOREVER)}], { stdio: "ignore" }); `
    + `require("node:fs").writeFileSync(${JSON.stringify(file)}, String(c.pid)); ${FOREVER}`;
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
        {
            label: "mobile-app: store upload", pid: 3102, startedAt: now - 9 * MINUTE, kind: "deploy",
            limitMin: 12, killMin: 24, longRunMin: 20, priority: true,
        },
        { label: "shop-api: lint", pid: 3103, at: now - 2 * MINUTE },
    ];
    const queue = [
        { label: "shop-api: integration suite", pid: 3104, at: now - 6 * MINUTE, priority: true },
        { label: "docs-site: link check", pid: 3105, at: now - 30_000 },
    ];
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

test("statusLines: a nested run is shown under the job it runs in and is not counted as taking a slot", () => {
    const now = Date.UTC(2031, 5, 9, 10, 0);
    const holders = [
        { file: "/state/slots/slot-0.json", label: "docs-site: test suite", pid: 3201, born: now - 6 * MINUTE, at: now - 5 * MINUTE },
        { file: "/state/slots/slot-1.json", label: "shop-api: lint", pid: 3202, born: now - 2 * MINUTE, at: now - MINUTE },
    ];
    const nested = [{
        label: "docs-site: unit tests", pid: 3205, outer: "slot-0", outerPid: 3201, outerBorn: now - 6 * MINUTE, at: now - 3 * MINUTE,
    }];
    assert.deepEqual(statusLines({ holders, queue: [], nested, gate: "no free slot: 2 of 2 taken", max: 2, now }), [
        "slots: 2 of 2 taken, 0 waiting",
        'running "docs-site: test suite": pid 3201, 5 min so far, limit unknown',
        '  nested "docs-site: unit tests": pid 3205, 3 min so far, no slot of its own',
        'running "shop-api: lint": pid 3202, 1 min so far, limit unknown',
        "gate: shut; no free slot: 2 of 2 taken",
    ]);
});

test("statusLines: a nested run inside a nested run is shown one step further in, and a waiting one says so", () => {
    const now = Date.UTC(2031, 5, 9, 10, 0);
    const holders = [{ file: "/state/slots/slot-0.json", label: "docs-site: test suite", pid: 3201, born: now - 6 * MINUTE, at: now - 5 * MINUTE }];
    const run = (pid, label, ago, outer, more = {}) => ({
        file: `/state/nested/nested-${pid}.json`, label, pid, born: now - ago * MINUTE, at: now - ago * MINUTE, ...outer, ...more,
    });
    const inSlot = { outer: "slot-0", outerPid: 3201, outerBorn: now - 6 * MINUTE };
    const inUnit = { outer: "nested-3205", outerPid: 3205, outerBorn: now - 4 * MINUTE };
    const nested = [
        run(3205, "docs-site: unit tests", 4, inSlot), run(3207, "docs-site: parser tests", 2, inUnit),
        run(3209, "docs-site: lexer tests", 1, inUnit, { waiting: true }), run(3210, "docs-site: link check", 1, inSlot, { waiting: true }),
    ];
    assert.deepEqual(statusLines({ holders, queue: [], nested, gate: "no free slot: 1 of 1 taken", max: 1, now }), [
        "slots: 1 of 1 taken, 0 waiting",
        'running "docs-site: test suite": pid 3201, 5 min so far, limit unknown',
        '  nested "docs-site: unit tests": pid 3205, 4 min so far, no slot of its own',
        '    nested "docs-site: parser tests": pid 3207, 2 min so far, no slot of its own',
        '    nested "docs-site: lexer tests": pid 3209, 1 min so far, waiting for a nested place under "docs-site: unit tests"',
        '  nested "docs-site: link check": pid 3210, 1 min so far, waiting for a nested place under "docs-site: test suite"',
        "gate: shut; no free slot: 1 of 1 taken",
    ]);
});

test("statusLines: a nested run counts its minutes from when it started to run, not from when it began to wait", () => {
    const now = Date.UTC(2031, 5, 9, 10, 0);
    const holders = [{ file: "/state/slots/slot-0.json", label: "docs-site: test suite", pid: 3201, born: now - 20 * MINUTE, at: now - 20 * MINUTE }];
    const inSlot = { outer: "slot-0", outerPid: 3201, outerBorn: now - 20 * MINUTE };
    const nested = [
        { label: "docs-site: unit tests", pid: 3205, ...inSlot, at: now - 12 * MINUTE, startedAt: now - 2 * MINUTE },
        { label: "docs-site: link check", pid: 3206, ...inSlot, at: now - 7 * MINUTE, waiting: true },
    ];
    assert.deepEqual(statusLines({ holders, queue: [], nested, gate: "", max: 1, now }).slice(2, 4), [
        '  nested "docs-site: unit tests": pid 3205, 2 min so far, no slot of its own',
        '  nested "docs-site: link check": pid 3206, 7 min so far, waiting for a nested place under "docs-site: test suite"',
    ]);
});

test("statusLines: a nested run is not shown under a later job that took the same slot after its outer job ended", () => {
    const now = Date.UTC(2031, 5, 9, 10, 0);
    const holders = [{ file: "/state/slots/slot-0.json", label: "shop-api: e2e", pid: 3301, born: now - 2 * MINUTE, at: now - MINUTE }];
    const older = { label: "docs-site: unit tests", pid: 3205, outer: "slot-0", at: now - 9 * MINUTE };
    const nested = [
        { ...older, outerPid: 3201, outerBorn: now - 12 * MINUTE },
        { ...older, pid: 3206, outerPid: 3301, outerBorn: now - 30 * MINUTE },
    ];
    assert.deepEqual(statusLines({ holders, queue: [], nested, gate: "", max: 1, now }), [
        "slots: 1 of 1 taken, 0 waiting",
        'running "shop-api: e2e": pid 3301, 1 min so far, limit unknown',
        "gate: open",
    ], "another pid, or the same pid with another start time, is another job");
});

test("statusLines: an empty queue with an open gate", () => {
    assert.deepEqual(statusLines({ holders: [], queue: [], gate: "", max: 2 }), ["slots: 0 of 2 taken, 0 waiting", "gate: open"]);
});

test("historyRow: how jobs ended, then how long they waited, then what held them back", () => {
    const totals = {
        jobs: 9, waited: 4, waitMinTotal: 31.5, waitWallMin: 18, blockedOnlyMin: 2.5, waitMedian: 0.5, waitP90: 11,
        gaveUp: 1, failed: 2, stopped: 0, timedOut: 1, refused: 3, waitBy: { slots: 27, disk: 4.5 },
    };
    assert.equal(
        historyRow("shop-api", totals),
        "shop-api: jobs 9, failed 2, stopped 0, timed out 1, refused 3, gave up 1; "
            + "waited: jobs 4, sum 31.5 min, clock 18 min, clock with no job running 2.5 min, median 0.5 min, p90 11 min; "
            + "held by: slots 27 min, disk 4.5 min",
    );
    assert.equal(historyRow("docs-site", { ...totals, waitBy: {} }).endsWith("; held by: nothing"), true);
});

test("historyRow: skipped jobs and the run time they saved follow the outcomes, once there are any", () => {
    const totals = {
        jobs: 5, waited: 0, waitMinTotal: 0, waitWallMin: 0, blockedOnlyMin: 0, waitMedian: 0, waitP90: 0,
        gaveUp: 0, failed: 1, stopped: 0, timedOut: 0, refused: 0, skipped: 3, savedMin: 13.5, waitBy: {},
    };
    assert.equal(
        historyRow("shop-api", totals),
        "shop-api: jobs 5, failed 1, stopped 0, timed out 0, refused 0, gave up 0, skipped 3 (saved 13.5 min); "
            + "waited: jobs 0, sum 0 min, clock 0 min, clock with no job running 0 min, median 0 min, p90 0 min; held by: nothing",
    );
    assert.equal(historyRow("shop-api", { ...totals, skipped: 0, savedMin: 0 }).includes("skipped"), false);
});

// ---- end to end ----

test("run: passes the job's output and exit code through and writes one journal line", async () => {
    const box = sandbox();
    const result = await cli(box, [
        "run", "--label", "mobile-app: bundle", "--",
        NODE, "-e", "console.log('bundled'); console.error('1 warning'); process.exit(4)",
    ]);
    assert.deepEqual([result.code, result.stdout, result.stderr], [4, "bundled\n", "1 warning\n"]);
    const lines = journal(box);
    assert.equal(lines.length, 1);
    assert.deepEqual(
        [lines[0].outcome, lines[0].exit, lines[0].projectKey, lines[0].kind, lines[0].limitMin, lines[0].priority],
        ["ran", 4, "mobile-app", "build", DEFAULTS.limits.defaultMin, false],
    );
    assert.deepEqual([slots(box), readdirSync(join(box.home, "line"))], [[], []]);
});

test("run: a job that ends by SIGUSR1 exits 128 plus its number and opens no debugger on the way", async () => {
    const box = sandbox();
    const result = await cli(box, ["run", "--label", "shop-api: suite", "--", "/bin/sh", "-c", "kill -USR1 $$"]);
    // The signal number differs by system (30 on macOS, 10 on Linux), so the exit code does too.
    assert.equal(result.code, 128 + osConstants.signals.SIGUSR1);
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
    assert.equal(second.seen.stderr.startsWith(
        `dotime-queue: in line: position 1, 0 min waited, wait limit ${DEFAULTS.maxWaitMin} min; `
            + `no free slot: 1 of 1 taken, by "docs-site: build"\n`,
    ), true);
    const [build, lint] = ["docs-site: build", "shop-api: lint"].map((label) => journal(box).find((line) => line.label === label));
    assert.equal(Date.parse(lint.startedAt) >= Date.parse(build.endedAt), true);
    assert.deepEqual(Object.keys(lint.waitBy), ["slots"]);
});

test("run: a caller's environment cannot raise the slot count", async () => {
    const box = sandbox({ config: { slots: 1 } });
    takeSlot(process.pid, "docs-site: build", 1, {}, { slots: join(box.home, "slots"), waitingLine: join(box.home, "line") });
    // One made-up variable per setting, so the check does not depend on guessing a variable name.
    const pushy = { ...box.env, ...settingEnv(DEFAULTS, 999) };
    const result = await cli(box, ["run", "--label", "shop-api: lint", "--max-wait", "0.01", "--", NODE, "-e", "console.log('started')"], { env: pushy });
    assert.deepEqual([result.code, result.stdout], [75, ""]);
    assert.equal(result.stderr.includes('no free slot: 1 of 1 taken, by "docs-site: build"'), true);
    assert.equal((await cli(box, ["status"], { env: pushy })).stdout.startsWith("slots: 1 of 1 taken"), true);
});

// ---- nested runs ----

/** The words that run the queue again from inside a job. */
const innerRun = (label, ...cmd) => [NODE, CLI, "run", "--label", label, "--max-wait", "0.05", "--", ...cmd];
const nestedNotes = (box) => {
    try { return readdirSync(join(box.home, "nested")); } catch { return []; }
};

test("run: a job that runs the queue again gets its inner run started at once, also with the only slot taken", async () => {
    const box = sandbox({ config: { slots: 1 } });
    const inner = innerRun("docs-site: unit tests", NODE, "-e", "process.exit(0)");
    const outer = await cli(box, ["run", "--label", "docs-site: test suite", "--max-wait", "0.05", "--", ...inner]);
    assert.equal(outer.code, 0, outer.stderr);
    assert.equal(outer.stderr.includes("gave up"), false);
    assert.match(outer.stderr, /^dotime-queue: nested: inside "docs-site: test suite", pid \d+; starts at once: no slot, no place in line, no health gate\n$/);
    const lines = journal(box).map((line) => [line.label, line.outcome, line.exit, line.nested ?? false]);
    assert.deepEqual(lines, [["docs-site: unit tests", "ran", 0, true], ["docs-site: test suite", "ran", 0, false]]);
    assert.deepEqual([slots(box), nestedNotes(box)], [[], []]);
});

test("status: a nested run shows under its outer job while it runs, and the slot count stays at the outer job", async () => {
    const box = sandbox({ config: { slots: 1 } }), release = join(box.work, "release");
    const outer = start(box, ["run", "--label", "docs-site: test suite", "--", ...innerRun("docs-site: unit tests", NODE, "-e", untilFile(release))]);
    await until(() => nestedNotes(box).length === 1);
    // The note is written before the nested run takes its place, so wait until status shows it running.
    let shown = [];
    for (const end = Date.now() + 10_000; Date.now() < end;) {
        shown = (await cli(box, ["status"])).stdout.split("\n");
        if (!shown[2]?.includes("waiting for a nested place")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(shown[0], "slots: 1 of 1 taken, 0 waiting");
    assert.equal(shown[1].startsWith('running "docs-site: test suite": pid '), true, shown[1]);
    assert.match(shown[2], /^ {2}nested "docs-site: unit tests": pid \d+, 0 min so far, no slot of its own$/);
    assert.equal(shown[3], 'gate: shut; no free slot: 1 of 1 taken, by "docs-site: test suite"');
    writeFileSync(release, "");
    assert.equal((await outer.done).code, 0);
    assert.deepEqual(nestedNotes(box), []);
});

test("run: a copied, stale or malformed marker is ignored and the run queues as usual", async () => {
    const box = sandbox({ config: { slots: 1 } });
    // The slot is held by a process that is not an ancestor of the runs below.
    const other = track(spawn(NODE, ["-e", FOREVER], { stdio: "ignore" }));
    takeSlot(other.pid, "shop-api: e2e", 1, {}, { slots: join(box.home, "slots"), waitingLine: join(box.home, "line") });
    for (const marker of ["slot-0", "slot-1", "../slots/slot-0"]) {
        const env = { ...box.env, DOTIME_JOB: marker };
        const result = await cli(box, ["run", "--label", "docs-site: lint", "--max-wait", "0.01", "--", NODE, "-e", "console.log('started')"], { env });
        assert.deepEqual([result.code, result.stdout], [75, ""], marker);
        assert.equal(result.stderr.includes('no free slot: 1 of 1 taken, by "shop-api: e2e"'), true, marker);
        assert.equal(result.stderr.includes("nested"), false, marker);
    }
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.nested ?? false]), [["gave-up", false], ["gave-up", false], ["gave-up", false]]);
    other.kill("SIGKILL");
});

const J = JSON.stringify;
const places = (box) => {
    try { return readdirSync(join(box.home, "places")); } catch { return []; }
};
/** A job script that saves the markers it was given in file, as "<DOTIME_JOB> <DOTIME_PARENT>", and then, when next
 *  is given, runs those words and exits the way they did. */
const saveMarker = (file, next = null) => `const e = process.env; require("node:fs").writeFileSync(${J(file)}, e.DOTIME_JOB + " " + e.DOTIME_PARENT); `
    + (next ? `const r = require("node:child_process").spawnSync(${J(next[0])}, ${J(next.slice(1))}, { stdio: "inherit" }); process.exit(r.status ?? 1);` : "");

test("run: one job that starts 20 nested runs side by side never has more than nestedPerJob of them running", async () => {
    const box = sandbox({ config: { slots: 1, nestedPerJob: 2 } }), times = join(box.work, "times");
    mkdirSync(times);
    const shard = (i) => `const fs = require("node:fs"), dir = ${J(times)}; fs.writeFileSync(dir + "/${i}.start", String(Date.now())); `
        + `setTimeout(() => fs.writeFileSync(dir + "/${i}.end", String(Date.now())), 250);`;
    const words = Array.from({ length: 20 }, (_, i) => [CLI, "run", "--label", `docs-site: shard ${i}`, "--max-wait", "0", "--", NODE, "-e", shard(i)]);
    const fanOut = `const { spawn } = require("node:child_process"); const all = ${J(words)}; `
        + `Promise.all(all.map((words) => new Promise((done) => spawn(${J(NODE)}, words, { stdio: "ignore" }).on("exit", done))))`
        + `.then((codes) => { console.log(JSON.stringify(codes)); process.exit(codes.every((c) => c === 0) ? 0 : 1); });`;
    const outer = await cli(box, ["run", "--label", "docs-site: test suite", "--", NODE, "-e", fanOut]);
    assert.equal(outer.code, 0, outer.stderr);
    assert.deepEqual(JSON.parse(outer.stdout), Array(20).fill(0), "all 20 finished with exit 0");
    const events = [];
    for (let i = 0; i < 20; i++) {
        events.push([Number(readFileSync(join(times, `${i}.start`), "utf8")), 1], [Number(readFileSync(join(times, `${i}.end`), "utf8")), -1]);
    }
    let running = 0, most = 0;
    for (const [, step] of events.sort((a, b) => a[0] - b[0] || a[1] - b[1])) most = Math.max(most, running += step);
    assert.equal(most, 2, "at most 2 ran at once, and the places were used");
    const lines = journal(box);
    assert.deepEqual([lines.length, lines.filter((line) => line.nested && line.outcome === "ran" && line.exit === 0).length], [21, 20]);
    assert.equal(lines.filter((line) => "nested" in line.waitBy).length >= 9, true, "the waits for a place are journalled");
    assert.deepEqual([slots(box), nestedNotes(box), places(box)], [[], [], []]);
});

test("run: a nested run whose parent ends while it waits for a place waits for a slot like any run, and shows in the line", async () => {
    const box = sandbox({ config: { slots: 1, nestedPerJob: 1 } }), f = (name) => join(box.work, name);
    const stamp = (name) => `require("node:fs").writeFileSync(${J(f(name))}, String(Date.now()));`;
    const shardA = [CLI, "run", "--label", "docs-site: shard a", "--max-wait", "0.5", "--", NODE, "-e", `${stamp("a.start")} ${untilFile(f("a.release"))}`];
    const shardB = [CLI, "run", "--label", "docs-site: shard b", "--max-wait", "0.5", "--", NODE, "-e", stamp("b.start")];
    // The outer job starts shard a, then shard b once a runs, and ends once b waits and the test says so.
    const fanOut = `const { spawn } = require("node:child_process"), fs = require("node:fs"); let b = false; `
        + `const go = (words) => spawn(${J(NODE)}, words, { stdio: "ignore" }); go(${J(shardA)}); `
        + `const t = setInterval(() => { if (!fs.existsSync(${J(f("a.start"))})) return; if (!b) { b = true; go(${J(shardB)}); } `
        + `if (fs.readdirSync(${J(join(box.home, "nested"))}).length >= 2 && fs.existsSync(${J(f("outer.release"))})) process.exit(0); }, 20);`;
    const outer = start(box, ["run", "--label", "docs-site: test suite", "--", NODE, "-e", fanOut]);
    await until(() => slots(box).length === 1);
    const nextJob = `${stamp("next.start")} const fs = require("node:fs"); `
        + `const t = setInterval(() => { if (fs.existsSync(${J(f("next.release"))})) { clearInterval(t); ${stamp("next.end")} } }, 20);`;
    const next = start(box, ["run", "--label", "shop-api: e2e", "--max-wait", "0.5", "--", NODE, "-e", nextJob]);
    await until(() => readdirSync(join(box.home, "line")).length === 1 && nestedNotes(box).length === 2);
    writeFileSync(f("outer.release"), "");
    assert.equal((await outer.done).code, 0);
    await until(() => existsSync(f("next.start")));
    writeFileSync(f("a.release"), "");
    await until(() => journal(box).some((line) => line.label === "docs-site: shard a"));
    const waitingB = 'waiting 1 "docs-site: shard b": pid ';
    await until(async () => (await cli(box, ["status"])).stdout.includes(waitingB));
    assert.equal(existsSync(f("b.start")), false, "shard b does not run beside the job that holds the slot");
    writeFileSync(f("next.release"), "");
    assert.equal((await next.done).code, 0);
    await until(() => journal(box).some((line) => line.label === "docs-site: shard b"));
    assert.equal(Number(readFileSync(f("b.start"), "utf8")) >= Number(readFileSync(f("next.end"), "utf8")), true);
    const b = journal(box).find((line) => line.label === "docs-site: shard b");
    assert.deepEqual([b.outcome, b.exit, b.nested ?? false, "nested" in b.waitBy, "slots" in b.waitBy], ["ran", 0, false, true, true]);
    assert.deepEqual([slots(box), nestedNotes(box), places(box)], [[], [], []]);
});

test("run: three levels of nesting finish with nestedPerJob 1 and one slot, each level the parent of the next", async () => {
    const box = sandbox({ config: { slots: 1, nestedPerJob: 1 } }), seen = [0, 1, 2, 3].map((n) => join(box.work, `marker-${n}`));
    const level3 = innerRun("docs-site: level 3", NODE, "-e", saveMarker(seen[3]));
    const level2 = innerRun("docs-site: level 2", NODE, "-e", saveMarker(seen[2], level3));
    const level1 = innerRun("docs-site: level 1", NODE, "-e", saveMarker(seen[1], level2));
    const outer = await cli(box, ["run", "--label", "docs-site: test suite", "--max-wait", "0.05", "--", NODE, "-e", saveMarker(seen[0], level1)]);
    assert.equal(outer.code, 0, outer.stderr);
    assert.equal(outer.stderr.includes("gave up"), false);
    const markers = seen.map((file) => readFileSync(file, "utf8").split(" "));
    assert.deepEqual(markers.map(([slot]) => slot), ["slot-0", "slot-0", "slot-0", "slot-0"], "every level names the outer slot, as older copies read it");
    assert.equal(markers[0][1], "slot-0");
    for (const n of [1, 2, 3]) assert.match(markers[n][1], /^nested-\d+$/, `level ${n} is handed its own parent's marker`);
    assert.equal(new Set(markers.map(([, parent]) => parent)).size, 4, "each level names a different parent");
    const lines = journal(box).map((line) => [line.label, line.outcome, line.exit, line.nested ?? false]);
    assert.deepEqual(lines, [
        ["docs-site: level 3", "ran", 0, true], ["docs-site: level 2", "ran", 0, true], ["docs-site: level 1", "ran", 0, true],
        ["docs-site: test suite", "ran", 0, false],
    ]);
    assert.deepEqual([slots(box), nestedNotes(box), places(box)], [[], [], []]);
});

test("run: a nested run's marker copied out of its job, or left over after it, is ignored and the run queues as usual", async () => {
    const box = sandbox({ config: { slots: 1 } }), seen = join(box.work, "marker"), release = join(box.work, "release");
    // The marker is written under another name and then renamed, so the file the test waits for is never seen half
    // written.
    const waitThenEnd = `require("node:fs").writeFileSync(${J(`${seen}.part`)}, process.env.DOTIME_PARENT); `
        + `require("node:fs").renameSync(${J(`${seen}.part`)}, ${J(seen)}); ${untilFile(release)}`;
    const outer = start(box, ["run", "--label", "docs-site: test suite", "--", ...innerRun("docs-site: unit tests", NODE, "-e", waitThenEnd)]);
    await until(() => existsSync(seen));
    const marker = readFileSync(seen, "utf8");
    assert.match(marker, /^nested-\d+$/);
    const env = { ...box.env, DOTIME_JOB: "slot-0", DOTIME_PARENT: marker };
    const tryWith = (label) => cli(box, ["run", "--label", label, "--max-wait", "0.01", "--", NODE, "-e", "console.log('started')"], { env });
    const copied = await tryWith("docs-site: lint");
    assert.deepEqual([copied.code, copied.stdout], [75, ""]);
    assert.equal(copied.stderr.includes('no free slot: 1 of 1 taken, by "docs-site: test suite"'), true, copied.stderr);
    assert.equal(copied.stderr.includes("nested"), false);
    assert.equal(places(box).length, 1, "the copied marker took no place");
    writeFileSync(release, "");
    assert.equal((await outer.done).code, 0);
    const other = track(spawn(NODE, ["-e", FOREVER], { stdio: "ignore" }));
    takeSlot(other.pid, "shop-api: e2e", 1, {}, { slots: join(box.home, "slots"), waitingLine: join(box.home, "line") });
    const stale = await tryWith("docs-site: link check");
    assert.deepEqual([stale.code, stale.stdout, stale.stderr.includes("nested")], [75, "", false]);
    assert.deepEqual(journal(box).filter((line) => line.outcome === "gave-up").map((line) => line.nested ?? false), [false, false]);
    other.kill("SIGKILL");
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
    assert.equal(refused.stderr.startsWith(
        'dotime-queue: refused: exit 3; same check failed twice on unchanged code: "shop-api: integration suite", exit 4 at ',
    ), true);
    assert.equal(refused.stderr.includes("--after-fix"), true);
    const allowed = await cli(box, ["run", ...label, "--after-fix", "raised the database pool size", ...failing]);
    assert.equal(allowed.code, 4);
    assert.equal(allowed.stderr, 'dotime-queue: --after-fix accepted: note "raised the database pool size", the check had failed twice on unchanged code\n');
    assert.deepEqual(
        journal(box).map((line) => [line.outcome, line.exit, line.afterFix ?? null]),
        [["ran", 4, null], ["ran", 4, null], ["refused", 3, null], ["ran", 4, "raised the database pool size"]],
    );
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
    takeSlot(process.pid, "docs-site: build", 1, {}, { slots: join(box.home, "slots"), waitingLine: join(box.home, "line") });
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
    assert.equal(result.code, 1);
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
    assert.equal(
        new RegExp('^stamp: commit [0-9a-f]{8}, passed 0 min ago by "shop-api: integration suite", command .+, '
            + "run time 0 min, tree clean at start, finished \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\n$").test(found.stdout),
        true,
    );
    assert.deepEqual([(await cli(box, ["passed", "--match", "lint", "--cwd", repo])).code, (await cli(box, ["passed", "--cwd", box.work])).code], [1, 1]);
    writeFileSync(join(repo, "src", "cart.js"), "export const items = [1];\n");
    const dirty = await cli(box, ["passed", "--cwd", repo]);
    assert.deepEqual([dirty.code, dirty.stdout], [1, "no stamp: the working tree has uncommitted changes\n"]);
});

test("run: a check that passed on this clean commit is skipped, runs again once the tree changes, and history counts the skip", async () => {
    const box = sandbox(), repo = makeRepo(join(box.work, "shop-api"), { "src/cart.js": "export const items = [];\n" });
    const args = ["run", "--label", "shop-api: unit tests", "--", NODE, "-e", "console.log('tested')"];
    const first = await cli(box, args, { cwd: repo });
    assert.deepEqual([first.code, first.stdout, first.stderr], [0, "tested\n", ""]);
    const head = testGit(repo, "rev-parse", "HEAD").trim();
    const again = await cli(box, args, { cwd: repo });
    assert.deepEqual([again.code, again.stdout, again.stderr], [
        0, "", `dotime-queue: skipped: "shop-api: unit tests" already passed on commit ${head.slice(0, 8)} (0 min ago); --no-skip runs it anyway\n`,
    ]);
    const stamp = await cli(box, ["passed", "--match", "unit tests"], { cwd: repo });
    assert.equal(stamp.code, 0, "passed still finds the run that ran");
    writeFileSync(join(repo, "src", "cart.js"), "export const items = [1];\n");
    const changed = await cli(box, args, { cwd: repo });
    assert.deepEqual([changed.code, changed.stdout, changed.stderr], [0, "tested\n", ""]);
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit, line.clean]), [["ran", 0, true], ["skipped", 0, true], ["ran", 0, false]]);
    const rows = (await cli(box, ["history", "--days", "1"])).stdout.trimEnd().split("\n");
    assert.deepEqual(rows.slice(1).map((row) => row.split(";")[0]), [
        "all projects: jobs 3, failed 0, stopped 0, timed out 0, refused 0, gave up 0, skipped 1 (saved 0 min)",
        "shop-api: jobs 3, failed 0, stopped 0, timed out 0, refused 0, gave up 0, skipped 1 (saved 0 min)",
    ]);
});

test("run: a pass in one folder of a repository is no stamp for the same check in another folder of it", async () => {
    // The same script in both folders, so the code fingerprint is the same; each folder's own settings file decides.
    const script = 'process.exit(require("./expected.json").exit)\n';
    const repo = makeRepo(join(tempDir("cli-mono"), "mono"), {
        "packages/cart/check.js": script, "packages/cart/expected.json": '{ "exit": 0 }\n',
        "packages/billing/check.js": script, "packages/billing/expected.json": '{ "exit": 1 }\n',
    });
    const box = sandbox(), args = ["run", "--label", "mono: unit tests", "--", NODE, "check.js"];
    const cart = join(repo, "packages", "cart"), billing = join(repo, "packages", "billing");
    assert.equal((await cli(box, args, { cwd: cart })).code, 0);
    const other = await cli(box, args, { cwd: billing });
    assert.deepEqual([other.code, other.stderr], [1, ""], "the other folder's check ran and failed");
    assert.equal((await cli(box, args, { cwd: cart })).stderr.startsWith('dotime-queue: skipped: "mono: unit tests"'), true,
        "a failure in another folder leaves the first folder's stamp alone");
    assert.deepEqual(journal(box).map((line) => [line.outcome, line.exit]), [["ran", 0], ["ran", 1], ["skipped", 0]]);
    assert.equal(journal(box)[0].fp, journal(box)[1].fp, "only the folder tells the two checks apart");
});

test("run: --no-skip on an outer job makes the checks it runs through the queue run, which would otherwise be skipped", async () => {
    const box = sandbox(), repo = makeRepo(join(box.work, "shop-api"));
    const check = ["--label", "shop-api: unit tests", "--", NODE, "-e", "console.log('inner ran')"];
    assert.equal((await cli(box, ["run", ...check], { cwd: repo })).code, 0);
    // Each outer job has a label of its own, so it has no stamp and runs; only the inner check can be skipped.
    const outer = (label, ...flags) => ["run", "--label", label, "--kind", "test", ...flags, "--", NODE, CLI, "run", ...check];
    const forced = await cli(box, outer("shop-api: test suite", "--no-skip"), { cwd: repo });
    assert.deepEqual([forced.code, forced.stdout, forced.stderr.includes("skipped:")], [0, "inner ran\n", false], forced.stderr);
    const plain = await cli(box, outer("shop-api: test suite again"), { cwd: repo });
    assert.deepEqual([plain.code, plain.stdout], [0, ""]);
    assert.equal(plain.stderr.includes('skipped: "shop-api: unit tests"'), true, plain.stderr);
    assert.deepEqual(journal(box).map((line) => [line.label, line.outcome, line.nested ?? false]), [
        ["shop-api: unit tests", "ran", false],
        ["shop-api: unit tests", "ran", true], ["shop-api: test suite", "ran", false],
        ["shop-api: unit tests", "skipped", true], ["shop-api: test suite again", "ran", false],
    ]);
});

test("run: a step nested in a build or deploy job is never skipped, so the job gets the output it needs", async () => {
    const box = sandbox(), repo = makeRepo(join(box.work, "lib"), { ".gitignore": "out/\n", "src.ts": "export {};\n" });
    // The step makes out/src.js, which git ignores; the outer job removes it first and then needs it.
    const step = ["--label", "lib: tsc", "--kind", "lint", "--", NODE, "-e",
        "const fs = require('node:fs'); fs.mkdirSync('out', { recursive: true }); fs.copyFileSync('src.ts', 'out/src.js')"];
    const needsOutput = "const fs = require('node:fs'); fs.rmSync('out', { recursive: true, force: true }); "
        + `const r = require('node:child_process').spawnSync(process.execPath, ${J([CLI, "run", ...step])}, { stdio: 'inherit' }); `
        + "process.exit(r.status || (fs.existsSync('out/src.js') ? 0 : 9))";
    for (const label of ["lib: build", "lib: deploy preview", "lib: refresh docs"]) {
        const ran = await cli(box, ["run", "--label", label, "--", NODE, "-e", needsOutput], { cwd: repo });
        assert.deepEqual([ran.code, ran.stderr.includes("skipped:")], [0, false], `${label}: ${ran.stderr}`);
    }
    assert.deepEqual(journal(box).filter((line) => line.label === "lib: tsc").map((line) => line.outcome), ["ran", "ran", "ran"]);
    // Run by itself, the same step is skipped on its pass.
    assert.equal((await cli(box, ["run", ...step], { cwd: repo })).stderr.startsWith('dotime-queue: skipped: "lib: tsc"'), true);
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
    assert.deepEqual(rows.slice(1).map((row) => row.split(";")[0]).sort(), [
        "all projects: jobs 2, failed 1, stopped 0, timed out 0, refused 0, gave up 0",
        "docs-site: jobs 1, failed 0, stopped 0, timed out 0, refused 0, gave up 0",
        "shop-api: jobs 1, failed 1, stopped 0, timed out 0, refused 0, gave up 0",
    ]);
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
    assert.deepEqual([labelAsValue.code, labelAsValue.stdout, labelAsValue.stderr], [
        2,
        "",
        'dotime-queue: option --label needs a value; give --label a value, or for the value "--priority" write --label=--priority\n',
    ]);
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

test("status: changes nothing in the state folder, also with the slot file of a dead job in it", async () => {
    const box = sandbox(), slot = join(box.home, "slots", "slot-0.json");
    assert.equal((await cli(box, ["status"])).code, 0);
    assert.deepEqual(readdirSync(box.home), ["config.json"]);
    mkdirSync(join(box.home, "slots"));
    writeFileSync(slot, JSON.stringify({ pid: 2 ** 30 + 7, label: "docs-site: build", at: Date.now() }));
    assert.equal((await cli(box, ["status"])).stdout, `slots: 0 of ${DEFAULTS.slots} taken, 0 waiting\ngate: open\n`);
    assert.deepEqual([readdirSync(box.home).sort(), existsSync(slot)], [["config.json", "slots"], true]);
});

// Starts the queue in a folder that the shell enters and removes first.
function fromGone(box, args) {
    const gone = join(box.work, "removed-worktree");
    const words = [NODE, CLI, ...args].map((word) => JSON.stringify(word)).join(" ");
    mkdirSync(gone);
    const script = `cd ${JSON.stringify(gone)} && rmdir ${JSON.stringify(gone)} && exec ${words}`;
    return new Promise((resolve) => {
        const child = track(spawn("/bin/sh", ["-c", script], { env: box.env, stdio: ["ignore", "pipe", "pipe"] }));
        const seen = { stdout: "", stderr: "" };
        child.stdout.on("data", (text) => { seen.stdout += text; });
        child.stderr.on("data", (text) => { seen.stderr += text; });
        child.on("close", (code) => resolve({ code, ...seen }));
    });
}

test("status, history and passed --cwd: work from a folder that was removed", async () => {
    const box = sandbox();
    const repo = makeRepo(join(box.work, "shop-api"));
    const history = await fromGone(box, ["history", "--days", "1"]);
    assert.deepEqual([history.code, history.stderr], [0, ""]);
    assert.equal(history.stdout.endsWith(", jobs 0\n"), true);
    const status = await fromGone(box, ["status"]);
    assert.deepEqual([status.code, status.stderr], [0, ""]);
    const passed = await fromGone(box, ["passed", "--cwd", repo]);
    assert.deepEqual([passed.code, passed.stderr], [1, ""]);
    assert.equal(passed.stdout.startsWith("no stamp: "), true);
});

test("passed: without --cwd, from a folder that was removed, one clear line and the usage exit code", async () => {
    const passed = await fromGone(sandbox(), ["passed"]);
    assert.deepEqual([passed.code, passed.stdout, passed.stderr],
        [2, "", "dotime-queue: the current folder was removed; run passed from a folder that exists, or name one with --cwd <dir>\n"]);
});

test("passed: a repository with no commits yet is named as such, exit 1", async () => {
    const box = sandbox(), empty = join(box.work, "new-library"), plain = join(box.work, "plain-folder");
    mkdirSync(empty);
    mkdirSync(plain);
    testGit(empty, "init", "-q");
    const fresh = await cli(box, ["passed"], { cwd: empty });
    assert.deepEqual([fresh.code, fresh.stdout], [1, "no stamp: the current branch has no commits yet\n"]);
    const outside = await cli(box, ["passed", "--cwd", plain]);
    assert.deepEqual([outside.code, outside.stdout], [1, "no stamp: this folder is not a git checkout\n"]);
});

test("run: from a folder that was removed, a usage error is reported as usual and a valid run is refused", async () => {
    const box = sandbox();
    const noCommand = await fromGone(box, ["run", "--label", "docs-site: build"]);
    assert.deepEqual([noCommand.code, noCommand.stdout, noCommand.stderr], [2, "", `${USAGE}\n`]);
    const unknown = await fromGone(box, ["frobnicate"]);
    assert.deepEqual([unknown.code, unknown.stdout, unknown.stderr], [2, "", `${USAGE}\n`]);
    const badLimit = await fromGone(box, ["run", "--label", "docs-site: build", "--max-run", "0", "--", "true"]);
    assert.deepEqual([badLimit.code, badLimit.stdout, badLimit.stderr], [2, "", "dotime-queue: --max-run wants a positive number of minutes\n"]);
    const valid = await fromGone(box, ["run", "--label", "docs-site: build", "--", "true"]);
    assert.deepEqual([valid.code, valid.stdout, valid.stderr],
        [2, "", "dotime-queue: the current folder was removed; start the job from a folder that exists\n"]);
    assert.deepEqual([journal(box), slots(box)], [[], []]);
});

test("status: the same lines with the macOS and the Linux readings, also where /proc and /sys cannot be read", () => {
    const box = sandbox();
    for (const platform of ["darwin", "linux"]) {
        const ran = spawnSync(NODE, [...asPlatform(platform), CLI, "status"], {
            cwd: box.work, env: box.env, encoding: "utf8", timeout: 60_000,
        });
        const lines = "slots: 0 of 2 taken, 0 waiting\ngate: open\n";
        assert.deepEqual([ran.status, ran.stdout, ran.stderr], [0, lines, ""], platform);
    }
});
