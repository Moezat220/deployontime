import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { flakyChecks, flakyCounts, flakyFor, flakyLines, flakyNoteFor } from "./flaky.mjs";
import { UNLABELLED } from "./kinds.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2040, 2, 10, 12, 0);
const SUITE = "shop-api: unit tests";
const run = (minutesAgo, fields = {}) => JSON.stringify({
    projectKey: "shop-api", project: "shop-api", label: SUITE, cmd: "npm test", cwd: "/srv/shop-api", outcome: "ran",
    exit: 0, head: "ab12cd34ef", clean: true, endedAt: new Date(NOW - minutesAgo * MINUTE).toISOString(), ...fields,
});
const pass = (minutesAgo, fields) => run(minutesAgo, fields);
const fail = (minutesAgo, fields) => run(minutesAgo, { exit: 1, ...fields });
const job = { label: SUITE, cmd: "npm test", project: "shop-api", cwd: "/srv/shop-api" };
const opts = { now: NOW };

test("flakyFor: a pass and a failure on one clean commit make the check flaky", () => {
    const found = flakyFor([pass(300), fail(120)], job, opts);
    assert.deepEqual(found, {
        mixedCommits: 1, passes: 1, fails: 1, lastEndedAt: new Date(NOW - 120 * MINUTE).toISOString(),
        note: "flaky: this check passed and failed on the same commit once in 14 days, last 2 h ago; "
            + "the failure may not come from your change",
    });
});

test("flakyFor: passes only, or failures only, are not flaky; nor a pass and a failure on two commits", () => {
    assert.equal(flakyFor([pass(300), pass(120)], job, opts), null);
    assert.equal(flakyFor([fail(300), fail(120)], job, opts), null);
    assert.equal(flakyFor([pass(300), fail(120, { head: "9988776655" })], job, opts), null);
    assert.equal(flakyFor([], job, opts), null);
});

test("flakyFor: dirty-tree, timed-out, stopped, skipped, refused and other lines are ignored", () => {
    const ignored = [
        fail(100, { clean: false }), fail(100, { clean: null }), fail(100, { head: null }),
        run(100, { outcome: "timed-out", exit: 124 }), run(100, { outcome: "stopped", exit: 130 }), fail(100, { exit: 143 }),
        run(100, { outcome: "skipped", exit: 0 }), run(100, { outcome: "refused", exit: 3 }),
        run(100, { outcome: "gave-up", exit: 75 }), run(100, { outcome: "left", exit: 130 }),
        run(100, { outcome: "could-not-start", exit: 127 }),
    ];
    for (const line of ignored) assert.equal(flakyFor([pass(300), line], job, opts), null, line);
    assert.equal(flakyFor([pass(300, { clean: false }), fail(100)], job, opts), null);
});

test("flakyFor: only runs that ended inside the window count, and the window is a setting", () => {
    assert.equal(flakyFor([pass(15 * 24 * 60), fail(120)], job, opts), null);
    assert.notEqual(flakyFor([pass(13 * 24 * 60), fail(120)], job, opts), null);
    assert.equal(flakyFor([pass(3 * 24 * 60), fail(120)], job, { ...opts, windowDays: 2 }), null);
    assert.match(flakyFor([pass(300), fail(120)], job, { ...opts, windowDays: 1 }).note, / once in 1 day, /);
    assert.equal(flakyFor([pass(300), fail(-5)], job, opts), null);
});

test("flakyFor: counts passes and failures over the mixed commits only, and says how many times", () => {
    const lines = [
        pass(900), fail(800), fail(700),
        pass(600, { head: "c2" }), fail(500, { head: "c2" }),
        pass(400, { head: "c3" }), pass(300, { head: "c3" }),
        fail(200, { head: "c4" }),
    ];
    const found = flakyFor(lines, job, opts);
    assert.deepEqual([found.mixedCommits, found.passes, found.fails], [2, 2, 3]);
    assert.equal(found.lastEndedAt, new Date(NOW - 500 * MINUTE).toISOString());
    assert.match(found.note, /^flaky: this check passed and failed on the same commit 2 times in 14 days, last 8 h ago; /);
    assert.equal(flakyNoteFor(lines, job, opts), found.note);
    assert.equal(flakyNoteFor([pass(1)], job, opts), null);
});

test("flakyChecks: two checks with the same command in different folders stay apart", () => {
    const other = { label: "shop-web: unit tests", cwd: "/srv/shop-web", projectKey: "shop-web", project: "shop-web" };
    assert.deepEqual(flakyChecks([pass(300), fail(200, other)], opts), []);
    const both = flakyChecks([pass(300), fail(200), pass(150, other), fail(100, other)], opts);
    assert.deepEqual(both.map((c) => [c.label, c.cwd]), [["shop-web: unit tests", "/srv/shop-web"], [SUITE, "/srv/shop-api"]]);
});

test("flakyFor: one label run in two folders on one commit is not flaky: the folders hold different code", () => {
    assert.equal(flakyFor([pass(300), fail(200, { cwd: "/srv/shop-api/packages/billing" })], job, opts), null);
    assert.deepEqual(flakyChecks([pass(300), fail(200, { cwd: "/srv/shop-api/packages/billing" })], opts), []);
});

test("flakyChecks: unlabelled checks are told apart by command, project and folder", () => {
    const bare = (fields) => ({ label: UNLABELLED, ...fields });
    const lines = [pass(300, bare({})), fail(200, bare({ cmd: "npm run lint" })), fail(150, bare({ cwd: "/srv/copy" }))];
    assert.deepEqual(flakyChecks(lines, opts), []);
    const flaky = flakyChecks([...lines, fail(100, bare({}))], opts);
    assert.deepEqual(flaky.map((c) => [c.label, c.cmd, c.project, c.cwd]), [[UNLABELLED, "npm test", "shop-api", "/srv/shop-api"]]);
    const asJob = { label: UNLABELLED, cmd: "npm test", project: "shop-api", cwd: "/srv/copy" };
    assert.equal(flakyFor([pass(300, bare({})), fail(100, bare({}))], asJob, opts), null);
});

test("flakyChecks: newest mixed run first, with the fields of each check", () => {
    const lint = { label: "shop-api: lint", cmd: "npm run lint" };
    const checks = flakyChecks([pass(900, lint), fail(800, lint), pass(300), fail(60), pass(30)], opts);
    assert.deepEqual(checks[0], {
        label: SUITE, cmd: "npm test", project: "shop-api", cwd: "/srv/shop-api",
        mixedCommits: 1, passes: 2, fails: 1, lastEndedAt: new Date(NOW - 30 * MINUTE).toISOString(),
    });
    assert.equal(checks[1].label, "shop-api: lint");
    assert.deepEqual(flakyCounts(checks), { all: 2, byProject: { "shop-api": 2 } });
    assert.deepEqual(flakyChecks([pass(900, lint), fail(800, lint)], { now: NOW, from: NOW - 10 * HOUR }), []);
});

test("flakyLines: one line per flaky check with singular and plural words, or none", () => {
    const lines = [pass(400), fail(300), pass(200, { head: "c2" }), pass(190, { head: "c2" }), fail(120, { head: "c2" })];
    assert.deepEqual(flakyLines(lines, opts), [
        `${SUITE}; mixed on 2 commits, 3 passes and 2 failures, last 2 h ago; command npm test`,
    ]);
    assert.deepEqual(flakyLines([pass(300), fail(30)], opts), [`${SUITE}; mixed on 1 commit, 1 pass and 1 failure, last 30 min ago; command npm test`]);
    const bare = [pass(300, { label: UNLABELLED }), fail(30, { label: UNLABELLED })];
    assert.match(flakyLines(bare, opts)[0], /^shop-api: unlabelled, folder \/srv\/shop-api; mixed on 1 commit, /);
    assert.deepEqual(flakyLines([pass(300)], opts), ["flaky: none in 14 days"]);
    assert.deepEqual(flakyLines([], { now: NOW, windowDays: 1 }), ["flaky: none in 1 day"]);
    assert.deepEqual(flakyLines([pass(4 * DAY / MINUTE), fail(30)], { now: NOW, windowDays: 3 }), ["flaky: none in 3 days"]);
});
