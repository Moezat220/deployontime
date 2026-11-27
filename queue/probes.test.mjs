// Live readings are checked for their shape only, and the checks compare plain booleans, so a failure never prints
// what the machine is running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./testkit.mjs";
import {
    cpuBusyPct, parseLaunchctlList, parseMemoryPressure, parseSwap, pause, probeCpuTimes, probeDiskFreeGB,
    probeGroupOf, probeLoad, probeMemoryFreePct,
    probePowerText, probeProcessCpu, probeProcessTable, probeProcessTree, probeReadPlist, probeScheduledJobs, probeSwapPct, validCpuTimes,
    runTool, showDesktopNotice, statfsFreeGB, toolEnv,
} from "./probes.mjs";

const onMac = process.platform === "darwin";
const onLinux = process.platform === "linux";

test("toolEnv: decimals with a dot and UTF-8 text, whatever the locale", () => {
    const env = toolEnv({ LC_ALL: "de_DE.ISO8859-1", LANG: "de_DE.UTF-8", KEEP: "yes" }, "darwin");
    assert.deepEqual(env, { LANG: "de_DE.UTF-8", KEEP: "yes", LC_NUMERIC: "C", LC_CTYPE: "UTF-8" });
});

test("toolEnv: on Linux the UTF-8 locale has the name Linux knows", () => {
    const env = toolEnv({ LC_ALL: "de_DE.ISO8859-1", KEEP: "yes" }, "linux");
    assert.deepEqual(env, { KEEP: "yes", LC_NUMERIC: "C", LC_CTYPE: "C.UTF-8" });
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

const MEMINFO = "MemTotal: 8000000 kB\nMemAvailable: 2000000 kB\nSwapTotal: 1000 kB\nSwapFree: 400 kB\n";
const noTool = () => { throw new Error("no tool may run on Linux"); };
const noFile = () => { throw new Error("no file may be read on macOS"); };

test("probeMemoryFreePct: /proc/meminfo on Linux, memory_pressure elsewhere", () => {
    const files = [];
    const read = (file) => { files.push(file); return MEMINFO; };
    assert.equal(probeMemoryFreePct({ platform: "linux", read, run: noTool }), 25);
    assert.deepEqual(files, ["/proc/meminfo"]);
    const unreadable = probeMemoryFreePct({ platform: "linux", read: () => "", run: noTool });
    assert.equal(unreadable, null, "unreadable file is unknown");
    const tools = [];
    const run = (tool, args) => { tools.push([tool, ...args]); return "System-wide memory free percentage: 64%\n"; };
    assert.equal(probeMemoryFreePct({ platform: "darwin", run, read: noFile }), 64);
    assert.deepEqual(tools, [["memory_pressure"]]);
    const noReading = probeMemoryFreePct({ platform: "darwin", run: () => "", read: noFile });
    assert.equal(noReading, null, "missing tool is unknown");
});

test("probeSwapPct: /proc/meminfo on Linux, sysctl elsewhere", () => {
    assert.equal(probeSwapPct({ platform: "linux", read: () => MEMINFO, run: noTool }), 60);
    assert.equal(probeSwapPct({ platform: "linux", read: () => "", run: noTool }), 0);
    const tools = [];
    const swapusage = "total = 2000.00M  used = 500.00M  free = 1500.00M";
    const run = (tool, args) => { tools.push([tool, ...args]); return swapusage; };
    assert.equal(probeSwapPct({ platform: "darwin", run, read: noFile }), 25);
    assert.deepEqual(tools, [["sysctl", "-n", "vm.swapusage"]]);
});

test("statfsFreeGB: free space in GB, where a full disk is 0 and a missing reading is null", () => {
    assert.equal(statfsFreeGB({ bavail: 1_310_720, bsize: 4096 }), 5);
    assert.equal(statfsFreeGB({ bavail: 0, bsize: 4096 }), 0);
    assert.equal(statfsFreeGB({ bavail: 10, bsize: 0 }), null);
    assert.equal(statfsFreeGB({}), null);
    assert.equal(statfsFreeGB(undefined), null);
});

test("probeDiskFreeGB: one reading for every platform, null when the folder cannot be read", () => {
    const asked = [];
    const statfs = (path) => { asked.push(path); return { bavail: 2_621_440, bsize: 4096 }; };
    assert.equal(probeDiskFreeGB("/srv", { statfs }), 10);
    assert.deepEqual(asked, ["/srv"]);
    const gone = () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
    assert.equal(probeDiskFreeGB("/srv", { statfs: gone }), null);
    assert.equal(probeDiskFreeGB(join(tempDir("disk"), "absent")), null);
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

test("ps probes: the same options on macOS and Linux, except the one that adds finished children", () => {
    const calls = [];
    const run = (tool, args) => { calls.push([tool, ...args]); return ""; };
    probeProcessTable({ run });
    probeProcessCpu({ platform: "darwin", run });
    probeProcessCpu({ platform: "linux", run });
    assert.deepEqual(calls, [
        ["ps", "-ww", "-Ao", "pid=,ppid=,pgid=,etime=,time=,pcpu=,rss=,command="],
        ["ps", "-S", "-Ao", "pid=,ppid=,pgid=,time="],
        ["ps", "--cumulative", "-Ao", "pid=,ppid=,pgid=,time="],
    ]);
});

const liveSkip = onMac || onLinux ? false : "the probes read macOS and Linux only";
test("live probes: each returns a value of the expected shape", { skip: liveSkip }, () => {
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
    if (onLinux) assert.equal(memory !== null, true, "no memory reading from /proc/meminfo");
});

const plutilSkip = { skip: !onMac && "plutil is macOS only" };
test("probeReadPlist: an object for a job file, null for anything else", plutilSkip, () => {
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
    assert.equal(showDesktopNotice(title, message, { run, platform: "win32" }), false);
    assert.equal(calls.length, 1);
});

test("showDesktopNotice: on Linux notify-send, with the texts after the end of its options", () => {
    const calls = [];
    const run = (tool, args) => { calls.push({ tool, args }); return { status: 0 }; };
    assert.equal(showDesktopNotice("--urgency=critical", "-t 1", { run, platform: "linux" }), true);
    assert.deepEqual(calls, [{ tool: "notify-send", args: ["--", "--urgency=critical", "-t 1"] }]);
    assert.equal(showDesktopNotice("t", "m", { run: () => ({ status: 1 }), platform: "linux" }), false, "no session");
    const enoent = Object.assign(new Error("spawn notify-send ENOENT"), { code: "ENOENT" });
    const missing = () => ({ status: null, error: enoent });
    assert.equal(showDesktopNotice("t", "m", { run: missing, platform: "linux" }), false, "not installed");
    const broken = () => { throw new Error("spawn failed"); };
    assert.equal(showDesktopNotice("t", "m", { run: broken, platform: "linux" }), false);
});
