import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { tempDir } from "./testkit.mjs";
import {
    cachedHealth, healthVerdict, MAX_SHARED_READING_MS, MIN_CPU_SPAN_MS, parsePower, powerState, readBattery, readHealth,
} from "./health.mjs";

const LIMITS = { loadPerCore: 2, busyCpuPct: 90, minFreeMemPct: 25, minFreeDiskGB: 12, minBatteryPct: 30 };
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
    assert.deepEqual(
        texts({ ...roomy, battery: { onBattery: true, pct: 30, plugged: false } }),
        ["battery too low: 30% left, more than 30% needed, not plugged in"],
    );
    assert.deepEqual(
        texts({ ...roomy, battery: { onBattery: true, pct: 6, plugged: true } }),
        ["battery too low: 6% left, more than 30% needed, plugged in but still draining"],
    );
    assert.equal(healthVerdict({ ...roomy, battery: { onBattery: true, pct: 31, plugged: false } }, LIMITS).ok, true);
    assert.equal(healthVerdict({ ...roomy, battery: { onBattery: false, pct: 2, plugged: true } }, LIMITS).ok, true);
});

test("healthVerdict: judges by the limits it is handed", () => {
    assert.deepEqual(gates({ ...roomy, freePct: 45 }, { ...LIMITS, minFreeMemPct: 50 }), ["memory"]);
    assert.deepEqual(gates({ ...roomy, load: 9 }, { ...LIMITS, loadPerCore: 3 }), []);
});

test("healthVerdict: a high load holds a job only while the CPU is busy now", () => {
    assert.deepEqual(healthVerdict({ ...roomy, load: 14.8, busyCpuPct: 12 }, LIMITS), { ok: true, blocks: [] }, "load high, CPU idle");
    assert.deepEqual(healthVerdict({ ...roomy, load: 14.8, busyCpuPct: 89.9 }, LIMITS).ok, true, "just below the CPU limit");
    assert.deepEqual(texts({ ...roomy, load: 14.8, busyCpuPct: 96.6 }), ["load too high: 14.8 now, 8.0 allowed; CPU 97% busy now"]);
    assert.deepEqual(texts({ ...roomy, load: 14.8, busyCpuPct: 90 }), ["load too high: 14.8 now, 8.0 allowed; CPU 90% busy now"]);
    assert.deepEqual(healthVerdict({ ...roomy, load: 1.5, busyCpuPct: 100 }, LIMITS), { ok: true, blocks: [] }, "load low, CPU busy");
    assert.deepEqual(gates({ ...roomy, load: 14.8, busyCpuPct: 50 }, { ...LIMITS, busyCpuPct: 40 }), ["load"]);
});

test("healthVerdict: limits without busyCpuPct judge the CPU by the default", () => {
    const { busyCpuPct, ...noCpuLimit } = LIMITS;
    assert.deepEqual(gates({ ...roomy, load: 14.8, busyCpuPct: 95 }, noCpuLimit), ["load"]);
    assert.deepEqual(gates({ ...roomy, load: 14.8, busyCpuPct: 89 }, noCpuLimit), []);
});

test("healthVerdict: without a live CPU reading a high load holds as before", () => {
    assert.deepEqual(texts({ ...roomy, load: 9, busyCpuPct: null }), ["load too high: 9.0 now, 8.0 allowed"]);
    assert.deepEqual(texts({ ...roomy, load: 9, busyCpuPct: Number.NaN }), ["load too high: 9.0 now, 8.0 allowed"]);
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
    assert.deepEqual(readHealth({ probes: { ...probes, cpu: assert.fail } }), { load: 0.8, cores: 6, busyCpuPct: null, freePct: 71, diskGB: 0, battery: null });
});

test("readHealth: takes the live CPU reading only when the load is above its limit", () => {
    let cpuReads = 0;
    const probes = { memory: () => 71, disk: () => 50, battery: () => null, cpu: () => { cpuReads++; return 34; } };
    const calm = readHealth({ probes: { ...probes, load: () => ({ load: 8, cores: 4 }) }, limits: LIMITS });
    assert.deepEqual([calm.busyCpuPct, cpuReads], [null, 0]);
    const loaded = readHealth({ probes: { ...probes, load: () => ({ load: 8.1, cores: 4 }) }, limits: LIMITS });
    assert.deepEqual([loaded.busyCpuPct, cpuReads], [34, 1]);
    assert.equal(healthVerdict(loaded, LIMITS).ok, true);
    const noLimits = readHealth({ probes: { ...probes, load: () => ({ load: 50, cores: 4 }) } });
    assert.deepEqual([noLimits.busyCpuPct, cpuReads], [null, 1]);
});

test("readHealth: takes the live CPU reading last, and not at all when another limit already holds", () => {
    const order = [];
    const probe = (name, value) => () => { order.push(name); return value; };
    const probes = {
        load: probe("load", { load: 30, cores: 4 }), memory: probe("memory", 71), disk: probe("disk", 50),
        battery: probe("battery", null), cpu: probe("cpu", 34),
    };
    assert.equal(readHealth({ probes, limits: LIMITS }).busyCpuPct, 34);
    assert.deepEqual(order, ["load", "memory", "disk", "battery", "cpu"]);
    for (const shut of [{ memory: () => 3 }, { disk: () => 1 }, { battery: () => ({ onBattery: true, pct: 5, plugged: false }) }]) {
        const reading = readHealth({ probes: { ...probes, ...shut, cpu: assert.fail }, limits: LIMITS });
        assert.equal(reading.busyCpuPct, null);
        assert.deepEqual(gates(reading).includes("load"), true, "the load still holds as the load alone would");
    }
});

test("cachedHealth: the shared reading carries the live CPU reading, so waiters do not each take one", () => {
    const file = join(tempDir("health"), "health.json");
    let cpuReads = 0;
    const probes = { load: () => ({ load: 30, cores: 4 }), memory: () => 71, disk: () => 50, battery: () => null, cpu: () => { cpuReads++; return 15; } };
    const read = () => readHealth({ probes, limits: LIMITS });
    assert.equal(cachedHealth(file, 3000, read, () => 10_000).busyCpuPct, 15);
    assert.equal(cachedHealth(file, 3000, read, () => 11_000).busyCpuPct, 15);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).reading.busyCpuPct, 15);
    assert.equal(cpuReads, 1);
});

// CPU times at a given time on a one-core computer that is 20% busy.
const timesAt = (at) => ({ at, cpus: [{ times: { user: at / 5, nice: 0, sys: 0, idle: (at * 4) / 5, irq: 0 } }] });

test("readHealth: measures the CPU against saved CPU times without waiting, when they are old enough and young enough", () => {
    let waits = 0;
    const probes = {
        load: () => ({ load: 30, cores: 4 }), memory: () => 71, disk: () => 50, battery: () => null,
        cpuTimes: () => timesAt(20_000), cpu: () => { waits++; return 55; },
    };
    const since = (at) => readHealth({ probes, limits: LIMITS, cpuSince: timesAt(at) });
    assert.deepEqual([since(20_000 - MIN_CPU_SPAN_MS).busyCpuPct, waits], [20, 0], "half a second old");
    assert.deepEqual([since(20_000 - MAX_SHARED_READING_MS).busyCpuPct, waits], [20, 0], "5 seconds old");
    assert.deepEqual(since(17_000).cpuTimes, timesAt(20_000), "the reading carries the CPU times it ended on");
    assert.deepEqual([since(20_000 - MIN_CPU_SPAN_MS + 1).busyCpuPct, waits], [55, 1], "too young: a reading of its own");
    assert.deepEqual([since(20_000 - MAX_SHARED_READING_MS - 1).busyCpuPct, waits], [55, 2], "too old");
    assert.deepEqual([since(21_000).busyCpuPct, waits], [55, 3], "from the future");
    assert.deepEqual([readHealth({ probes, limits: LIMITS }).busyCpuPct, waits], [55, 4], "none saved");
    const broken = readHealth({ probes, limits: LIMITS, cpuSince: { at: 18_000, cpus: "nonsense" } });
    assert.deepEqual([broken.busyCpuPct, waits], [55, 5], "saved times that make no sense");
    const nonNumber = [{ times: { ...timesAt(18_000).cpus[0].times, user: "3600" } }];
    for (const [i, cpus] of [[null], [{}], nonNumber].entries()) {
        const odd = readHealth({ probes, limits: LIMITS, cpuSince: { at: 18_000, cpus } });
        assert.deepEqual([odd.busyCpuPct, waits], [55, 6 + i], `saved times that make no sense: ${JSON.stringify(cpus)}`);
    }
    const backwards = readHealth({ probes, limits: LIMITS, cpuSince: { at: 18_000, cpus: timesAt(90_000).cpus } });
    assert.deepEqual([backwards.busyCpuPct, waits], [55, 9], "counters that went backwards");
});

test("readHealth: keeps the CPU times also when it does not measure the CPU, and none without limits", () => {
    const probes = {
        load: () => ({ load: 1, cores: 4 }), memory: () => 71, disk: () => 50, battery: () => null,
        cpuTimes: () => timesAt(30_000), cpu: assert.fail,
    };
    assert.deepEqual(readHealth({ probes, limits: LIMITS }).cpuTimes, timesAt(30_000));
    assert.equal("cpuTimes" in readHealth({ probes }), false);
    const failing = readHealth({ probes: { ...probes, cpuTimes: () => { throw new Error("no cpu list"); } }, limits: LIMITS });
    assert.equal(failing.cpuTimes, null);
});

test("cachedHealth: keeps the CPU times beside the reading, hands them to the next reading, stamps the end time", () => {
    const file = join(tempDir("health"), "health.json");
    let now = 10_000;
    const handed = [];
    const read = ({ cpuSince }) => {
        handed.push(cpuSince);
        now += 1000;
        return { load: 1, cores: 4, busyCpuPct: null, freePct: 50, diskGB: 80, battery: null, cpuTimes: timesAt(now) };
    };
    const first = cachedHealth(file, 3000, read, () => now);
    assert.equal("cpuTimes" in first, false, "the CPU times stay out of the reading");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
        at: 11_000, reading: { load: 1, cores: 4, busyCpuPct: null, freePct: 50, diskGB: 80, battery: null }, cpuTimes: timesAt(11_000),
    });
    now = 13_999;
    cachedHealth(file, 3000, read, () => now);
    assert.equal(handed.length, 1, "a reading that took a second is still shared for a whole poll time after it ended");
    now = 14_000;
    cachedHealth(file, 3000, read, () => now);
    assert.deepEqual(handed, [null, timesAt(11_000)]);
});

// Worker threads that each poll the shared reading as a waiting job does, on one virtual clock. A worker runs until
// it waits (its poll sleep or the second the CPU reading takes); then the next waiter in time order runs. So two
// readings overlap in time as they do between real processes, without real waits.
const WAITER = `
const { workerData, parentPort } = require("node:worker_threads");
(async () => {
    const { cachedHealth, readHealth } = await import(workerData.health);
    const ctl = new Int32Array(workerData.shared), slot = 1 + 2 * workerData.id;
    const clock = () => Atomics.load(ctl, 0);
    const block = (ms) => {
        Atomics.store(ctl, slot + 1, clock() + ms);
        Atomics.store(ctl, slot, 1);
        Atomics.notify(ctl, slot);
        while (Atomics.load(ctl, slot) === 1) Atomics.wait(ctl, slot, 1);
    };
    let polls = 0, readings = 0, waits = 0;
    const times = () => { const at = clock(); return { at, cpus: [{ times: { user: at / 5, nice: 0, sys: 0, idle: (at * 4) / 5, irq: 0 } }] }; };
    const probes = {
        load: () => ({ load: 30, cores: 4 }), memory: () => 70, disk: () => 100, battery: () => null,
        cpuTimes: times, cpu: () => { waits++; block(1000); return 20; },
    };
    const read = (options) => { readings++; return readHealth({ ...options, probes, limits: workerData.limits }); };
    block(workerData.offset);
    while (clock() < workerData.until) {
        polls++;
        cachedHealth(workerData.file, workerData.pollMs, read, clock);
        block(workerData.pollMs);
    }
    parentPort.postMessage({ polls, readings, waits });
    Atomics.store(ctl, slot, 2);
    Atomics.notify(ctl, slot);
})();
`;

async function waitTogether({ offsets, pollMs, until }) {
    const file = join(tempDir("health-shared"), "health.json");
    const shared = new SharedArrayBuffer(4 * (1 + 2 * offsets.length)), ctl = new Int32Array(shared);
    const health = new URL("./health.mjs", import.meta.url).href;
    const workers = offsets.map((offset, id) => new Worker(WAITER, {
        eval: true, workerData: { health, shared, id, offset, pollMs, until, file, limits: LIMITS },
    }));
    const results = workers.map((worker) => once(worker, "message"));
    const slot = (id) => 1 + 2 * id, deadline = Date.now() + 30_000;
    const settle = (id) => {
        while (Atomics.load(ctl, slot(id)) === 0) {
            if (Date.now() > deadline) throw new Error(`waiter ${id} did not get to its next wait`);
            Atomics.wait(ctl, slot(id), 0, 100);
        }
    };
    try {
        offsets.forEach((_, id) => settle(id));
        for (;;) {
            const waiting = offsets.map((_, id) => id).filter((id) => Atomics.load(ctl, slot(id)) === 1);
            if (!waiting.length) break;
            const next = waiting.reduce((a, b) => (Atomics.load(ctl, slot(b) + 1) < Atomics.load(ctl, slot(a) + 1) ? b : a));
            Atomics.store(ctl, 0, Math.max(Atomics.load(ctl, 0), Atomics.load(ctl, slot(next) + 1)));
            Atomics.store(ctl, slot(next), 0);
            Atomics.notify(ctl, slot(next));
            settle(next);
        }
        return (await Promise.all(results)).map(([counts]) => counts);
    } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
    }
}

test("cachedHealth: waiters whose readings overlap in time still share them, and only the first ones wait for the CPU", async () => {
    const counts = await waitTogether({ offsets: [0, 700, 1400], pollMs: 3000, until: 40_000 });
    const sum = (key) => counts.reduce((total, c) => total + c[key], 0);
    assert.equal(sum("polls") >= 36, true, `polls: ${JSON.stringify(counts)}`);
    assert.equal(sum("readings") * 2 <= sum("polls"), true, `readings not shared: ${JSON.stringify(counts)}`);
    assert.equal(sum("waits") <= 2, true, `CPU waits after the first round: ${JSON.stringify(counts)}`);
});

test("cachedHealth: one reading per poll time, shared through the cache file", () => {
    const file = join(tempDir("health"), "health.json");
    let readings = 0;
    const read = () => ({ load: ++readings, cores: 4, freePct: 50, diskGB: 80, battery: null });
    assert.equal(cachedHealth(file, 3000, read, () => 10_000).load, 1);
    assert.equal(cachedHealth(file, 3000, read, () => 12_999).load, 1, "a second waiter within the poll time");
    assert.equal(cachedHealth(file, 3000, read, () => 13_000).load, 2, "a new reading once the poll time has passed");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { at: 13_000, reading: { load: 2, cores: 4, freePct: 50, diskGB: 80, battery: null } });
    assert.equal(cachedHealth(file, 3000, read, () => 9_000).load, 3, "a reading from the future is not trusted");
});

test("cachedHealth: a broken or unwritable cache only means a fresh reading", () => {
    const dir = tempDir("health"), broken = join(dir, "health.json"), blocked = join(dir, "folder");
    writeFileSync(broken, "{");
    mkdirSync(join(blocked, "health.json"), { recursive: true });
    const read = () => ({ load: 0.5, cores: 4, freePct: 50, diskGB: 80, battery: null });
    assert.equal(cachedHealth(broken, 3000, read, () => 1000).load, 0.5);
    assert.equal(cachedHealth(join(blocked, "health.json"), 3000, read, () => 1000).load, 0.5);
});

test("cachedHealth: a shared reading older than 5 seconds is read fresh, also with a long poll time", () => {
    const file = join(tempDir("health-cache-age"), "health.json");
    let calls = 0;
    const read = () => ({ load: ++calls, cores: 4, freePct: 60, diskGB: 80, battery: null });
    const pollMs = 300_000;
    assert.equal(MAX_SHARED_READING_MS, 5000);
    assert.equal(cachedHealth(file, pollMs, read, () => 50_000).load, 1);
    assert.equal(cachedHealth(file, pollMs, read, () => 54_999).load, 1, "still young enough to share");
    assert.equal(cachedHealth(file, pollMs, read, () => 55_000).load, 2, "5 seconds old: read fresh");
});
