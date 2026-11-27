// Live readings are checked for their shape only, and the checks compare plain booleans, so a failure never prints
// what the machine is running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./testkit.mjs";
import {
    cpuBusyPct, parseDf, parseLaunchctlList, parseMemoryPressure, parseSwap, pause, probeCpuTimes, probeDiskFreeGB,
    probeGroupOf, probeLoad, probeMemoryFreePct,
    probePowerText, probeProcessCpu, probeProcessTable, probeProcessTree, probeReadPlist, probeScheduledJobs, probeSwapPct, validCpuTimes,
    runTool, showDesktopNotice, toolEnv,
} from "./probes.mjs";

const onMac = process.platform === "darwin";

test("toolEnv: decimals with a dot and UTF-8 text, whatever the locale", () => {
    const env = toolEnv({ LC_ALL: "de_DE.ISO8859-1", LANG: "de_DE.UTF-8", KEEP: "yes" });
    assert.deepEqual(env, { LANG: "de_DE.UTF-8", KEEP: "yes", LC_NUMERIC: "C", LC_CTYPE: "UTF-8" });
});

test("runTool: returns the tool's output, and empty text when the tool is missing", () => {
    assert.equal(runTool(process.execPath, ["-p", "6 * 7"]), "42\n");
    assert.equal(runTool("dotime-tool-that-is-not-installed", ["--version"]), "");
    assert.equal(runTool(process.execPath, ["-e", "process.stdout.write('part'); setTimeout(() => {}, 5000)"], 300), "", "part of a reading is not passed on");
});

test("parseMemoryPressure: reads the free percentage", () => {
    assert.equal(parseMemoryPressure("The system has 1000000000 bytes.\nSystem-wide memory free percentage: 64%\n"), 64);
    assert.equal(parseMemoryPressure("System-wide memory free percentage: 0%"), 0);
    assert.equal(parseMemoryPressure("no such line"), null);
});

test("parseDf: free space in GB, where a full disk is 0 and missing output is null", () => {
    const header = "Filesystem   1024-blocks      Used Available Capacity  Mounted on\n";
    assert.equal(parseDf(`${header}/dev/disk3s2   100000000  94757120   5242880    95%    /\n`), 5);
    assert.equal(parseDf(`${header}/dev/disk3s2   100000000 100000000         0   100%    /\n`), 0);
    assert.equal(parseDf(header), null);
    assert.equal(parseDf(""), null);
    assert.equal(parseDf(undefined), null);
});

test("parseSwap: percent in use, and 0 without swap", () => {
    assert.equal(parseSwap("total = 3000.00M  used = 600.00M  free = 2400.00M  (encrypted)"), 20);
    assert.equal(parseSwap("total = 0.00M  used = 0.00M  free = 0.00M"), 0);
    assert.equal(parseSwap("unexpected"), 0);
});

test("parseLaunchctlList: one entry per label with pid and last exit code", () => {
    const jobs = parseLaunchctlList("PID\tStatus\tLabel\n-\t0\tcom.example.cleanup\n731\t-\tcom.example.mirror\n-\t78\tcom.example.report\n");
    assert.deepEqual([...jobs], [
        ["com.example.cleanup", { pid: null, exit: 0 }],
        ["com.example.mirror", { pid: 731, exit: null }],
        ["com.example.report", { pid: null, exit: 78 }],
    ]);
    assert.equal(parseLaunchctlList("").size, 0);
});

test("probeScheduledJobs: null when the list command fails, a map when it works", () => {
    assert.equal(probeScheduledJobs(() => ({ status: 1, stdout: "" })), null);
    assert.equal(probeScheduledJobs(() => ({ status: 0, stdout: "" })), null);
    assert.equal(probeScheduledJobs(() => { throw new Error("spawn failed"); }), null);
    const jobs = probeScheduledJobs(() => ({ status: 0, stdout: "PID\tStatus\tLabel\n-\t0\tcom.example.cleanup\n" }));
    assert.equal(jobs.get("com.example.cleanup").exit, 0);
});

const core = (user, sys, idle, nice = 0, irq = 0) => ({ times: { user, nice, sys, idle, irq } });

test("cpuBusyPct: the busy share of all cores between two snapshots", () => {
    const before = [core(100, 50, 1000), core(200, 0, 800)];
    const after = [core(160, 70, 1020), core(290, 0, 810, 5, 5)];
    // busy 60 + 20 + 90 + 5 + 5 = 180, idle 20 + 10 = 30
    assert.equal(cpuBusyPct(before, after), (180 / 210) * 100);
    assert.equal(cpuBusyPct([core(0, 0, 0)], [core(0, 0, 500)]), 0);
    assert.equal(cpuBusyPct([core(0, 0, 0)], [core(400, 100, 0)]), 100);
});

test("cpuBusyPct: only cores found in both snapshots count when the core list changed size", () => {
    const two = [core(0, 0, 0), core(0, 0, 0)];
    const three = [core(50, 0, 50), core(100, 0, 0), core(0, 0, 0)];
    assert.equal(cpuBusyPct(two, three), 75);
    assert.equal(cpuBusyPct(three, [core(150, 0, 150)]), 50);
    assert.equal(cpuBusyPct([], three), null);
});

test("cpuBusyPct: null when no time passed or the counters went backwards", () => {
    const same = [core(100, 50, 1000), core(200, 0, 800)];
    assert.equal(cpuBusyPct(same, same), null);
    assert.equal(cpuBusyPct([core(500, 0, 100)], [core(100, 0, 600)]), null);
    assert.equal(cpuBusyPct(undefined, same), null);
    assert.equal(cpuBusyPct([core(100, 0, 500)], [core(300, 0, 450)]), null, "idle went backwards, busy went forward");
});

test("validCpuTimes: a list of cores, each with all five times as numbers of 0 or more", () => {
    assert.equal(validCpuTimes([core(100, 50, 1000), core(0, 0, 0, 3, 2)]), true);
    assert.equal(validCpuTimes([]), true);
    for (const bad of [null, "nonsense", [null], [{}], [{ times: 5 }], [{ times: { user: 1, nice: 0, sys: 0, idle: 9 } }],
        [{ times: { user: "1", nice: 0, sys: 0, idle: 9, irq: 0 } }], [core(Number.NaN, 0, 9)], [core(-1, 0, 9)]]) {
        assert.equal(validCpuTimes(bad), false, JSON.stringify(bad));
    }
});

test("cpuBusyPct: null, not a share since boot, when a snapshot holds cores without valid times", () => {
    const good = [core(100, 0, 900)];
    for (const bad of [[null], [{}], [{ times: 5 }], [{ times: { user: "x", nice: 0, sys: 0, idle: 0, irq: 0 } }]]) {
        assert.equal(cpuBusyPct(bad, good), null, JSON.stringify(bad));
        assert.equal(cpuBusyPct(good, bad), null, JSON.stringify(bad));
    }
});

test("probeCpuTimes: the time and the times of each core, nothing else", () => {
    const got = probeCpuTimes(() => 12_345);
    assert.equal(got.at, 12_345);
    assert.equal(got.cpus.length >= 1, true);
    for (const cpu of got.cpus) {
        assert.deepEqual(Object.keys(cpu), ["times"]);
        assert.equal(["user", "nice", "sys", "idle", "irq"].every((name) => Number.isFinite(cpu.times[name])), true);
    }
    const share = cpuBusyPct(got.cpus, probeCpuTimes().cpus);
    assert.equal(share === null || (share >= 0 && share <= 100), true, "share between two snapshots out of range");
});

test("pause: blocks for about the time asked", () => {
    const began = performance.now();
    assert.equal(pause(40), undefined);
    assert.equal(performance.now() - began >= 35, true);
});

test("probeLoad: a load figure and at least one core", () => {
    const { load, cores } = probeLoad();
    assert.equal(Number.isFinite(load) && load >= 0, true);
    assert.equal(Number.isInteger(cores) && cores >= 1, true);
});

test("live probes: each returns a value of the expected shape", { skip: !onMac }, () => {
    const memory = probeMemoryFreePct(), ownRow = new RegExp(`^\\s*${process.pid}\\s`, "m");
    assert.equal(memory === null || (memory >= 0 && memory <= 100), true, "memory reading out of range");
    const disk = probeDiskFreeGB("/"), swap = probeSwapPct();
    assert.equal(Number.isFinite(disk) && disk >= 0, true, "disk reading missing");
    assert.equal(swap >= 0 && swap <= 100, true, "swap reading out of range");
    assert.equal(typeof probePowerText(), "string", "power reading is not text");
    assert.equal(ownRow.test(probeProcessTable()), true, "own pid missing from the full table");
    assert.equal(ownRow.test(probeProcessCpu()), true, "own pid missing from the CPU table");
    assert.equal(ownRow.test(probeProcessTree()), true, "own pid missing from the tree table");
    assert.equal(probeGroupOf(process.pid) > 0, true, "own process group missing");
    const jobs = probeScheduledJobs();
    assert.equal(jobs === null || jobs instanceof Map, true, "job list has the wrong type");
});

test("probeReadPlist: an object for a job file, null for anything else", { skip: !onMac }, () => {
    const dir = tempDir("plist"), good = join(dir, "cleanup.plist"), broken = join(dir, "broken.plist");
    writeFileSync(
        good,
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key>' +
            '<string>com.example.cleanup</string><key>StartInterval</key><integer>900</integer></dict></plist>'
    );
    writeFileSync(broken, "<plist><dict>");
    assert.deepEqual(probeReadPlist(good), { Label: "com.example.cleanup", StartInterval: 900 });
    assert.equal(probeReadPlist(broken), null);
    assert.equal(probeReadPlist(join(dir, "absent.plist")), null);
});

test("showDesktopNotice: hands the texts over as arguments, outside the script", () => {
    const calls = [];
    const run = (tool, args) => { calls.push({ tool, args }); return { status: 0 }; };
    const title = 'mobile-app "nightly"', message = "finished & display dialog \"x\"";
    assert.equal(showDesktopNotice(title, message, { run, platform: "darwin" }), true);
    assert.equal(calls[0].tool, "osascript");
    assert.deepEqual(calls[0].args.slice(-2), [title, message]);
    assert.equal(calls[0].args.slice(0, -2).some((part) => part.includes("mobile-app") || part.includes("finished")), false);
    assert.equal(showDesktopNotice(title, message, { run: () => ({ status: 1 }), platform: "darwin" }), false);
    assert.equal(showDesktopNotice(title, message, { run, platform: "linux" }), false);
    assert.equal(calls.length, 1);
});
