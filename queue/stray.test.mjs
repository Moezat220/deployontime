import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { STRAY, strayRuns } from "./stray.mjs";

const MB = 1024; // rss is given in KB
const runner = (pid, ppid, extra = {}) => ({ pid, ppid, rss: 90 * MB, cmd: "node /srv/mobile-app/node_modules/.bin/vitest run", ...extra });
const workers = (ppid, count, rss, firstPid = 7100) => Array.from({ length: count }, (_, i) => ({
    pid: firstPid + i, ppid, rss, cmd: "node /srv/mobile-app/node_modules/vitest/dist/workers/forks.js",
}));
const bigRun = (rootPid, ppid) => [runner(rootPid, ppid), ...workers(rootPid, 3, 900 * MB)];

test("strayRuns: reports a large run with its root, process count and memory", () => {
    const found = strayRuns([{ pid: 40, ppid: 1, rss: 5 * MB, cmd: "-zsh" }, ...bigRun(7000, 40)]);
    assert.deepEqual(found, [{ rootPid: 7000, procs: 4, rssMB: 2790, cmd: "node /srv/mobile-app/node_modules/.bin/vitest run" }]);
});

test("strayRuns: a run under a slot holder belongs to the queue, whatever the command lines say", () => {
    const rows = [
        { pid: 6000, ppid: 40, rss: 60 * MB, cmd: "node queue/cli.mjs run --priority -- pnpm exec vitest run" },
        { pid: 6001, ppid: 6000, rss: 40 * MB, cmd: "node job-wrapper.mjs 6000 npx vitest run" },
        ...bigRun(7000, 6001),
    ];
    assert.deepEqual(strayRuns(rows, { holders: [{ pid: 6000, pgid: 6001 }] }), []);
    assert.deepEqual(strayRuns(rows, { holders: [{ pid: 6000 }] }), []);
    assert.equal(strayRuns(rows, { holders: [] }).length, 1);
    assert.equal(strayRuns(rows, { holders: [{ pid: 9999, pgid: 9998 }] }).length, 1);
});

test("strayRuns: the wrapper's group id is enough when the queue process is not listed", () => {
    const rows = [{ pid: 6001, ppid: 6000, rss: 40 * MB, cmd: "node job-wrapper.mjs 6000 npx vitest run" }, ...bigRun(7000, 6001)];
    assert.deepEqual(strayRuns(rows, { holders: [{ pid: 6000, pgid: 6001 }] }), []);
    assert.deepEqual(strayRuns(bigRun(7000, 6000), { holders: [{ pid: 6000 }] }), []);
});

test("strayRuns: a command that only looks like the queue does not hide a run", () => {
    const rows = [{ pid: 6000, ppid: 1, rss: 60 * MB, cmd: "node /srv/tools/queue/cli.mjs run -- npx vitest run" }, ...bigRun(7000, 6000)];
    assert.equal(strayRuns(rows).length, 1);
});

test("strayRuns: small runs, single processes, shells and other programs are ignored", () => {
    assert.deepEqual(strayRuns([runner(7000, 1), ...workers(7000, 2, 100 * MB)]), []);
    assert.deepEqual(strayRuns([runner(7000, 1, { rss: 4096 * MB })]), []);
    assert.deepEqual(strayRuns([
        { pid: 50, ppid: 1, rss: 3000 * MB, cmd: "/bin/bash -c npx vitest run" },
        { pid: 51, ppid: 1, rss: 3000 * MB, cmd: "sh -c jest --ci" },
    ]), []);
    assert.deepEqual(strayRuns([
        { pid: 60, ppid: 1, rss: 5000 * MB, cmd: "node api/server.js" },
        { pid: 61, ppid: 60, rss: 5000 * MB, cmd: "node api/worker.js" },
    ]), []);
});

test("strayRuns: many test processes count even when they are small", () => {
    const rows = [runner(7000, 1, { rss: 20 * MB }), ...workers(7000, STRAY.minProcs - 1, 20 * MB)];
    assert.equal(strayRuns(rows).length, 1);
    assert.deepEqual(strayRuns(rows.slice(0, -1)), []);
});

test("strayRuns: thresholds can be passed in, and the largest run comes first", () => {
    const rows = [...bigRun(7000, 1), runner(8000, 1), ...workers(8000, 3, 1500 * MB, 8100)];
    assert.deepEqual(strayRuns(rows).map((r) => r.rootPid), [8000, 7000]);
    assert.deepEqual(strayRuns(rows, { minMB: 4000 }).map((r) => r.rootPid), [8000]);
    assert.deepEqual(strayRuns(rows, { minMB: 100_000, minProcs: 4 }).map((r) => r.rootPid), [8000, 7000]);
    assert.deepEqual(strayRuns(rows, { minMB: 100_000, minProcs: 40 }), []);
});

test("strayRuns: time grows in step with the rows, also when one process has them all as children", () => {
    const rows = [runner(9000, 1), ...workers(9000, 50_000, 1, 20_000)];
    const began = performance.now(), [found] = strayRuns(rows);
    assert.deepEqual([found.rootPid, found.procs], [9000, 50_001]);
    assert.ok(performance.now() - began < 1500, "50000 rows took too long");
});

test("strayRuns: a shell in any folder is the launcher of a run, not its root", () => {
    for (const shell of ["/bin/bash", "/usr/bin/zsh", "/opt/homebrew/bin/bash", "/usr/local/bin/zsh", "sh"]) {
        const rows = [{ pid: 50, ppid: 1, rss: 4 * MB, cmd: `${shell} -c npx vitest run` }, ...bigRun(7000, 50)];
        assert.deepEqual(strayRuns(rows).map((run) => [run.rootPid, run.procs, run.cmd]), [[7000, 4, runner(0, 0).cmd]], shell);
    }
});
