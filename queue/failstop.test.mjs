import { test } from "node:test";
import assert from "node:assert/strict";
import { isolateProcess } from "./testkit.mjs";

isolateProcess("failstop");
const { failStop } = await import("./failstop.mjs");
const { UNLABELLED } = await import("./args.mjs");
const { DEFAULTS } = await import("./settings.mjs");

const MINUTE = 60_000;
const NOW = Date.UTC(2031, 8, 3, 7, 0);
// The limits these tests calculate with, set here so that the shipped defaults can change freely.
const L = { ...DEFAULTS.limits, failWindowHours: 6 };
const ago = (ms) => new Date(NOW - ms).toISOString();
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
