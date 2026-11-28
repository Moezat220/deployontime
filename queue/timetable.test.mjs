// The schedule file and its lock: reading, writing whole, the checks on a stored job, and the lock that only one
// process holds, with a dead holder's lock taken over.
import { isolateProcess, tempDir } from "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

isolateProcess("timetable");
const { changeSchedule, jobProblem, readSchedule, scheduleTrust, takeLock, writeSchedule } = await import("./timetable.mjs");
const { paths } = await import("./settings.mjs");

const JOB = {
    id: "0a1b2c3d", label: "shop-api: lint", cwd: "/srv/shop-api", command: ["npm", "run", "lint"], every: "1h", enabled: true,
    createdAt: "2031-05-06T10:00:00.000Z",
};
const NOW = Date.UTC(2031, 4, 6, 12, 0);
const files = () => paths({ DOTIME_HOME: tempDir("timetable-home") });
const ME = { pid: 4101, born: NOW - 60_000 };
const never = () => { throw new Error("no pause expected"); };

test("readSchedule: a missing file is an empty schedule; a broken one is an error that names the file", () => {
    const f = files();
    assert.deepEqual(readSchedule(f.schedule), { jobs: [] });
    writeFileSync(f.schedule, "{ not json");
    assert.equal(readSchedule(f.schedule).error, `${f.schedule} cannot be used: it is not valid JSON; fix or remove it`);
    writeFileSync(f.schedule, JSON.stringify({ v: 2, jobs: [] }));
    assert.equal(readSchedule(f.schedule).error, `${f.schedule} cannot be used: it needs { "v": 1, "jobs": [...] }; fix or remove it`);
    writeFileSync(f.schedule, JSON.stringify({ v: 1, jobs: {} }));
    assert.match(readSchedule(f.schedule).error, /it needs \{ "v": 1/);
});

test("writeSchedule: the whole file at once, with no temporary file left beside it", () => {
    const f = files();
    writeSchedule(f.schedule, [JOB]);
    assert.deepEqual(JSON.parse(readFileSync(f.schedule, "utf8")), { v: 1, jobs: [JOB] });
    assert.deepEqual(readdirSync(f.home), ["schedule.json"]);
    assert.deepEqual(readSchedule(f.schedule), { jobs: [JOB] });
});

test("jobProblem: a stored job needs an id, a label, an absolute folder, a command, a creation time and one kind of times", () => {
    assert.equal(jobProblem(JOB), null);
    assert.equal(jobProblem({ ...JOB, every: undefined, cron: "0 2 * * *" }), null);
    assert.equal(jobProblem({ ...JOB, id: "XYZ" }), "no valid id");
    assert.equal(jobProblem({ ...JOB, label: " " }), "no label");
    assert.equal(jobProblem({ ...JOB, cwd: "srv/shop-api" }), "no absolute folder in cwd");
    assert.equal(jobProblem({ ...JOB, command: [] }), "no command");
    assert.equal(jobProblem({ ...JOB, command: "npm test" }), "no command");
    assert.equal(jobProblem({ ...JOB, createdAt: "soon" }), "no createdAt time");
    assert.equal(jobProblem({ ...JOB, cron: "0 2 * * *" }), "needs exactly one of every and cron");
    assert.equal(jobProblem({ ...JOB, every: undefined }), "needs exactly one of every and cron");
    assert.match(jobProblem({ ...JOB, every: "5s" }), /^"5s" is not a step/);
    assert.match(jobProblem({ ...JOB, every: undefined, cron: "61 * * * *" }), /^minute field "61" is out of range/);
    assert.equal(jobProblem(null), "no valid id");
});

test("takeLock: one holder at a time; the holder's release frees it, and a release by another changes nothing", () => {
    const f = files();
    const release = takeLock(f.scheduleLock, ME, { isGone: () => false, now: NOW });
    assert.equal(typeof release, "function");
    assert.deepEqual(JSON.parse(readFileSync(f.scheduleLock, "utf8")), ME);
    assert.equal(takeLock(f.scheduleLock, { pid: 4102, born: NOW }, { isGone: () => false, now: NOW }), null, "a live holder keeps it");
    release();
    assert.equal(existsSync(f.scheduleLock), false);
    const other = takeLock(f.scheduleLock, { pid: 4102, born: NOW }, { isGone: () => false, now: NOW });
    release();
    assert.equal(existsSync(f.scheduleLock), true, "the first holder's release does not free the second one's lock");
    other();
    assert.equal(existsSync(f.scheduleLock), false);
});

test("takeLock: the lock of a process that is gone, or of a pid that names a later process now, is taken over", () => {
    const f = files();
    writeFileSync(f.scheduleLock, JSON.stringify({ pid: 4199, born: NOW - 3_600_000 }));
    const asked = [];
    const release = takeLock(f.scheduleLock, ME, { isGone: (owner) => { asked.push(owner); return true; }, now: NOW });
    assert.equal(typeof release, "function");
    assert.deepEqual(asked, [{ pid: 4199, born: NOW - 3_600_000 }]);
    assert.deepEqual(JSON.parse(readFileSync(f.scheduleLock, "utf8")), ME);
});

test("takeLock: of two processes that both find the same lock stale, only one takes it over", () => {
    const f = files();
    const STALE = { pid: 4199, born: NOW - 3_600_000 }, OTHER = { pid: 4102, born: NOW };
    writeFileSync(f.scheduleLock, JSON.stringify(STALE));
    let other = null;
    // The first one has read the stale lock and asks whether its process is gone; meanwhile the other one takes it over.
    const isGone = (owner) => {
        if (owner.pid === STALE.pid && !other) other = takeLock(f.scheduleLock, OTHER, { isGone: (o) => o.pid === STALE.pid, now: NOW });
        return owner.pid === STALE.pid;
    };
    const mine = takeLock(f.scheduleLock, ME, { isGone, now: NOW });
    assert.equal(typeof other, "function", "the other one took it over");
    assert.equal(mine, null, "this one moved the other's fresh lock aside, saw that, and put it back");
    assert.deepEqual(JSON.parse(readFileSync(f.scheduleLock, "utf8")), OTHER);
    assert.deepEqual(readdirSync(f.home).filter((n) => n.includes(".stale-")), [], "nothing is left behind");
    other();
});

test("takeLock: a stale lock another process already moved away is not taken from under it", () => {
    const f = files();
    writeFileSync(f.scheduleLock, JSON.stringify({ pid: 4199, born: NOW }));
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    let moves = 0;
    const fs = {
        readFileSync, linkSync: () => assert.fail("nothing to put back"),
        renameSync: () => { moves++; writeFileSync(f.scheduleLock, JSON.stringify({ pid: 4102, born: NOW })); throw missing; },
    };
    assert.equal(takeLock(f.scheduleLock, ME, { isGone: (o) => o.pid === 4199, now: NOW, fs }), null);
    assert.equal(moves, 1);
    assert.equal(JSON.parse(readFileSync(f.scheduleLock, "utf8")).pid, 4102, "the winner keeps it");
});

test("schedule.json and its lock are written for their owner alone", () => {
    const f = files();
    writeSchedule(f.schedule, [JOB]);
    assert.equal(statSync(f.schedule).mode & 0o777, 0o600);
    chmodSync(f.schedule, 0o644);
    writeSchedule(f.schedule, [JOB]);
    assert.equal(statSync(f.schedule).mode & 0o777, 0o600, "also when it was readable by others before");
    const release = takeLock(f.scheduleLock, ME, { isGone: () => false, now: NOW });
    assert.equal(statSync(f.scheduleLock).mode & 0o777, 0o600);
    release();
});

test("scheduleTrust: a schedule another user owns, or that the group or others may write, is not trusted", () => {
    const f = files();
    const uid = process.getuid();
    assert.equal(scheduleTrust(f.schedule, uid), null, "no file yet");
    writeSchedule(f.schedule, [JOB]);
    assert.equal(scheduleTrust(f.schedule, uid), null);
    chmodSync(f.schedule, 0o620);
    assert.equal(scheduleTrust(f.schedule, uid), `${f.schedule} may be written by its group; chmod 600 ${f.schedule} fixes it`);
    chmodSync(f.schedule, 0o602);
    assert.equal(scheduleTrust(f.schedule, uid), `${f.schedule} may be written by any user; chmod 600 ${f.schedule} fixes it`);
    chmodSync(f.schedule, 0o600);
    assert.equal(scheduleTrust(f.schedule, uid + 1),
        `${f.schedule} belongs to user ${uid}, not to you (${uid + 1}), and may name any command; make it yours with chown, then chmod 600 ${f.schedule}`);
    assert.equal(scheduleTrust(f.schedule, 0, () => ({ uid: 0, mode: 0o100600 })), null, "the stat is handed in");
});

test("takeLock: a lock file that cannot be read is left alone while it is new, and taken over once it is a minute old", () => {
    const f = files();
    writeFileSync(f.scheduleLock, "");
    assert.equal(takeLock(f.scheduleLock, ME, { isGone: never, now: Date.now() }), null);
    const old = new Date(Date.now() - 120_000);
    utimesSync(f.scheduleLock, old, old);
    assert.equal(typeof takeLock(f.scheduleLock, ME, { isGone: never, now: Date.now() }), "function");
});

test("changeSchedule: a schedule.json the tick would not trust is neither changed nor rewritten as the user's own", () => {
    const f = files();
    const lockDeps = { isGone: () => false, now: NOW, pause: never };
    writeSchedule(f.schedule, [JOB]);
    const before = readFileSync(f.schedule, "utf8");
    const theirs = () => ({ uid: 4321, mode: 0o100600 });
    assert.deepEqual(changeSchedule(f, ME, () => assert.fail("must not run"), { ...lockDeps, uid: 1234, stat: theirs }),
        { error: `${f.schedule} belongs to user 4321, not to you (1234), and may name any command; make it yours with chown, then chmod 600 ${f.schedule}` });
    chmodSync(f.schedule, 0o620);
    assert.match(changeSchedule(f, ME, () => assert.fail("must not run"), lockDeps).error, /may be written by its group; chmod 600 /);
    assert.equal(readFileSync(f.schedule, "utf8"), before);
    assert.equal(statSync(f.schedule).mode & 0o777, 0o620, "the file is not rewritten");
    assert.equal(existsSync(f.scheduleLock), false, "the lock is freed");
});

test("changeSchedule: writes what the change gives, writes nothing on an error, and gives up on a lock that stays taken", () => {
    const f = files();
    const lockDeps = { isGone: () => false, now: NOW, pause: never };
    assert.deepEqual(changeSchedule(f, ME, (jobs) => ({ jobs: [...jobs, JOB], added: true }), lockDeps), { jobs: [JOB], added: true });
    assert.deepEqual(readSchedule(f.schedule), { jobs: [JOB] });
    assert.equal(existsSync(f.scheduleLock), false, "the lock is freed after the change");
    assert.deepEqual(changeSchedule(f, ME, () => ({ error: "no job 99999999" }), lockDeps), { error: "no job 99999999" });
    assert.deepEqual(readSchedule(f.schedule), { jobs: [JOB] });
    writeFileSync(f.scheduleLock, JSON.stringify({ pid: 4102, born: NOW }));
    const pauses = [];
    const busy = changeSchedule(f, ME, () => assert.fail("must not run"), { ...lockDeps, waitMs: 200, pause: (ms) => pauses.push(ms) });
    assert.deepEqual(busy, { busy: true });
    assert.deepEqual(pauses, [50, 50, 50, 50]);
    writeFileSync(join(f.home, "schedule.json"), "[]");
    assert.match(changeSchedule(paths({ DOTIME_HOME: f.home }), ME, () => assert.fail("must not run"), {
        ...lockDeps, isGone: () => true,
    }).error, /cannot be used/);
});
