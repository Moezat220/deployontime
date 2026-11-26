import { test } from "node:test";
import assert from "node:assert/strict";
import { isolateProcess } from "./testkit.mjs";

isolateProcess("limits");
const { decideLimit, kindStats, stemStats } = await import("./limits.mjs");
const { DEFAULTS } = await import("./settings.mjs");

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NOW = Date.UTC(2031, 8, 3, 7, 0);
// The limits these tests calculate with, set here so that the shipped defaults can change freely.
const L = {
    ...DEFAULTS.limits, defaultMin: 30, debugMin: 15, floorMin: 10, p90Factor: 1.5, longRunFactor: 2,
    longRunUnmeasuredMin: 20, minSamples: 5, windowDays: 14, failWindowHours: 6, priorityGrace: 2
};
const ago = (ms) => new Date(NOW - ms).toISOString();

const passed = (runMin, fields = {}) => JSON.stringify({
    projectKey: "docs-site", label: "docs-site: build", cmd: "pnpm run build", kind: "build", outcome: "ran", exit: 0,
    runMin, endedAt: ago(2 * HOUR), ...fields
});
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
    assert.equal(kindStats(HISTORY, { project: "shop-api", kind: "build", now: NOW, windowDays: 14 }).n, 1);
});

test("stemStats: counts passed runs with the same command stem", () => {
    assert.deepEqual(
        stemStats(HISTORY, { project: "docs-site", stem: "pnpm run build", now: NOW, windowDays: 14 }),
        { n: 4, p75: 8, p90: 12, max: 12, stem: "pnpm run build" }
    );
    assert.deepEqual(
        stemStats(HISTORY, { project: "docs-site", stem: "make docs", now: NOW, windowDays: 14 }),
        { n: 0, p75: null, p90: null, max: null, stem: "make docs" }
    );
    assert.deepEqual(stemStats(HISTORY, { project: "docs-site", stem: null, now: NOW, windowDays: 14 }), { n: 0, stem: null });
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
    assert.deepEqual([limit.limitMin, limit.basis, limit.longRunMin, limit.notifyLongRun], [
        10,
        "5 passed runs of kind lint (1.5 times their p90 of 2.2 min, lifted to the 10 min minimum)",
        10,
        false
    ]);
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
    assert.equal(
        limit.basis,
        `18 min, the longest passed run of command "${E2E}" (3 on record), times 1.5; ` +
            `that is more than 40 passed runs of kind test (1.5 times their p90 of 3 min, lifted to the 10 min minimum)`
    );
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

test("limits: exports no helper that only the tests use", async () => {
    const exported = await import("./limits.mjs");
    for (const name of ["isDebug", "pctl", "passedRuns"]) assert.equal(name in exported, false, name);
});
