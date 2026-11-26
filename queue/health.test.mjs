import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./testkit.mjs";
import { healthVerdict, parsePower, powerState, readBattery, readHealth } from "./health.mjs";

const LIMITS = { loadPerCore: 2, minFreeMemPct: 25, minFreeDiskGB: 12, minBatteryPct: 30 };
const roomy = { load: 1.5, cores: 4, freePct: 45, diskGB: 120, battery: null };
const texts = (sample, limits = LIMITS) => healthVerdict(sample, limits).blocks.map((b) => b.text);
const gates = (sample, limits = LIMITS) => healthVerdict(sample, limits).blocks.map((b) => b.gate);

test("healthVerdict: open when every reading is inside its limit", () => {
    assert.deepEqual(healthVerdict(roomy, LIMITS), { ok: true, blocks: [] });
});

test("healthVerdict: names load, memory and disk with the reading and the limit", () => {
    assert.deepEqual(healthVerdict({ ...roomy, load: 9 }, LIMITS), { ok: false, blocks: [{ gate: "load", text: "load too high: 9.0 now, 8.0 allowed" }] });
    assert.deepEqual(texts({ ...roomy, freePct: 9 }), ["memory too low: 9% free, 25% needed"]);
    assert.deepEqual(texts({ ...roomy, diskGB: 4.5 }), ["disk too low: 4.5 GB free, 12 GB needed"]);
    assert.deepEqual(gates({ load: 30, cores: 4, freePct: 3, diskGB: 1 }), ["load", "memory", "disk"]);
});

test("healthVerdict: a reading of 0 shuts the gate, an unknown reading does not", () => {
    assert.deepEqual(texts({ ...roomy, diskGB: 0 }), ["disk too low: 0.0 GB free, 12 GB needed"]);
    assert.deepEqual(gates({ ...roomy, freePct: 0 }), ["memory"]);
    assert.equal(healthVerdict({ ...roomy, diskGB: null, freePct: null }, LIMITS).ok, true);
});

test("healthVerdict: a low battery counts only while the computer runs on it", () => {
    assert.deepEqual(texts({ ...roomy, battery: { onBattery: true, pct: 30, plugged: false } }), ["battery too low: 30% left, more than 30% needed, not plugged in"]);
    assert.deepEqual(texts({ ...roomy, battery: { onBattery: true, pct: 6, plugged: true } }), ["battery too low: 6% left, more than 30% needed, plugged in but still draining"]);
    assert.equal(healthVerdict({ ...roomy, battery: { onBattery: true, pct: 31, plugged: false } }, LIMITS).ok, true);
    assert.equal(healthVerdict({ ...roomy, battery: { onBattery: false, pct: 2, plugged: true } }, LIMITS).ok, true);
});

test("healthVerdict: judges by the limits it is handed", () => {
    assert.deepEqual(gates({ ...roomy, freePct: 45 }, { ...LIMITS, minFreeMemPct: 50 }), ["memory"]);
    assert.deepEqual(gates({ ...roomy, load: 9 }, { ...LIMITS, loadPerCore: 3 }), []);
});

const unplugged = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=2)\t37%; discharging; 1:25 remaining present: true\n";
const charging = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=2)\t91%; charging; 0:15 remaining present: true\n";
const drainingOnMains = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=2)\t58%; discharging; (no estimate) present: true\n";
const full = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=2)\t100%; charged; 0:00 remaining present: true\n";

test("parsePower: power source, charge level and charge state", () => {
    assert.deepEqual(parsePower(unplugged), { ac: false, pct: 37, charge: "discharging" });
    assert.deepEqual(parsePower(charging), { ac: true, pct: 91, charge: "charging" });
    assert.deepEqual(parsePower(full), { ac: true, pct: 100, charge: "charged" });
    assert.deepEqual(parsePower("Now drawing from 'AC Power'\n"), { ac: true, pct: null, charge: null });
    assert.deepEqual(parsePower(""), { ac: null, pct: null, charge: null });
});

test("powerState: on battery when unplugged, or when plugged in and still losing charge", () => {
    assert.deepEqual(powerState(parsePower(unplugged)), { onBattery: true, plugged: false });
    assert.deepEqual(powerState(parsePower(charging)), { onBattery: false, plugged: true });
    assert.deepEqual(powerState(parsePower(full)), { onBattery: false, plugged: true });
    assert.deepEqual(powerState(parsePower(drainingOnMains)), { onBattery: true, plugged: true });
    assert.deepEqual(powerState(parsePower("")), { onBattery: null, plugged: false });
    assert.deepEqual(powerState(undefined), { onBattery: null, plugged: false });
});

test("readBattery: null whenever the reading is incomplete or the probe fails", () => {
    assert.deepEqual(readBattery(() => drainingOnMains), { onBattery: true, pct: 58, plugged: true });
    assert.deepEqual(readBattery(() => charging), { onBattery: false, pct: 91, plugged: true });
    assert.equal(readBattery(() => "Now drawing from 'AC Power'\n"), null);
    assert.equal(readBattery(() => "desktop without a battery"), null);
    assert.equal(readBattery(() => { throw new Error("tool missing"); }), null);
});

test("readHealth: combines the probes it is given", () => {
    const probes = { load: () => ({ load: 0.8, cores: 6 }), memory: () => 71, disk: () => 0, battery: () => null };
    assert.deepEqual(readHealth({ env: {}, probes }), { load: 0.8, cores: 6, freePct: 71, diskGB: 0, battery: null });
});

test("readHealth: DOTIME_FAKE_HEALTH is used only when the state folder is inside the temp folder", () => {
    const probes = { load: () => ({ load: 0.8, cores: 6 }), memory: () => 71, disk: () => 300, battery: () => null };
    const fake = JSON.stringify({ load: 55, cores: 2, freePct: 4, diskGB: 2 });
    const outsideTemp = dirname(fileURLToPath(import.meta.url));
    assert.equal(readHealth({ env: { DOTIME_HOME: tempDir("health"), DOTIME_FAKE_HEALTH: fake }, probes }).load, 55);
    assert.equal(readHealth({ env: { DOTIME_HOME: outsideTemp, DOTIME_FAKE_HEALTH: fake }, probes }).load, 0.8);
    assert.equal(readHealth({ env: { DOTIME_FAKE_HEALTH: fake }, probes }).load, 0.8);
    assert.equal(readHealth({ env: { DOTIME_HOME: tempDir("health"), DOTIME_FAKE_HEALTH: "{broken" }, probes }).load, 0.8);
});
