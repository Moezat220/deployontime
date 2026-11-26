import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateProcess, tempDir } from "./testkit.mjs";

isolateProcess("journal");
const {
    addWait, append, clockMinutes, cmdString, findStamp, historyWindow, isFailedRun, isStopped, jobEnd,
    lineProject, parseLines, readLines, record, summarize,
} = await import("./journal.mjs");

const MINUTE = 60_000, START = Date.UTC(2031, 2, 14, 16, 30);
const iso = (minutesLater) => new Date(START + minutesLater * MINUTE).toISOString();
const run = (fields = {}) => JSON.stringify({
    project: "mobile-app", label: "mobile-app: integration suite", cmd: "npm run test:integration", outcome: "ran", exit: 0,
    head: "1a2b3c4d5e6f", clean: true, endedAt: iso(0), runMin: 6.5, ...fields,
});

test("parseLines: keeps JSON lines and objects, skips anything else", () => {
    assert.deepEqual(parseLines(['{"exit":0}', "", "{half", { exit: 5 }, null, "[]"]), [{ exit: 0 }, { exit: 5 }, []]);
});

test("addWait: adds the time to every gate in the blocks", () => {
    const tally = addWait({}, [{ gate: "slots" }], 4_000);
    addWait(tally, [{ gate: "load" }, { gate: "disk" }], 1_500);
    addWait(tally, [], 9_000);
    assert.deepEqual(addWait(tally, [{ gate: "slots" }, { gate: "load" }], 500), { slots: 4_500, load: 2_000, disk: 1_500 });
});

test("cmdString: quotes an argument only when it holds unusual characters", () => {
    assert.equal(cmdString(["pnpm", "run", "test:integration", "--shard=2/4"]), "pnpm run test:integration --shard=2/4");
    assert.equal(cmdString(["sh", "-c", "make lint && make docs"]), 'sh -c "make lint && make docs"');
    assert.equal(cmdString(["grep", "", 'say "hi"']), 'grep "" "say \\"hi\\""');
    assert.equal(cmdString(undefined), "");
});

test("jobEnd: stopped for a stop signal, its exit code, or a signal the queue received", () => {
    assert.deepEqual(jobEnd({ signal: "SIGINT" }), { outcome: "stopped", signal: "SIGINT" });
    assert.deepEqual(jobEnd({ signal: "SIGKILL" }), { outcome: "stopped", signal: "SIGKILL" });
    assert.deepEqual(jobEnd({ code: 143 }), { outcome: "stopped", signal: "SIGTERM" });
    assert.deepEqual(jobEnd({ code: 129 }), { outcome: "stopped", signal: "SIGHUP" });
    assert.deepEqual(jobEnd({ code: 0, received: "SIGTERM" }), { outcome: "stopped", signal: "SIGTERM" });
    assert.deepEqual(jobEnd({ code: 4, received: "SIGINT" }), { outcome: "stopped", signal: "SIGINT" });
});

test("jobEnd: ran for an ordinary exit and for a crash signal", () => {
    for (const end of [{ code: 0 }, { code: 2 }, { code: 127 }, { signal: "SIGABRT" }, { signal: "SIGBUS" }, {}]) assert.deepEqual(jobEnd(end), { outcome: "ran" });
});

test("isStopped, isFailedRun: a stop is not a failure and a time-out is neither", () => {
    const rows = [{ outcome: "stopped", exit: 1 }, { outcome: "ran", exit: 130 }, { outcome: "ran", exit: 137 }, { outcome: "ran", exit: 3 }, { outcome: "ran", exit: 0 }, { outcome: "timed-out", exit: 124 }, { outcome: "gave-up", exit: 75 }];
    assert.deepEqual(rows.map(isStopped), [true, true, true, false, false, false, false]);
    assert.deepEqual(rows.map(isFailedRun), [false, false, false, true, false, false, false]);
});

test("record: times in minutes with one decimal, and the project key from the label", () => {
    const row = record({
        label: "shop-api: build", project: "storefront", cwd: "/srv/storefront", priority: 1, queuedAt: START, startedAt: START + 150_000, endedAt: START + 150_000 + 7.26 * MINUTE,
        outcome: "ran", exit: 0, tally: { slots: 120_000, load: 30_000 }, cmd: "pnpm run build", head: "0f0f0f0f0f", clean: false, extra: { kind: "build", limitMin: 30 },
    });
    assert.deepEqual(
        [row.v, row.project, row.projectKey, row.priority, row.waitMin, row.runMin, row.waitBy, row.queuedAt, row.kind, row.limitMin, row.clean],
        [1, "storefront", "shop-api", true, 2.5, 7.3, { slots: 2, load: 0.5 }, iso(0), "build", 30, false],
    );
});

test("record: a job that never started has its whole life as waiting time", () => {
    const row = record({ label: "typecheck", project: "storefront", queuedAt: START, endedAt: START + 12 * MINUTE, outcome: "gave-up", exit: 75 });
    assert.deepEqual([row.waitMin, row.runMin, row.startedAt, row.exit, row.cmd, row.head, row.waitBy], [12, 0, null, 75, null, null, {}]);
});

test("lineProject: the stored key, else worked out from label, project and folder", () => {
    assert.equal(lineProject({ projectKey: "shop-api", label: "docs-site: build" }), "shop-api");
    assert.equal(lineProject({ label: "docs-site: build", project: "storefront" }), "docs-site");
    assert.equal(lineProject({ label: "typecheck", project: "storefront" }), "storefront");
    assert.equal(lineProject({ label: "typecheck", cwd: "/srv/mobile-app" }), "mobile-app");
});

test("append, readLines: lines come back in order, and a missing file is an empty journal", () => {
    const file = join(tempDir("journal"), "nested", "folder", "journal.jsonl");
    assert.deepEqual(readLines(file), []);
    for (const exit of [0, 2, 0]) assert.equal(append({ exit }, file), true);
    assert.deepEqual(readLines(file).map((line) => JSON.parse(line).exit), [0, 2, 0]);
});

test("append: false, without throwing, when the file cannot be written", () => {
    const blocker = join(tempDir("journal"), "plain-file");
    writeFileSync(blocker, "");
    assert.equal(append({ exit: 0 }, join(blocker, "journal.jsonl")), false);
});

const folder = { project: "mobile-app", head: "1a2b3c4d5e6f", clean: true };
const when = { tz: "UTC", at: START + 25 * MINUTE };
const stamp = (lines, here = folder, match = "") => findStamp(lines, here, match, when);

test("findStamp: found for a passing clean run on the folder's commit", () => {
    const found = stamp([run()]);
    assert.equal(found.stamp.label, "mobile-app: integration suite");
    assert.equal(found.text, 'stamp: commit 1a2b3c4d, passed 25 min ago by "mobile-app: integration suite", command npm run test:integration, run time 6.5 min, tree clean at start, finished 2031-03-14 16:30 UTC');
});

test("findStamp: the match text narrows runs by label or command, in any letter case", () => {
    const lines = [run(), run({ label: "mobile-app: bundle", cmd: "npm run bundle:ios", exit: 3, endedAt: iso(4) })];
    assert.equal(stamp(lines, folder, "INTEGRATION").stamp.cmd, "npm run test:integration");
    assert.equal(stamp(lines, folder, "test:").stamp.cmd, "npm run test:integration");
    assert.equal(stamp(lines, folder, "bundle").text, 'no stamp: newest clean run failed, "mobile-app: bundle", exit 3, commit 1a2b3c4d, ended 2031-03-14 16:34 UTC');
    assert.equal(stamp(lines, folder, "lint").text, 'no stamp: no finished run on record, project mobile-app, filter "lint"');
});

test("findStamp: explains each reason for not finding one", () => {
    assert.equal(stamp([run()], { ...folder, head: null }).text, "no stamp: this folder is not a git checkout");
    assert.equal(stamp([run()], { ...folder, clean: null }).text, "no stamp: git status could not be read");
    assert.equal(stamp([run()], { ...folder, clean: false }).text, "no stamp: the working tree has uncommitted changes");
    assert.equal(stamp([run({ project: "shop-api" })]).text, "no stamp: no finished run on record, project mobile-app");
    assert.equal(stamp([], folder).stamp, null);
    assert.equal(stamp([run()], { ...folder, head: "d00d1e55aa11" }).text, "no stamp: commit differs, folder at d00d1e55, newest run at 1a2b3c4d (ended 2031-03-14 16:30 UTC), project mobile-app");
    assert.equal(stamp([run({ clean: false }), run({ clean: null })]).text, "no stamp: every run at 1a2b3c4d began with uncommitted changes, project mobile-app");
});

test("findStamp: a failure after a pass gives no stamp, a pass after a failure gives one, stops are skipped", () => {
    assert.equal(stamp([run(), run({ exit: 1, endedAt: iso(9) })]).stamp, null);
    assert.equal(stamp([run({ exit: 1 }), run({ endedAt: iso(9) })]).stamp.endedAt, iso(9));
    assert.equal(stamp([run(), run({ outcome: "stopped", exit: 130, endedAt: iso(9) }), run({ exit: 137, endedAt: iso(11) })]).stamp.endedAt, iso(0));
    assert.equal(stamp([run(), run({ outcome: "timed-out", exit: 124, endedAt: iso(9) })]).stamp.endedAt, iso(0));
});

test("historyWindow: whole calendar days in the zone, ending now", () => {
    const now = Date.UTC(2031, 2, 14, 22, 10);
    assert.deepEqual(historyWindow({ days: 1, now, tz: "UTC" }), { from: Date.UTC(2031, 2, 14), to: now, title: "2031-03-14 so far, zone UTC" });
    assert.deepEqual(historyWindow({ days: 3, now, tz: "UTC" }), { from: Date.UTC(2031, 2, 12), to: now, title: "2031-03-12 through 2031-03-14 (3 days), zone UTC" });
    assert.equal(historyWindow({ days: 0.2, now, tz: "UTC" }).from, Date.UTC(2031, 2, 14));
    // 22:10 UTC is already the next morning in Kolkata.
    assert.equal(historyWindow({ days: 1, now, tz: "Asia/Kolkata" }).title, "2031-03-15 so far, zone Asia/Kolkata");
});

test("historyWindow: a single day runs from its midnight to the next, capped at now", () => {
    const now = Date.UTC(2031, 2, 14, 22, 10);
    assert.deepEqual(historyWindow({ day: "2031-03-11", now, tz: "Asia/Kolkata" }), { from: Date.UTC(2031, 2, 10, 18, 30), to: Date.UTC(2031, 2, 11, 18, 30), title: "2031-03-11, zone Asia/Kolkata" });
    assert.equal(historyWindow({ day: "2031-03-14", now, tz: "UTC" }).to, now);
});

test("clockMinutes: overlapping waits count once, and time with a job running is not blocked time", () => {
    const waits = [[2 * MINUTE, 14 * MINUTE], [6 * MINUTE, 20 * MINUTE], [30 * MINUTE, 33 * MINUTE]], runs = [[0, 9 * MINUTE], [31 * MINUTE, 40 * MINUTE]];
    assert.deepEqual(clockMinutes(waits, runs), { waitWallMin: 21, blockedOnlyMin: 12 });
    assert.deepEqual(clockMinutes(waits), { waitWallMin: 21, blockedOnlyMin: 21 });
    assert.deepEqual(clockMinutes([null, [5, 5]], [null]), { waitWallMin: 0, blockedOnlyMin: 0 });
});

test("summarize: median and p90 waits are nearest-rank percentiles, the same as the run limits use", () => {
    const lines = Array.from({ length: 10 }, (_, i) => run({ queuedAt: iso(i), startedAt: iso(i), endedAt: iso(i + 1), waitMin: i + 1 }));
    const { all } = summarize(lines, START, START + 60 * MINUTE);
    assert.deepEqual([all.waitMedian, all.waitP90], [5, 9]);
    assert.deepEqual([summarize([], START, START + MINUTE).all.waitMedian, summarize([], START, START + MINUTE).all.waitP90], [0, 0]);
});

test("summarize: time grows in step with the journal, also when one project has every line", () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => ({ project: "mobile-app", label: "mobile-app: lint", outcome: "ran", exit: 0, queuedAt: iso(i / 1000), waitMin: 0 }));
    const began = performance.now(), { byProject } = summarize(rows, START, START + 60 * MINUTE);
    assert.equal(byProject["mobile-app"].jobs, 50_000);
    assert.ok(performance.now() - began < 1500, "50000 lines took too long");
});

test("summarize: totals per project, most waiting first, inside the time range", () => {
    const lines = [
        run({ queuedAt: iso(0), startedAt: iso(6), endedAt: iso(10), waitMin: 6, waitBy: { slots: 6 }, runMin: 4 }),
        run({ queuedAt: iso(2), startedAt: iso(10), endedAt: iso(11), waitMin: 8, waitBy: { slots: 5, memory: 3 }, runMin: 1, exit: 2 }),
        run({ queuedAt: iso(3), endedAt: iso(3.5), waitMin: 0.5, waitBy: {}, runMin: 0, outcome: "refused", exit: 3 }),
        run({ project: "docs-site", label: "docs-site: build", queuedAt: iso(1), startedAt: iso(1), endedAt: iso(4), waitMin: 0, runMin: 3, outcome: "timed-out", exit: 124 }),
        run({ project: "docs-site", label: "docs-site: link check", queuedAt: iso(5), endedAt: iso(7), waitMin: 2, waitBy: { slots: 2 }, runMin: 0, outcome: "gave-up", exit: 75 }),
        run({ project: "docs-site", label: "docs-site: build", queuedAt: iso(12), startedAt: iso(12), endedAt: iso(13), waitMin: 0, runMin: 1, outcome: "stopped", exit: 143 }),
        run({ queuedAt: iso(-900), startedAt: iso(-900), endedAt: iso(-890), waitMin: 0, runMin: 10 }),
        run({ queuedAt: iso(500), startedAt: iso(500), endedAt: iso(501), waitMin: 0, runMin: 1 }),
    ];
    const { all, byProject } = summarize(lines, START, START + 60 * MINUTE);
    assert.deepEqual(Object.keys(byProject), ["mobile-app", "docs-site"]);
    assert.deepEqual(
        [all.jobs, all.waited, all.waitMinTotal, all.runMinTotal, all.failed, all.stopped, all.timedOut, all.refused, all.gaveUp, all.waitBy],
        [6, 3, 16.5, 9, 1, 1, 1, 1, 1, { slots: 13, memory: 3 }],
    );
    const app = byProject["mobile-app"], docs = byProject["docs-site"];
    assert.deepEqual([app.jobs, app.waitMinTotal, app.waitWallMin, app.blockedOnlyMin, app.waitMedian, app.waitP90], [3, 14.5, 10, 6, 6, 8]);
    assert.deepEqual([docs.jobs, docs.waitWallMin, docs.blockedOnlyMin, docs.gaveUp, docs.timedOut, docs.stopped, docs.failed], [3, 2, 2, 1, 1, 1, 0]);
});
