// The `reasons` report from synthetic journal rows: classes, the pairing of a failure with the next run of the same
// check on the same clean commit, and the rows that never count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFailure, reasonsLines, reasonsReport } from "./reasons.mjs";
import { DAY, MINUTE } from "./units.mjs";

const NOW = Date.UTC(2031, 5, 9, 12, 0);
let seq = 0;
/** A journal row of the check "shop-api: unit tests" that ended minutesAgo before NOW. */
function row(minutesAgo, fields = {}) {
    const endedAt = new Date(NOW - minutesAgo * MINUTE).toISOString();
    seq += 1;
    return {
        v: 1, label: "shop-api: unit tests", project: "shop-api", projectKey: "shop-api", cwd: "/work/shop-api",
        queuedAt: endedAt, startedAt: endedAt, endedAt, runMin: 2, outcome: "ran", exit: 0, cmd: "npm test",
        head: "c0ffee", clean: true, seq, ...fields,
    };
}
const fail = (minutesAgo, reason, fields = {}) => row(minutesAgo, { exit: 1, reason, ...fields });
const net = { class: "network", sign: "ECONNRESET" };

test("reasons: a failure whose next run on the same clean commit passed counts as passed on a re-run", () => {
    const rows = [
        fail(60, net, { runMin: 3 }), row(50, { runMin: 1.5 }),
        fail(40, { class: "network", sign: "ETIMEDOUT" }, { head: "beef01" }), fail(30, net, { head: "beef01" }),
        row(20, { head: "beef01" }),
    ];
    const report = reasonsReport(rows, { now: NOW });
    assert.deepEqual(report.classes, [{
        class: "network", failures: 3, clean: 3, passedOnRerun: 2, runMin: 7, rerunMin: 3.5,
        signs: { ECONNRESET: 2, ETIMEDOUT: 1 }, alsoSaw: {},
    }]);
    assert.deepEqual(report.retry, [{ class: "network", reruns: 2, runMin: 3.5 }]);
    assert.deepEqual(reasonsLines(report), [
        "network: 3 failures, 3 on a clean tree, 2 passed on a plain re-run of the same commit (67%), 7 run-min; "
            + "signs ECONNRESET 2, ETIMEDOUT 1",
        "total in 7 days: 3 failures, 3 on a clean tree, 2 passed on a plain re-run of the same commit (67%), 7 run-min",
        "a retry of the environment classes would have saved: network 2 re-runs that passed (3.5 run-min)",
    ]);
});

test("reasons: a dirty failure, a dirty pass, another commit, folder or check never counts as a passing re-run", () => {
    const rows = [
        fail(90, net, { clean: false }), row(85),
        fail(80, net), row(75, { clean: false }), row(74, { head: "other0" }), row(73, { cwd: "/work/other" }),
        row(72, { label: "docs-site: build", cmd: "npm run build" }), row(71, { outcome: "skipped" }),
        row(70, { outcome: "stopped", exit: 143 }),
    ];
    const [network] = reasonsReport(rows, { now: NOW }).classes;
    assert.deepEqual([network.failures, network.clean, network.passedOnRerun], [2, 1, 0]);
});

test("reasons: only the next run decides: a second failure before the pass means no pass on a re-run", () => {
    const rows = [fail(30, net), fail(20, net), row(10)];
    const [network] = reasonsReport(rows, { now: NOW }).classes;
    assert.deepEqual([network.failures, network.passedOnRerun], [2, 1]);
});

test("reasons: classes most failures first, also-saw counted, test and build are not in the retry line", () => {
    const rows = [
        fail(50, { class: "test", sign: "# fail", alsoSaw: "network" }), row(45),
        fail(40, { class: "test", sign: "# fail" }), row(39, { outcome: "timed-out", exit: 124, reason: { class: "run-limit" } }),
        row(38, { outcome: "stopped", exit: 130, signal: "SIGINT", reason: { class: "signal", sign: "SIGINT" } }),
        fail(37, { class: "unknown", source: "tty" }),
    ];
    const report = reasonsReport(rows, { now: NOW });
    assert.deepEqual(report.classes.map((c) => [c.class, c.failures]), [["test", 2], ["run-limit", 1], ["signal", 1], ["unknown", 1]]);
    assert.deepEqual(report.classes[0].alsoSaw, { network: 1 });
    assert.deepEqual(report.retry, []);
    const lines = reasonsLines(report);
    assert.equal(lines[0], "test: 2 failures, 2 on a clean tree, 1 passed on a plain re-run of the same commit (50%), 4 run-min; "
        + "signs # fail 2; also saw network 1");
    assert.equal(lines.at(-1), "a retry of the environment classes would have saved nothing: no such failure passed on a re-run");
});

test("reasons: the window counts failures by their end, and older failures without a reason are named, not classed", () => {
    const rows = [fail(8 * 24 * 60, net), fail(2 * 24 * 60, net), row(60, { exit: 1 })];
    const week = reasonsReport(rows, { now: NOW });
    assert.deepEqual([week.classes.length, week.total.failures, week.total.unrecorded], [1, 1, 1]);
    assert.equal(reasonsLines(week)[1].endsWith("; 1 older failure without a reason left out"), true);
    const day = reasonsReport(rows, { now: NOW, days: 1 });
    assert.deepEqual(reasonsLines(day), ["reasons: no failures in 1 day; 1 older failure without a reason left out"]);
    assert.equal(day.from, new Date(NOW - DAY).toISOString());
});

test("reasons: no failures gives one line, and passes, skips and refusals are no failures", () => {
    const rows = [row(10), row(5, { outcome: "skipped" }), row(4, { outcome: "refused", exit: 3 }), row(3, { outcome: "gave-up", exit: 75 })];
    assert.deepEqual(reasonsLines(reasonsReport(rows, { now: NOW })), ["reasons: no failures in 7 days"]);
    assert.deepEqual(reasonsLines(reasonsReport([], { now: NOW, days: 3 })), ["reasons: no failures in 3 days"]);
    assert.deepEqual(rows.map(isFailure), [false, false, false, false]);
});

test("reasons: a failure inside a nested run is counted once, on the nested run's line", () => {
    const inner = fail(30, net, { label: "shop-api: api tests", nested: true, parentPid: 4100 });
    const outer = fail(29, { class: "network", sign: "ECONNRESET", via: "nested" }, { label: "shop-api: all checks", pid: 4100 });
    const report = reasonsReport([inner, outer], { now: NOW });
    assert.deepEqual([report.classes.map((c) => [c.class, c.failures]), report.total.failures, report.total.nested],
        [[["network", 1]], 1, 1]);
    assert.equal(reasonsLines(report)[1], "total in 7 days: 1 failure, 1 on a clean tree, 0 passed on a plain re-run of the "
        + "same commit (0%), 2 run-min; 1 outer job counted on the run nested in it");
});
