import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { isolateProcess, tempDir } from "./testkit.mjs";

isolateProcess("slots");
const { enqueue, releaseSlot, snapshot, takeSlot, updateSlot } = await import("./slots.mjs");

const MINUTE = 60_000;
const newDirs = () => { const home = tempDir("slots"); return { slots: join(home, "slots"), waitingLine: join(home, "line") }; };
const allAlive = () => true;
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

test("snapshot: an entry whose pid now belongs to a newer process is dropped; its own process keeps it", () => {
    const dirs = newDirs(), now = 50_000_000;
    fs.mkdirSync(dirs.slots, { recursive: true }); fs.mkdirSync(dirs.waitingLine, { recursive: true });
    const put = (name, data) => writeFileSync(join(dirs.waitingLine, name), JSON.stringify(data));
    put("1-801.json", { pid: 801, label: "same process", at: 1, born: now - 600_000 });
    put("2-802.json", { pid: 802, label: "pid reused", at: 2, born: now - 600_000 });
    put("3-803.json", { pid: 803, label: "no start time", at: 3 });
    put("4-804.json", { pid: 804, label: "age unknown", at: 4, born: now - 600_000 });
    const asked = [];
    const ages = (pids) => { asked.push(...pids); return new Map([[801, 601], [802, 30]]); };
    const { queue } = snapshot({ dirs, isAlive: allAlive, ages, now, prune: true });
    assert.deepEqual(queue.map((t) => t.label), ["same process", "no start time", "age unknown"]);
    assert.deepEqual(asked, [801, 802, 804]);
    assert.equal(existsSync(join(dirs.waitingLine, "2-802.json")), false);
});

test("enqueue and takeSlot: this process's own entries carry its start time", () => {
    const dirs = newDirs();
    const ticket = read(enqueue(process.pid, "docs-site: build", false, dirs, 9_000));
    assert.equal(Math.abs(ticket.born - (Date.now() - process.uptime() * 1000)) < 5000, true);
    assert.equal(read(takeSlot(process.pid, "docs-site: build", 1, {}, dirs)).born, ticket.born);
    const { queue, holders } = snapshot({ dirs, now: Date.now() });
    assert.deepEqual([queue.length, holders.length], [1, 1], "a live entry with a real start time is kept");
});

test("enqueue: writes one complete ticket and leaves no temporary file", () => {
    const dirs = newDirs(), ticket = enqueue(640, "docs-site: link check", true, dirs, 9_000);
    assert.deepEqual(readdirSync(dirs.waitingLine), ["9000-640.json"]);
    assert.deepEqual(read(ticket), { pid: 640, label: "docs-site: link check", at: 9_000, priority: true });
    assert.equal("priority" in read(enqueue(641, "docs-site: build", false, dirs, 9_500)), false);
});

test("snapshot: orders the line by priority, then arrival, then pid", () => {
    const dirs = newDirs();
    enqueue(613, "shop-api: integration suite", false, dirs, 40_000);
    enqueue(610, "docs-site: build", false, dirs, 20_000);
    enqueue(612, "mobile-app: store upload", true, dirs, 50_000);
    enqueue(611, "shop-api: lint", false, dirs, 20_000);
    enqueue(614, "mobile-app: hotfix upload", true, dirs, 45_000);
    assert.deepEqual(snapshot({ dirs, isAlive: allAlive }).queue.map((t) => t.pid), [614, 612, 610, 611, 613]);
});

test("snapshot: with prune it deletes the tickets and slots of processes that no longer exist", () => {
    const dirs = newDirs(), gone = new Set([720, 722]);
    const deadTicket = enqueue(720, "docs-site: build", false, dirs), liveTicket = enqueue(721, "shop-api: lint", false, dirs);
    const deadSlot = takeSlot(722, "mobile-app: bundle", 2, {}, dirs), liveSlot = takeSlot(723, "shop-api: build", 2, {}, dirs);
    const seen = snapshot({ dirs, isAlive: (pid) => !gone.has(pid), prune: true });
    assert.deepEqual([seen.holders.map((h) => h.pid), seen.queue.map((t) => t.pid)], [[723], [721]]);
    assert.deepEqual([deadTicket, liveTicket, deadSlot, liveSlot].map(existsSync), [false, true, false, true]);
});

test("snapshot: without prune it reports the same entries and leaves every file where it is", () => {
    const dirs = newDirs(), gone = new Set([725]);
    const deadSlot = takeSlot(725, "docs-site: build", 2, {}, dirs), liveTicket = enqueue(726, "shop-api: lint", false, dirs);
    const abandoned = join(dirs.waitingLine, "4000-727.json.tmp-727");
    writeFileSync(abandoned, "");
    utimesSync(abandoned, new Date(Date.now() - 10 * MINUTE), new Date(Date.now() - 10 * MINUTE));
    const seen = snapshot({ dirs, isAlive: (pid) => !gone.has(pid) });
    assert.deepEqual([seen.holders, seen.queue.map((t) => t.pid)], [[], [726]]);
    assert.deepEqual([deadSlot, liveTicket, abandoned].map(existsSync), [true, true, true]);
    const untouched = join(tempDir("slots"), "never-made");
    assert.deepEqual(snapshot({ dirs: { slots: join(untouched, "slots"), waitingLine: join(untouched, "line") } }), { holders: [], queue: [] });
    assert.equal(existsSync(untouched), false);
});

test("snapshot: a temporary file is neither listed nor deleted while it is fresh", () => {
    const dirs = newDirs(), ticket = enqueue(730, "docs-site: build", false, dirs, 1_000);
    const halfWritten = join(dirs.waitingLine, "2000-731.json.tmp-731"), abandoned = join(dirs.waitingLine, "3000-732.json.tmp-732");
    writeFileSync(halfWritten, '{"pid":731,"lab');
    writeFileSync(abandoned, "");
    utimesSync(abandoned, new Date(Date.now() - 10 * MINUTE), new Date(Date.now() - 10 * MINUTE));
    const seen = snapshot({ dirs, isAlive: allAlive, prune: true });
    assert.deepEqual(seen.queue.map((t) => t.file), [ticket]);
    assert.equal(existsSync(halfWritten), true);
    assert.equal(existsSync(abandoned), false);
});

// Stands in for another process that takes a snapshot at the worst moment: after the writer has created its file
// and before the content is in it.
function withSnapshotDuringWrites(dirs, action) {
    const realWrite = fs.writeFileSync;
    let interrupted = 0;
    fs.writeFileSync = (file, data) => {
        const fd = fs.openSync(file, "w");
        try { interrupted++; snapshot({ dirs, isAlive: allAlive }); fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
    };
    syncBuiltinESMExports();
    try { return [action(), interrupted]; } finally { fs.writeFileSync = realWrite; syncBuiltinESMExports(); }
}

test("enqueue: a snapshot taken in the middle of the write does not lose the ticket", () => {
    const dirs = newDirs();
    const [ticket, interrupted] = withSnapshotDuringWrites(dirs, () => enqueue(740, "shop-api: integration suite", false, dirs, 6_000));
    assert.equal(interrupted, 1);
    assert.deepEqual(snapshot({ dirs, isAlive: allAlive }).queue.map((t) => [t.file, t.pid, t.label]), [[ticket, 740, "shop-api: integration suite"]]);
});

test("takeSlot, updateSlot: a snapshot taken in the middle of the write does not lose the slot", () => {
    const dirs = newDirs();
    const [slot, interrupted] = withSnapshotDuringWrites(dirs, () => {
        const taken = takeSlot(741, "mobile-app: bundle", 1, {}, dirs);
        updateSlot(taken, 741, { pgid: 7410 });
        return taken;
    });
    assert.equal(interrupted, 2);
    assert.deepEqual(snapshot({ dirs, isAlive: allAlive }).holders.map((h) => [h.file, h.pid, h.pgid]), [[slot, 741, 7410]]);
});

test("takeSlot: hands out each slot once and stores the job's details", () => {
    const dirs = newDirs();
    const first = takeSlot(801, "shop-api: integration suite", 3, { kind: "test", limitMin: 25 }, dirs);
    const second = takeSlot(802, "docs-site: build", 3, {}, dirs), third = takeSlot(803, "mobile-app: bundle", 3, {}, dirs);
    assert.equal(new Set([first, second, third]).size, 3);
    assert.equal(takeSlot(804, "docs-site: link check", 3, {}, dirs), null);
    const stored = read(first);
    assert.deepEqual([stored.pid, stored.label, stored.kind, stored.limitMin], [801, "shop-api: integration suite", "test", 25]);
    assert.deepEqual(readdirSync(dirs.slots).sort(), ["slot-0.json", "slot-1.json", "slot-2.json"]);
});

test("releaseSlot: frees the slot for its holder only", () => {
    const dirs = newDirs(), slot = takeSlot(811, "docs-site: build", 1, {}, dirs);
    releaseSlot(slot, 812);
    assert.equal(takeSlot(812, "shop-api: lint", 1, {}, dirs), null);
    releaseSlot(slot, 811);
    assert.equal(takeSlot(812, "shop-api: lint", 1, {}, dirs), slot);
    releaseSlot(null, 812);
});

test("updateSlot: merges fields for the holder and refuses anyone else", () => {
    const dirs = newDirs(), slot = takeSlot(821, "mobile-app: bundle", 1, { kind: "build" }, dirs);
    assert.equal(updateSlot(slot, 999, { pgid: 5 }), false);
    assert.equal(updateSlot(null, 821, { pgid: 5 }), false);
    assert.equal(updateSlot(slot, 821, { pgid: 8210, startedAt: 77 }), true);
    const stored = read(slot);
    assert.deepEqual([stored.pid, stored.kind, stored.pgid, stored.startedAt], [821, "build", 8210, 77]);
    assert.deepEqual(readdirSync(dirs.slots), ["slot-0.json"]);
});
