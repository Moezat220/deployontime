// Signals go only to processes that this file starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolateProcess, makeRepo, pause, tempDir, track, until } from "./testkit.mjs";

const HOME = isolateProcess("limits");
const {
    addNotice, afterMinutes, cmdStem, codePrint, DEBUG_CMD_RE, DEBUG_LABEL_RE, decideLimit, failStop, idleAlert, jobCpu,
    killTree, KINDS, kindOf, kindStats, longRunAlert, opt, parseMaxRun, psRows, slotIdleCheck, slotIdleStep, stemStats,
    treePids, UNLABELLED, UNTRACKED,
} = await import("./limits.mjs");
const { alive } = await import("./slots.mjs");
const { DEFAULTS } = await import("./settings.mjs");

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NOW = Date.UTC(2031, 8, 3, 7, 0);
const isDebug = (label, command) => kindOf(label, command) === "debug";
// The limits these tests calculate with, set here so that the shipped defaults can change freely.
const L = { ...DEFAULTS.limits, defaultMin: 30, debugMin: 15, floorMin: 10, p90Factor: 1.5, longRunFactor: 2, longRunUnmeasuredMin: 20, minSamples: 5, windowDays: 14, failWindowHours: 6, priorityGrace: 2 };
const ago = (ms) => new Date(NOW - ms).toISOString();

test("afterMinutes: follows the fake clock file when the state folder is inside the temp folder", async () => {
    const clock = join(HOME, "clock-a");
    let calls = 0;
    afterMinutes(6, () => calls++, { DOTIME_HOME: HOME, DOTIME_FAKE_CLOCK: clock });
    await pause(150);
    writeFileSync(clock, "5");
    await pause(150);
    assert.equal(calls, 0);
    writeFileSync(clock, "6");
    await until(() => calls === 1, 2000);
    writeFileSync(clock, "60");
    await pause(150);
    assert.equal(calls, 1);
});

test("afterMinutes: a wait longer than one timer can hold does not fire early", async () => {
    let calls = 0;
    const timer = afterMinutes(99_999, () => calls++, {});
    await new Promise((done) => setTimeout(done, 50));
    clearTimeout(timer);
    assert.equal(calls, 0);
});

test("afterMinutes: uses a real timer everywhere else", async () => {
    const clock = join(HOME, "clock-b"), outsideTemp = dirname(fileURLToPath(import.meta.url));
    writeFileSync(clock, "0");
    let calls = 0;
    const timers = [afterMinutes(0.001, () => calls++, { DOTIME_FAKE_CLOCK: clock }), afterMinutes(0.001, () => calls++, { DOTIME_HOME: outsideTemp, DOTIME_FAKE_CLOCK: clock })];
    await until(() => calls === 2, 2000);
    const slow = afterMinutes(30, () => calls++, { DOTIME_HOME: outsideTemp, DOTIME_FAKE_CLOCK: clock });
    writeFileSync(clock, "30");
    await pause(150);
    assert.equal(calls, 2);
    for (const timer of [...timers, slow]) clearTimeout(timer);
});

test("isDebug: a debug word or a question mark in the label's task part, or a debug word in a command the label leaves open", () => {
    assert.equal(DEBUG_LABEL_RE.test("docs-site: is the sitemap stale?"), true);
    assert.equal(DEBUG_CMD_RE.test("node tools/bisect-flaky.mjs"), true);
    for (const [label, command] of [["shop-api: repro of the timeout", "pnpm test"], ["shop-api: nightly", "node scripts/probe.mjs"], ["mobile-app: why is the bundle big?", "make size"], ["shop-api: Debug run", "pnpm test"]]) {
        assert.equal(isDebug(label, command), true, label);
    }
    for (const [label, command] of [["shop-api: suite", "DEBUG=api pnpm test"], ["docs-site: build", "pnpm run build"], ["mobile-app: debugger bundle", "make bundle"], ["probe-api: suite", "pnpm test"], ["shop-api: suite", "node scripts/probe.mjs"], [undefined, undefined]]) {
        assert.equal(isDebug(label, command), false, String(label));
    }
});

test("kindOf: a given kind wins; the label's task part is read before the command, a debug word before the kind list", () => {
    assert.deepEqual(KINDS.map(([name]) => name), ["deploy", "test", "build", "lint"]);
    const cases = [
        ["mobile-app: publish to the store", "make ship", undefined, "deploy"],
        ["docs-site: compile, then link check", "make all", undefined, "test"],
        ["shop-api: bundle and format", "make all", undefined, "build"],
        ["shop-api: typecheck", "pnpm exec tsc --noEmit", undefined, "lint"],
        ["shop-api: nightly", "npx playwright test", undefined, "test"],
        ["test: nightly", "make nightly", undefined, "other"],
        ["shop-api: nightly", "make nightly", undefined, "other"],
        ["shop-api: nightly", "make nightly", "Deploy", "deploy"],
        ["shop-api: repro of the release failure", "make release", undefined, "debug"],
        ["shop-api: repro of the release failure", "make release", "test", "test"],
        ["shop-api: unit tests", "npm run probe", undefined, "test"],
        ["probe-api: unit tests", "npm test", undefined, "test"],
        ["probe-api: nightly", "make nightly", undefined, "other"],
        ["shop-api: nightly", "node scripts/probe.mjs", undefined, "debug"],
    ];
    for (const [label, command, given, kind] of cases) assert.equal(kindOf(label, command, given), kind, `${label} | ${command}`);
});

test("cmdStem: keeps the program and its task, drops paths, flags and variables", () => {
    const cases = [
        ["pnpm run lint --fix", "pnpm run lint"],
        ["yarn test --coverage", "yarn test"],
        ["pnpm exec tsc --noEmit", "pnpm exec tsc"],
        ["NODE_ENV=test env TZ=UTC /opt/tools/bin/node scripts/migrate.mjs --dry", "node migrate.mjs"],
        ["npx playwright test --project=mobile", "npx playwright test"],
        ["npx tsx scripts/export.ts ./out", "npx tsx export.ts"],
        ["npx eslint ./src", "npx eslint"],
        ["bunx vitest run", "bunx vitest run"],
        ["python3 tools/report.py --week", "python3 report.py"],
        ["make dist ./out", "make dist"],
        ["cargo build --release", "cargo build"],
        ["./scripts/run-all.sh quick", "run-all.sh quick"],
        ["/usr/bin/true", "true"],
    ];
    for (const [command, stem] of cases) assert.equal(cmdStem(command), stem, command);
});

test("cmdStem: joins the stems of the commands inside sh -c", () => {
    assert.equal(cmdStem('bash -c "pnpm run build && pnpm run lint; node scripts/pack.mjs"'), "pnpm run build && pnpm run lint && node pack.mjs");
    assert.equal(cmdStem('sh -c "make docs | tee build.log"'), "make docs && tee build.log");
});

test("cmdStem: null for inline code and for an empty command", () => {
    for (const command of ["CI=1", 'bun --eval "0"', 'bash -c ""', undefined, 'tsx -e "void 0"', 'python3 -c "print(1)"', ""]) assert.equal(cmdStem(command), null, String(command));
});

const passed = (runMin, fields = {}) => JSON.stringify({ projectKey: "docs-site", label: "docs-site: build", cmd: "pnpm run build", kind: "build", outcome: "ran", exit: 0, runMin, endedAt: ago(2 * HOUR), ...fields });
const HISTORY = [
    passed(3), passed(5), passed(8), passed(12),
    passed(30, { cmd: "pnpm run build:pdf" }),
    passed(4, { kind: undefined, label: "docs-site: bundle", cmd: "make bundle" }),
    passed(20, { exit: 1 }),
    passed(6, { outcome: "stopped" }),
    passed(7, { projectKey: "shop-api" }),
    passed(9, { endedAt: ago(20 * DAY) }),
    passed(2, { endedAt: ago(-HOUR) }),
    "not a journal line",
];

test("kindStats: counts passed runs of the kind in the project and the time window", () => {
    assert.deepEqual(kindStats(HISTORY, { project: "docs-site", kind: "build", now: NOW, windowDays: 14 }), { n: 6, p75: 12, p90: 30 });
    assert.deepEqual(kindStats(HISTORY, { project: "docs-site", kind: "build", now: NOW, windowDays: 30 }), { n: 7, p75: 12, p90: 30 });
    assert.deepEqual(kindStats(HISTORY, { project: "docs-site", kind: "deploy", now: NOW, windowDays: 14 }), { n: 0, p75: null, p90: null });
    assert.equal(kindStats(HISTORY, { project: "shop-api", kind: "build", now: NOW }).n, 1);
});

test("stemStats: counts passed runs with the same command stem", () => {
    assert.deepEqual(stemStats(HISTORY, { project: "docs-site", stem: "pnpm run build", now: NOW, windowDays: 14 }), { n: 4, p75: 8, p90: 12, max: 12, stem: "pnpm run build" });
    assert.deepEqual(stemStats(HISTORY, { project: "docs-site", stem: "make docs", now: NOW }), { n: 0, p75: null, p90: null, max: null, stem: "make docs" });
    assert.deepEqual(stemStats(HISTORY, { project: "docs-site", stem: null, now: NOW }), { n: 0, stem: null });
});

const E2E = "pnpm run test:e2e";

test("decideLimit: --max-run wins over any history", () => {
    const limit = decideLimit({ maxRun: 45, kind: "test", stats: { n: 9, p75: 2, p90: 3 } }, L);
    assert.deepEqual([limit.limitMin, limit.killMin, limit.basis, limit.longRunMin, limit.notifyLongRun], [45, 45, "the --max-run flag", 10, true]);
});

test("decideLimit: a debug job gets the debug limit whatever its history says", () => {
    const limit = decideLimit({ kind: "debug", stats: { n: 12, p75: 40, p90: 55 } }, L);
    assert.deepEqual([limit.limitMin, limit.basis, limit.longRunMin, limit.notifyLongRun], [L.debugMin, "the debug-job setting", 80, false]);
});

test("decideLimit: enough runs of the kind set the limit and the long-run mark", () => {
    assert.deepEqual(decideLimit({ kind: "build", stats: { n: 7, p75: 9, p90: 14 } }, L), {
        limitMin: 21, basis: "7 passed runs of kind build (1.5 times their p90 of 14 min)",
        longRunMin: 18, longRunBasis: "2 times the p75 of 9 min over 7 passed runs of kind build", killMin: 21, notifyLongRun: true,
    });
});

test("decideLimit: a measured limit is never below the minimum", () => {
    const limit = decideLimit({ kind: "lint", stats: { n: 5, p75: 1.5, p90: 2.2 } }, L);
    assert.deepEqual([limit.limitMin, limit.basis, limit.longRunMin, limit.notifyLongRun], [10, "5 passed runs of kind lint (1.5 times their p90 of 2.2 min, lifted to the 10 min minimum)", 10, false]);
});

test("decideLimit: too few runs give the default limit and the fixed long-run mark", () => {
    assert.deepEqual(decideLimit({ kind: "lint", stats: { n: 4, p75: 1, p90: 1 } }, L), {
        limitMin: L.defaultMin, basis: "the default (4 of the 5 passed runs needed for kind lint)",
        longRunMin: L.longRunUnmeasuredMin, longRunBasis: "the 20 min setting for jobs without history", killMin: L.defaultMin, notifyLongRun: true,
    });
    assert.equal(decideLimit({ kind: "other" }, L).basis, "the default (0 of the 5 passed runs needed for kind other)");
});

test("decideLimit: enough runs of the same command decide instead of the kind", () => {
    const limit = decideLimit({ kind: "test", stats: { n: 40, p75: 2, p90: 3 }, stem: { n: 6, p75: 22, p90: 26, max: 31, stem: E2E } }, L);
    assert.deepEqual([limit.limitMin, limit.basis, limit.longRunMin], [39, `6 passed runs of command "${E2E}" (1.5 times their p90 of 26 min)`, 44]);
});

test("decideLimit: a few longer runs of the same command raise the kind's limit and mark", () => {
    const limit = decideLimit({ kind: "test", stats: { n: 40, p75: 2, p90: 3 }, stem: { n: 3, p75: 16, p90: 18, max: 18, stem: E2E } }, L);
    assert.equal(limit.limitMin, 27);
    assert.equal(limit.basis, `18 min, the longest passed run of command "${E2E}" (3 on record), times 1.5; that is more than 40 passed runs of kind test (1.5 times their p90 of 3 min, lifted to the 10 min minimum)`);
    assert.deepEqual([limit.longRunMin, limit.longRunBasis], [32, `2 times the p75 of 16 min over 3 passed runs of command "${E2E}"`]);
    const shorter = decideLimit({ kind: "test", stats: { n: 40, p75: 9, p90: 14 }, stem: { n: 3, p75: 4, p90: 5, max: 5, stem: E2E } }, L);
    assert.deepEqual([shorter.limitMin, shorter.longRunMin], [21, 18]);
});

test("decideLimit: a few runs of the command never raise a limit set by flag or by debug", () => {
    const stem = { n: 3, p75: 16, p90: 18, max: 18, stem: E2E };
    assert.deepEqual([decideLimit({ maxRun: 12, kind: "test", stem }, L).limitMin, decideLimit({ kind: "debug", stem }, L).limitMin], [12, L.debugMin]);
});

test("decideLimit: a priority job is stopped at a multiple of its limit", () => {
    const short = decideLimit({ maxRun: 8, kind: "deploy", priority: true }, L), long = decideLimit({ maxRun: 15, kind: "deploy", priority: true }, L);
    assert.deepEqual([short.limitMin, short.killMin, short.notifyLongRun], [8, 16, false]);
    assert.deepEqual([long.limitMin, long.killMin, long.notifyLongRun], [15, 30, true]);
    assert.equal(decideLimit({ maxRun: 8, kind: "deploy", priority: true }, { ...L, priorityGrace: 3.5 }).killMin, 28);
});

test("decideLimit: works from the settings it is handed", () => {
    const custom = { ...L, minSamples: 2, p90Factor: 3, longRunFactor: 4, floorMin: 1 };
    const limit = decideLimit({ kind: "build", stats: { n: 2, p75: 2, p90: 2.5 } }, custom);
    assert.deepEqual([limit.limitMin, limit.longRunMin], [7.5, 8]);
});

test("opt: reads a flag in either spelling, in front of the -- only", () => {
    const args = ["run", "--label", "mobile-app: bundle", "--kind=build", "--after-fix=", "--", "make", "--kind", "lint", "--label=inner"];
    assert.deepEqual([opt(args, "--label"), opt(args, "--kind"), opt(args, "--after-fix"), opt(args, "--max-run")], ["mobile-app: bundle", "build", "", undefined]);
    assert.equal(opt(["passed", "--match", "suite"], "--match"), "suite");
});

test("parseMaxRun: null when absent, the minutes when valid, NaN otherwise", () => {
    assert.equal(parseMaxRun(["run", "--", "make"]), null);
    assert.equal(parseMaxRun(["run", "--max-run", "0.5", "--", "make"]), 0.5);
    assert.equal(parseMaxRun(["run", "--max-run=90", "--", "make"]), 90);
    for (const value of ["Infinity", "", "x9", "-4", "0"]) assert.equal(Number.isNaN(parseMaxRun(["run", `--max-run=${value}`, "--", "make"])), true, value);
});

const write = (dir, name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); };

test("codePrint: stable while nothing changes, different after an edit to tracked or untracked code", () => {
    const repo = makeRepo(join(tempDir("limits"), "shop-api"), { "src/cart.js": "export const items = [];\n" });
    const start = codePrint(repo, ["pnpm", "test"]);
    assert.equal(/^[0-9a-f]{16}$/.test(start), true);
    assert.equal(codePrint(repo, ["pnpm", "test"]), start);
    write(repo, "src/cart.js", "export const items = [1];\n");
    const edited = codePrint(repo, ["pnpm", "test"]);
    write(repo, "src/cart.test.js", "// first draft\n");
    const added = codePrint(repo, ["pnpm", "test"]);
    write(repo, "src/cart.test.js", "// second draft\n");
    assert.equal(new Set([start, edited, added, codePrint(repo, ["pnpm", "test"])]).size, 4);
});

test("codePrint: output folders and binary files do not count as code", () => {
    const repo = makeRepo(join(tempDir("limits"), "docs-site"));
    const rewrite = (round) => {
        for (const name of ["dist/site.js", ".next/cache/page.json", "coverage/lcov.info", "packages/ui/.turbo/build.log", ".wrangler/state.txt", "report.pdf", "screens/home.png"]) write(repo, name, `output ${round}`);
        return codePrint(repo);
    };
    const withOutput = rewrite(1);
    assert.equal(rewrite(2), withOutput);
    write(repo, "packages/ui/index.js", "export {};\n");
    assert.notEqual(codePrint(repo), withOutput);
});

test("codePrint: the list of output folders can be replaced", () => {
    const repo = makeRepo(join(tempDir("limits"), "mobile-app"));
    write(repo, "generated/api.js", "v1");
    const [counted, skipped] = [codePrint(repo), codePrint(repo, [], ["generated"])];
    write(repo, "generated/api.js", "v2");
    assert.notEqual(codePrint(repo), counted);
    assert.equal(codePrint(repo, [], ["generated"]), skipped);
    assert.equal(UNTRACKED.maxFiles > 0 && UNTRACKED.maxFileBytes > 0, true);
});

test("codePrint: a script named in the command counts, also outside git", () => {
    const dir = tempDir("limits");
    write(dir, "task.mjs", "console.log(1);\n");
    const before = codePrint(dir, ["node", "task.mjs"]);
    assert.equal(codePrint(dir, ["node", "task.mjs"]), before);
    write(dir, "task.mjs", "console.log(2);\n");
    assert.notEqual(codePrint(dir, ["node", "task.mjs"]), before);
    assert.equal(/^[0-9a-f]{16}$/.test(codePrint(dir, ["node", join(dir, "absent.mjs")])), true);
});

const SUITE = "shop-api: integration suite";
const failure = (minutesAgo, fields = {}) => JSON.stringify({ projectKey: "shop-api", label: SUITE, cmd: "pnpm run test:integration", cwd: "/srv/shop-api", outcome: "ran", exit: 7, head: "ab12cd34ef", fp: "f00d", endedAt: ago(minutesAgo * MINUTE), ...fields });
const job = { label: SUITE, cmd: "pnpm run test:integration", project: "shop-api", cwd: "/srv/shop-api", head: "ab12cd34ef", fp: "f00d", at: NOW };
const verdict = (lines, thisJob = job) => failStop(lines, thisJob, L, "UTC");
const TWICE = [failure(95), failure(40)];

test("failStop: matches earlier runs by label first, and by command plus project plus folder otherwise", () => {
    const unnamed = [failure(95, { label: UNLABELLED, cmd: "make a" }), failure(40, { label: UNLABELLED, cmd: "make b" })];
    assert.equal(verdict(unnamed, { ...job, label: UNLABELLED, cmd: "make c" }).refuse, false);
    assert.equal(verdict(TWICE, { ...job, label: "shop-api: api suite", project: "docs-site" }).refuse, false);
    assert.equal(verdict(TWICE, { ...job, label: "shop-api: api suite", cwd: "/srv/shop-api-copy" }).refuse, false);
    assert.equal(verdict(TWICE, { ...job, label: "shop-api: api suite" }).refuse, true);
});

test("failStop: lets the run through and says whether the commit or the files moved", () => {
    assert.deepEqual(verdict(TWICE, { ...job, fp: "beef" }), { refuse: false, changed: "files" });
    assert.deepEqual(verdict(TWICE, { ...job, head: "9988776655" }), { refuse: false, changed: "commit" });
    assert.equal(verdict(TWICE, { ...job, fp: null }).refuse, true);
});

test("failStop: a changed command under the same label is a new attempt, not a third failure", () => {
    assert.deepEqual(verdict(TWICE, { ...job, cmd: "pnpm run test:integration --runInBand" }), { refuse: false, changed: "command" });
    assert.equal(verdict(TWICE, { ...job, cmd: null }).refuse, true);
});

test("limits: exports no helper that only the tests use", async () => {
    const exported = await import("./limits.mjs");
    for (const name of ["isDebug", "pctl"]) assert.equal(name in exported, false, name);
});

test("failStop: allows a third run once the code differs between the two failures", () => {
    assert.deepEqual(verdict([failure(95, { head: "9988776655" }), failure(40)]), { refuse: false });
    assert.deepEqual(verdict([failure(95, { fp: "beef" }), failure(40)]), { refuse: false });
});

test("failStop: two failures that ran different commands are not the same failure twice", () => {
    assert.deepEqual(verdict([failure(95, { cmd: "pnpm run test:integration --wrong-flag" }), failure(40)]), { refuse: false });
    assert.equal(verdict([failure(95, { cmd: null }), failure(40)]).refuse, true);
});

test("failStop: lets the run through without two fresh failures in a row", () => {
    assert.deepEqual(verdict([failure(9 * 60), failure(40)]), { refuse: false });
    assert.deepEqual(verdict([failure(95, { outcome: "gave-up", exit: 75 }), failure(40)]), { refuse: false });
    assert.deepEqual(verdict([failure(95, { exit: 0 }), failure(40)]), { refuse: false });
    assert.deepEqual(verdict([failure(120), failure(95), failure(40, { exit: 0 })]), { refuse: false });
    assert.deepEqual(verdict([failure(40)]), { refuse: false });
    assert.deepEqual(verdict([]), { refuse: false });
});

test("failStop: skips runs that someone stopped when it looks for the last two", () => {
    assert.equal(verdict([failure(120), failure(95), failure(40, { exit: 137 }), failure(10, { outcome: "stopped", exit: 129 })]).refuse, true);
});

test("failStop: refuses the third run on unchanged code and tells how the two before it ended", () => {
    assert.deepEqual(verdict([failure(40, { outcome: "timed-out", exit: 124 }), failure(95)]), {
        refuse: true,
        reason: `same check failed twice on unchanged code: "${SUITE}", commit ab12cd34, exit 7 at 05:25 UTC, then run limit hit at 06:20 UTC; hint: change the code, or pass --after-fix "<note>" before the -- to run it anyway`,
    });
    assert.equal(verdict([failure(95, { head: undefined }), failure(40, { head: undefined })]).reason.includes("commit"), false);
});

test("longRunAlert: names the job, the jobs it holds up, its limit and the stop time", () => {
    const startedAt = NOW - 22 * MINUTE, waiting = [{ label: "shop-api: lint", at: NOW - 7 * MINUTE }, { label: "mobile-app: bundle", at: NOW - 30_000 }];
    const alert = longRunAlert({ label: "docs-site: build", project: "docs-site", pid: 6340, minutes: 22, longRunBasis: "the 20 min setting for jobs without history", limitMin: 30, killMin: 30, startedAt, waiting, now: NOW, tz: "UTC" });
    assert.equal(alert.title, "dotime: job running long");
    assert.equal(alert.message, 'long run: "docs-site: build" of project docs-site, pid 6340, holding up "shop-api: lint" (7 min) and "mobile-app: bundle" (1 min), 22 min in its slot, long-run mark from the 20 min setting for jobs without history, limit 30 min, hard stop at 07:08 UTC');
    assert.equal(alert.key, `long-run:6340:${startedAt}`);
    assert.deepEqual(alert.entry, { type: "long-run", project: "docs-site", label: "docs-site: build", pid: 6340, minutes: 22, detail: "mark from the 20 min setting for jobs without history, limit 30 min, hard stop at 07:08 UTC", waiting: ["shop-api: lint", "mobile-app: bundle"], at: NOW });
});

test("idleAlert: names the job, its CPU use, and when its limit is reached if it has one", () => {
    const startedAt = NOW - 35 * MINUTE, base = { label: "mobile-app: bundle", project: "mobile-app", pid: 5160, usedS: 1.7, minutes: 12, startedAt, now: NOW, tz: "UTC" };
    const alert = idleAlert({ ...base, killMin: 60 });
    assert.equal(alert.title, "dotime: slot held by a quiet job");
    assert.equal(alert.message, 'idle slot: "mobile-app: bundle" of project mobile-app, pid 5160, holding up no other job, 1.7 s of CPU in 12 min, not stopped, limit reached at 07:25 UTC');
    assert.equal(alert.key, `idle-slot:5160:${startedAt}`);
    assert.deepEqual(alert.entry, { type: "idle-slot", project: "mobile-app", label: "mobile-app: bundle", pid: 5160, minutes: 12, usedS: 1.7, detail: "1.7 s of CPU in 12 min", waiting: [], at: NOW });
    assert.equal(idleAlert(base).message.includes("limit reached"), false);
});

const TABLE = [
    "  4100     1  4100   0:04.00",
    "  4101  4100  4100   0:06.50",
    "  4102  4101  4102   0:01.25",
    "  4103  4102  4102   0:00.25",
    "  4300     1  4100   0:02.00",
    "  4200     1  4200   0:30.00",
].join("\n");

test("psRows: one row per process line, with CPU time in seconds", () => {
    assert.deepEqual(psRows("  4100     1  4100   0:03.75\n  4101  4100  4100  12:00.00\n  PID  PPID  PGID      TIME\n\n  4102  4101  4102\n"), [
        { pid: 4100, ppid: 1, pgid: 4100, cpu: 3.75 }, { pid: 4101, ppid: 4100, pgid: 4100, cpu: 720 }, { pid: 4102, ppid: 4101, pgid: 4102, cpu: 0 },
    ]);
    assert.deepEqual(psRows(undefined), []);
});

test("treePids: a leader's pids include a child that started a group of its own", () => {
    assert.deepEqual(treePids(4100, TABLE).sort(), [4100, 4101, 4102, 4103, 4300]);
    assert.deepEqual(treePids(4200, TABLE), [4200]);
    assert.deepEqual(treePids(4999, TABLE), [4999]);
});

test("jobCpu: sums the job's processes, and is null when its leader is gone", () => {
    const rows = psRows(TABLE);
    assert.equal(jobCpu({ pid: 4000, pgid: 4100 }, rows), 14);
    assert.equal(jobCpu({ pid: 4200 }, rows), 30);
    assert.equal(jobCpu({ pid: 4000, pgid: 4999 }, rows), null);
});

const SLOT_IDLE = { ...DEFAULTS.idle, slotIdleMin: 10, slotCpuS: 5 };
const holder = { pid: 3300, pgid: 3301, label: SUITE, project: "shop-api", startedAt: NOW - 40 * MINUTE, killMin: 90 };
const cpuTable = (seconds, pgid = 3301) => `${pgid} 3300 ${pgid} 0:${seconds.toFixed(2).padStart(5, "0")}\n`;
const step = (state, minutesFromNow, ps, holders = [holder], idle = SLOT_IDLE) => slotIdleStep({ holders, ps, state, now: NOW + minutesFromNow * MINUTE, idle, tz: "UTC" });

test("slotIdleStep: one alert once a job has been idle for the window, then silence", () => {
    let run = step({}, -12, cpuTable(20));
    assert.deepEqual(run.alerts, []);
    run = step(run.state, -6, cpuTable(21));
    assert.deepEqual(run.alerts, []);
    run = step(run.state, 0, cpuTable(21.5));
    assert.deepEqual(run.alerts.map((a) => [a.entry.project, a.entry.pid, a.entry.usedS, a.entry.minutes]), [["shop-api", 3300, 1.5, 12]]);
    assert.equal(run.alerts[0].message.includes("not stopped, limit reached at 07:50 UTC"), true);
    run = step(run.state, 6, cpuTable(21.5));
    assert.deepEqual([run.alerts, Object.values(run.state)[0].told], [[], true]);
});

test("slotIdleStep: no alert for a job that keeps using CPU", () => {
    let run = { state: {} }, alerts = 0;
    for (let minute = -30; minute <= 0; minute += 5) { run = step(run.state, minute, cpuTable(40 + minute)); alerts += run.alerts.length; }
    assert.equal(alerts, 0);
});

test("slotIdleStep: keeps the samples of a job missing from one listing, drops a job that left its slot", () => {
    const first = step({}, -12, cpuTable(20));
    assert.deepEqual(step(first.state, -6, "").state, first.state);
    assert.deepEqual(step(first.state, -6, cpuTable(20), []).state, {});
    assert.deepEqual(Object.keys(first.state), [`3300:${holder.startedAt}`]);
});

test("slotIdleStep: samples are kept long enough for a longer idle window", () => {
    const hourWindow = { ...SLOT_IDLE, slotIdleMin: 60 }, longRunning = { ...holder, startedAt: NOW - 3 * HOUR };
    let run = { state: {} }, alertedAt = [];
    for (let minute = -70; minute <= 0; minute += 5) {
        run = step(run.state, minute, cpuTable(9), [longRunning], hourWindow);
        if (run.alerts.length) alertedAt.push(minute);
    }
    assert.deepEqual(alertedAt, [-10]);
    assert.equal(Object.values(run.state)[0].samples.length, 15);
});

test("slotIdleCheck: sends and stores each alert, except on a dry run", () => {
    const state = { [`3300:${holder.startedAt}`]: { samples: [{ t: NOW - 11 * MINUTE, cpu: 20 }] } };
    const sent = [], stored = [];
    const check = (dry) => slotIdleCheck({ holders: [holder], state, now: NOW, dry, notify: (title) => sent.push(title), ps: () => cpuTable(20.4), record: (key) => stored.push(key), idle: SLOT_IDLE });
    const dry = check(true);
    assert.deepEqual([sent, stored], [[], []]);
    assert.equal(dry.lines.length === 1 && dry.lines[0].startsWith(`idle slot: "${SUITE}"`) && dry.lines[0].endsWith("(dry run, no notice sent)"), true);
    const real = check(false);
    assert.deepEqual([sent, stored], [["dotime: slot held by a quiet job"], [`idle-slot:3300:${holder.startedAt}`]]);
    assert.equal(real.lines[0].includes(", holding up no other job, "), true);
    assert.equal(Object.values(real.state)[0].told, true);
});

test("slotIdleCheck: does not list processes when no slot is taken", () => {
    const result = slotIdleCheck({ holders: [], notify: assert.fail, ps: assert.fail, record: assert.fail });
    assert.deepEqual(result, { state: {}, lines: [] });
});

test("addNotice: stores an entry once per key", () => {
    const file = join(tempDir("limits"), "deep", "notices.json");
    assert.deepEqual([addNotice("long-run:1:2", { minutes: 22 }, file), addNotice("long-run:1:2", { minutes: 44 }, file), addNotice("idle-slot:1:2", { minutes: 12 }, file)], [true, false, true]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "long-run:1:2": { minutes: 22 }, "idle-slot:1:2": { minutes: 12 } });
});

test("addNotice: false, without throwing, when the file cannot be written", () => {
    const blocker = join(tempDir("limits"), "plain-file");
    writeFileSync(blocker, "");
    assert.equal(addNotice("long-run:1:2", {}, join(blocker, "notices.json")), false);
});

test("killTree: stops a started job together with a child that left its group", async () => {
    const child = "setInterval(() => {}, 1000)";
    const leaderCode = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { detached: true, stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);`;
    const leader = track(spawn(process.execPath, ["-e", leaderCode], { detached: true, stdio: ["ignore", "pipe", "ignore"] }), { group: true });
    const exited = new Promise((done) => leader.once("exit", done));
    const strayChild = track(await new Promise((done) => leader.stdout.once("data", (text) => done(Number(String(text).trim())))), { group: true });
    assert.deepEqual([alive(leader.pid), alive(strayChild)], [true, true]);
    const signalled = killTree(leader.pid, "SIGKILL");
    assert.deepEqual([signalled.includes(leader.pid), signalled.includes(strayChild)], [true, true]);
    await exited;
    await until(() => !alive(strayChild), 3000);
});
