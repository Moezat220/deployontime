import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateProcess, tempDir } from "./testkit.mjs";

isolateProcess("notices");
const { addNotice, idleAlert, longRunAlert, slotIdleCheck, slotIdleStep } = await import("./notices.mjs");
const { DEFAULTS } = await import("./settings.mjs");

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const NOW = Date.UTC(2031, 8, 3, 7, 0);
const SUITE = "shop-api: integration suite";
const SLOT_IDLE = { ...DEFAULTS.idle, slotIdleMin: 10, slotCpuS: 5 };
const holder = { pid: 3300, pgid: 3301, label: SUITE, project: "shop-api", startedAt: NOW - 40 * MINUTE, killMin: 90 };
const cpuTable = (seconds, pgid = 3301) => `${pgid} 3300 ${pgid} 0:${seconds.toFixed(2).padStart(5, "0")}\n`;
const step = (state, minutesFromNow, ps, holders = [holder], idle = SLOT_IDLE) => slotIdleStep({ holders, ps, state, now: NOW + minutesFromNow * MINUTE, idle, tz: "UTC" });

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
