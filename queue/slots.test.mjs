import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { isolateProcess, tempDir } from "./testkit.mjs";

isolateProcess("slots");
const { addNested, enqueue, MARKS, processGone, releaseSlot, snapshot, takePlace, takeSlot, updateSlot } = await import("./slots.mjs");
const { bootId, startTicks } = await import("./linux.mjs");

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

test("updateSlot: a write that fails returns false instead of throwing, and the slot keeps what it had", () => {
    const dirs = newDirs(), slot = takeSlot(822, "mobile-app: bundle", 1, { kind: "build" }, dirs);
    // A folder where the temporary file would go makes the write fail.
    fs.mkdirSync(`${slot}.tmp-${process.pid}`);
    assert.equal(updateSlot(slot, 822, { pgid: 8220 }), false);
    assert.deepEqual([read(slot).pid, read(slot).pgid], [822, undefined]);
});

test("addNested: notes a nested run, which a snapshot lists apart from the holders, and only while it lives", () => {
    const home = tempDir("slots-nested");
    const dirs = { slots: join(home, "slots"), waitingLine: join(home, "line"), nested: join(home, "nested") };
    const outer = { marker: "slot-0", pid: 4100, born: 6000 };
    const note = addNested(process.pid, "docs-site: unit tests", outer, dirs, { now: 7000 });
    addNested(2 ** 30 + 9, "docs-site: lint", outer, dirs);
    const stored = read(note);
    const fields = [
        stored.pid, stored.label, stored.outer, stored.outerPid, stored.outerBorn, stored.at, Number.isFinite(stored.born), stored.waiting,
        "slot" in stored,
    ];
    assert.deepEqual(fields, [process.pid, "docs-site: unit tests", "slot-0", 4100, 6000, 7000, true, undefined, false]);
    const snap = snapshot({ dirs, prune: true });
    assert.deepEqual([snap.holders, snap.queue, snap.nested.map((n) => [n.file, n.label])], [[], [], [[note, "docs-site: unit tests"]]]);
    assert.deepEqual(readdirSync(dirs.nested), [`nested-${process.pid}.json`], "the note of a dead run is pruned");
});

test("addNested: a run that waits for a place is noted as waiting until updateSlot ends the wait", () => {
    const home = tempDir("slots-nested");
    const dirs = { slots: join(home, "slots"), waitingLine: join(home, "line"), nested: join(home, "nested") };
    const note = addNested(process.pid, "docs-site: unit tests", { marker: "nested-4101", pid: 4101, born: 6000, slot: "slot-1" }, dirs, { waiting: true });
    assert.deepEqual([read(note).waiting, read(note).outer, read(note).slot], [true, "nested-4101", "slot-1"], "the note names the outer slot");
    assert.equal(updateSlot(note, process.pid, { waiting: undefined, pgid: 4300 }), true);
    assert.deepEqual([read(note).waiting, read(note).pgid, "waiting" in read(note)], [undefined, 4300, false]);
});

test("takePlace: hands out at most max places per parent, frees one only for its holder, and prunes a dead holder's", () => {
    const home = tempDir("slots-places");
    const dirs = { slots: join(home, "slots"), waitingLine: join(home, "line"), places: join(home, "places") };
    const first = takePlace(process.pid, "docs-site: unit tests", "slot-0.6000", 2, dirs, 7000);
    const second = takePlace(process.ppid, "docs-site: lint", "slot-0.6000", 2, dirs);
    assert.equal(takePlace(process.pid, "docs-site: e2e", "slot-0.6000", 2, dirs), null, "both places of that parent are taken");
    const other = takePlace(process.pid, "shop-api: unit tests", "slot-1.6100", 2, dirs);
    assert.deepEqual([first, second, other].map((f) => f.slice(dirs.places.length + 1)), ["slot-0.6000.0.json", "slot-0.6000.1.json", "slot-1.6100.0.json"]);
    const stored = read(first);
    const fields = [stored.pid, stored.label, stored.parent, stored.at, Number.isFinite(stored.born)];
    assert.deepEqual(fields, [process.pid, "docs-site: unit tests", "slot-0.6000", 7000, true]);
    releaseSlot(second, 999);
    assert.equal(existsSync(second), true, "only the holder frees its place");
    releaseSlot(second, process.ppid);
    assert.equal(takePlace(process.pid, "docs-site: e2e", "slot-0.6000", 2, dirs), second, "a freed place is taken again");
    writeFileSync(first, JSON.stringify({ pid: 2 ** 30 + 9, label: "gone", parent: "slot-0.6000", at: 1 }));
    const snap = snapshot({ dirs, prune: true });
    assert.deepEqual(snap.places.map((p) => p.file).sort(), [other, second].sort());
    assert.equal(existsSync(first), false, "the place of a dead run is pruned");
    assert.equal(takePlace(process.pid, "docs-site: e2e", "slot-0.6000", 2, dirs), first);
});

test("snapshot: a slot file with pid 0, 1 or one that is no number names no holder; it is freed through a claim and taken again", () => {
    const home = tempDir("slots-bad-pid");
    const dirs = { slots: join(home, "slots"), waitingLine: join(home, "line"), lost: join(home, "lost"), journal: join(home, "journal.jsonl") };
    fs.mkdirSync(dirs.slots, { recursive: true });
    const bad = [0, 1, "x"];
    bad.forEach((pid, n) => writeFileSync(join(dirs.slots, `slot-${n}.json`), JSON.stringify({ pid, label: "docs-site: build", at: 1 })));
    const live = takeSlot(process.pid, "docs-site: lint", 4, {}, dirs);
    assert.equal(live, join(dirs.slots, "slot-3.json"));
    const seen = snapshot({ dirs, now: Date.now() });
    assert.deepEqual(seen.holders.map((h) => h.file), [live], "a reader lists only the real holder");
    const { holders } = snapshot({ dirs, now: Date.now(), prune: true });
    assert.deepEqual(holders.map((h) => h.pid), [process.pid], "the live holder is untouched");
    assert.deepEqual(readdirSync(dirs.slots).sort(), ["slot-3.json"]);
    assert.deepEqual(readdirSync(dirs.lost), [], "each claim is gone again");
    assert.equal(existsSync(dirs.journal), false, "no run started, so no lost line");
    assert.equal(takeSlot(process.pid, "docs-site: test suite", 4, {}, dirs), join(dirs.slots, "slot-0.json"));
});

test("processGone: a pid that is not a whole number above 1 names no process, whatever is alive", () => {
    for (const pid of [0, 1, -1, "x", 4.5, undefined]) assert.equal(processGone({ pid, born: 1 }, { isAlive: allAlive }), true, String(pid));
    assert.equal(processGone({ pid: process.pid }), false, "a live pid without a start time stays");
});

test("takeSlot, enqueue, takePlace, addNested: on Linux this process's entries keep its start in clock ticks and the boot; elsewhere none", () => {
    const dirs = newDirs();
    Object.assign(dirs, { nested: join(dirs.slots, "..", "nested"), places: join(dirs.slots, "..", "places") });
    const slot = read(takeSlot(process.pid, "docs-site: build", 1, {}, dirs));
    const ticket = read(enqueue(process.pid, "docs-site: build", false, dirs, 9_000));
    const place = read(takePlace(process.pid, "docs-site: build", "p", 1, dirs));
    const nested = read(addNested(process.pid, "docs-site: build", { marker: "slot-0", pid: 4101, born: 1 }, dirs));
    const ticks = startTicks(process.pid), boot = bootId();
    const expected = ticks === null ? {} : { ticks, ...(boot ? { boot } : {}) };
    assert.deepEqual(MARKS, expected);
    for (const entry of [slot, ticket, place, nested]) {
        assert.deepEqual({ ticks: entry.ticks, boot: entry.boot }, { ticks: expected.ticks, boot: expected.boot });
    }
    const other = read(takeSlot(4101, "docs-site: lint", 2, {}, dirs));
    assert.deepEqual([other.ticks, other.boot], [undefined, undefined], "another process's entry has none");
});

// A holder that has claimed a slot but not started its command: no pgid, so before ticks only its age could tell.
const BOOT = "5d1c7e2a-0b4f-4c8e-9a61-3f2b8d7c6e10";
const claimed = (born, ticks, boot = BOOT) => ({
    pid: 4401, label: "shop-api: e2e", at: born + 500, born, ...(ticks === undefined ? {} : { ticks }), ...(boot === null ? {} : { boot }),
});
const clockStep = (entry, stepMs) => ({
    isAlive: allAlive, now: entry.born + 10 * MINUTE + stepMs, ages: (pids) => new Map(pids.map((pid) => [pid, 600])), readBoot: () => BOOT,
});

test("snapshot, processGone: after a clock step of an hour either way, equal ticks keep a claimed holder that has not started", () => {
    for (const step of [3_600_000, -3_600_000]) {
        const dirs = newDirs(), born = 50_000_000;
        fs.mkdirSync(dirs.slots, { recursive: true });
        const entry = claimed(born, 777_000);
        writeFileSync(join(dirs.slots, "slot-0.json"), JSON.stringify(entry));
        const opts = { ...clockStep(entry, step), readTicks: () => 777_000 };
        assert.equal(processGone(entry, opts), false, `step ${step}`);
        assert.deepEqual(snapshot({ dirs, ...opts, prune: true }).holders.map((h) => h.pid), [4401], `step ${step}`);
        assert.equal(existsSync(join(dirs.slots, "slot-0.json")), true);
        // The same step without ticks: the age alone decides, as before.
        assert.equal(processGone(claimed(born), opts), true, `no ticks, step ${step}`);
    }
});

test("snapshot, processGone: other ticks are a reused pid even when the age agrees; ticks that cannot be read change nothing", () => {
    const dirs = newDirs(), born = 50_000_000;
    fs.mkdirSync(dirs.slots, { recursive: true });
    const entry = claimed(born, 777_000);
    writeFileSync(join(dirs.slots, "slot-0.json"), JSON.stringify(entry));
    const agrees = clockStep(entry, 0);
    assert.equal(processGone(entry, { ...agrees, readTicks: () => 777_001 }), true);
    assert.equal(processGone(entry, { ...agrees, readTicks: () => null }), false, "unreadable: the age agrees");
    assert.equal(processGone(entry, { ...clockStep(entry, 3_600_000), readTicks: () => null }), true, "unreadable: the age disagrees");
    assert.deepEqual(snapshot({ dirs, ...agrees, readTicks: () => 777_001, prune: true }).holders, []);
    assert.deepEqual(readdirSync(dirs.slots), [], "the reused pid's slot is free");
});

test("snapshot, processGone: after a restart equal pid and ticks name another process; without a boot the old rule decides", () => {
    const born = 50_000_000, rebooted = { readBoot: () => "9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4", readTicks: () => 777_000 };
    const entry = claimed(born, 777_000);
    // Another boot: the ticks say nothing, and a wall-clock age far off is a gone holder.
    assert.equal(processGone(entry, { ...clockStep(entry, 3_600_000), ...rebooted }), true, "another boot, the age disagrees");
    assert.equal(processGone(entry, { ...clockStep(entry, 0), ...rebooted }), false, "another boot, the age agrees");
    const dirs = newDirs();
    fs.mkdirSync(dirs.slots, { recursive: true });
    writeFileSync(join(dirs.slots, "slot-0.json"), JSON.stringify(entry));
    assert.deepEqual(snapshot({ dirs, ...clockStep(entry, 3_600_000), ...rebooted, prune: true }).holders, []);
    // The same boot: the ticks decide.
    assert.equal(processGone(entry, { ...clockStep(entry, 3_600_000), readTicks: () => 777_000 }), false, "the same boot");
    // No boot on either side: the old rule, the age.
    const noBoot = claimed(born, 777_000, null);
    assert.equal(processGone(noBoot, { ...clockStep(entry, 3_600_000), readTicks: () => 777_000 }), true, "the entry has no boot");
    assert.equal(processGone(entry, { ...clockStep(entry, 3_600_000), readTicks: () => 777_000, readBoot: () => null }), true, "this boot unread");
    assert.equal(processGone(noBoot, { ...clockStep(entry, 0), readTicks: () => 777_001 }), false, "no boot, the age agrees");
});
