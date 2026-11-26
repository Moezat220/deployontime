#!/usr/bin/env node
// The reaper, meant to be started by a scheduler every few minutes. It stops dev servers that have gone idle and
// sends notices about test runs outside the queue, jobs idle in a slot, an overloaded machine and a filling disk.
// Only idle dev servers are ever stopped. `--dry` prints what a run would do and changes nothing.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { isMainModule, loadSettings, paths, timeZone } from "./settings.mjs";
import { snapshot } from "./slots.mjs";
import { idleText, sampleKeepMs, serverIdleVerdict, serverTest } from "./idle.mjs";
import { LAUNCHER_RE, TEST_RUN_RE } from "./commands.mjs";
import { parseProcessTable } from "./ps.mjs";
import { ancestors, descendants, stopGroup } from "./proctree.mjs";
import { addNotice, slotIdleCheck } from "./notices.mjs";
import { strayRuns } from "./stray.mjs";
import { readHealth } from "./health.mjs";
import { notify as sendNotice } from "./notify.mjs";
import { readJson, writeJsonAtomic } from "./files.mjs";
import { HOUR, MINUTE } from "./units.mjs";
import { probeGroupOf, probeLoad, probeProcessCpu, probeProcessTable, probeSwapPct } from "./probes.mjs";

// Minimum time between two notices of the same sort.
const REPEAT = { stray: HOUR, overload: HOUR, lowDisk: 6 * HOUR };
const OVERLOAD_RUNS = 2;

/** Returns a Map from process group id to its rows. */
export function groupRows(rows) {
    const groups = new Map();
    for (const row of rows) (groups.get(row.pgid) ?? groups.set(row.pgid, []).get(row.pgid)).push(row);
    return groups;
}
/** A command line cut down to its program name and first argument, with folders removed. */
export function shortCommand(command) {
    const [program = "", arg] = String(command ?? "").trim().split(/\s+/);
    return [basename(program), arg?.startsWith("/") ? basename(arg) : arg].filter(Boolean).join(" ");
}

/** True when every process in the group is the server, a process it started, or a process on the line above it that
 *  is a launcher or itself names a dev server (isServerCmd). */
export function serverOnly(procs, server, isServerCmd = () => false) {
    const line = descendants(procs, [server.pid]);
    for (const p of ancestors(procs, server.ppid)) {
        if (line.has(p.pid)) break;
        if (!LAUNCHER_RE.test(p.cmd) && !isServerCmd(p.cmd)) return false;
        line.add(p.pid);
    }
    return procs.every((p) => line.has(p.pid));
}

// Each check below takes the readings of this run (ctx) and the state the previous run left, and returns
// { state, lines } with the state keys it owns, plus what reap() needs to sum up the run.

/** Idle dev servers: a server group that stayed idle for the window is stopped. State: samples, the CPU samples
 *  per process group. */
export async function checkIdleServers(ctx, state) {
    const { groups, holders, now, dry, settings, myPgid, isDevServer, keep, stopIdle, notify } = ctx;
    const samples = { ...state.samples };
    const lines = [];
    const stopped = [];
    const failed = [];
    const slotPids = new Set(holders.flatMap((h) => [h.pid, h.pgid]).filter(Boolean));
    const keepMs = sampleKeepMs(settings.idle.serverIdleMin);
    let watched = 0;
    for (const [pgid, procs] of groups) {
        // the innermost match, so a launcher of any shape that names the server (sh -ec "vite & make watch",
        // concurrently "vite" "make watch") is a process above the server, never the server itself
        const matches = procs.filter((p) => isDevServer(p.cmd));
        const above = new Set(matches.map((p) => p.ppid));
        const server = matches.find((p) => !above.has(p.pid));
        if (pgid <= 1 || pgid === myPgid || !server) {
            delete samples[pgid];
            continue;
        }
        watched++;
        const protectedProc = (p) => TEST_RUN_RE.test(p.cmd) || slotPids.has(p.pid) || slotPids.has(p.pgid) || !!keep?.test(p.cmd);
        const exempt = procs.some(protectedProc);
        const cpu = procs.reduce((sum, p) => sum + p.cpu, 0);
        const ageMs = Math.max(...procs.map((p) => p.age));
        samples[pgid] = [...(samples[pgid] ?? []), { t: now, cpu }].filter((sample) => now - sample.t <= keepMs);
        const verdict = serverIdleVerdict({ ageMs, samples: samples[pgid], now, exempt }, settings.idle);
        const name = shortCommand(server.cmd);
        if (dry) {
            const age = Math.round(ageMs / MINUTE);
            lines.push(`server group ${pgid}: ${name}, ${age} min old, ${cpu.toFixed(0)} s of CPU so far, state ${verdict.state}`);
        }
        if (!verdict.idle) continue;
        if (!serverOnly(procs, server, isDevServer)) { // stopping the group would stop that program too
            lines.push(`idle dev server ${name} (process group ${pgid}) shares its group with another program: left running`);
            continue;
        }
        const memoryMB = Math.round(procs.reduce((sum, p) => sum + (p.rss || 0), 0) / 1024);
        const what = `${name} (process group ${pgid}, ${idleText(verdict)}, ${memoryMB} MB of memory)`;
        if (!dry) {
            const result = await stopIdle(pgid, procs);
            if (result?.stopped === false) {
                failed.push(what);
                lines.push(`stop failed: idle dev server ${what}, ${result.why}`);
                continue;
            }
            delete samples[pgid];
        }
        stopped.push(what);
    }
    for (const pgid of Object.keys(samples)) if (!groups.has(Number(pgid))) delete samples[pgid];
    if (stopped.length) {
        lines.push(`${dry ? "dry run, would stop after idling" : "stopped after idling"}: ${stopped.join("; ")}`);
        if (!dry) notify("dotime: dev servers stopped", stopped.join("; "));
    }
    return { state: { samples }, lines, stopped, failed, watched };
}

/** Large test runs that bypassed the queue: reported, never stopped, with at most one notice per REPEAT.stray.
 *  State: strayTold, the root pids already told about, and lastStray. */
export function checkStrayRuns(ctx, state) {
    const { rows, holders, now, dry, notify } = ctx;
    const livePids = new Set(rows.map((row) => row.pid));
    const strayTold = (state.strayTold ?? []).filter((pid) => livePids.has(pid));
    let lastStray = state.lastStray;
    const lines = [];
    for (const run of strayRuns(rows, { holders })) {
        const size = `${run.procs} test processes, ${(run.rssMB / 1024).toFixed(1)} GB of memory`;
        const text = `unqueued test run: ${shortCommand(run.cmd)}, pid ${run.rootPid}, ${size}, left running; `
            + 'hint: start large runs with dotime-queue run --label "<project>: <task>" -- <command>';
        lines.push(text);
        if (dry || strayTold.includes(run.rootPid) || now - (lastStray ?? 0) <= REPEAT.stray) continue;
        notify("dotime: unqueued test run", text);
        lastStray = now;
        strayTold.push(run.rootPid);
    }
    return { state: { strayTold, ...(lastStray === undefined ? {} : { lastStray }) }, lines };
}

/** Jobs that hold a slot without doing work: one notice each. State: slotIdle, the CPU samples per slot. */
export function checkIdleSlots(ctx, state) {
    const { holders, queue, now, dry, notify, record, cpuPs, settings, tz } = ctx;
    try {
        const checked = slotIdleCheck({
            holders, waiting: queue, state: state.slotIdle ?? {}, now, dry, notify, record, ps: cpuPs, idle: settings.idle, tz,
        });
        return { state: { slotIdle: checked.state }, lines: checked.lines };
    } catch (e) {
        return { state: {}, lines: [`idle-slot check skipped: ${String(e?.message ?? e).slice(0, 200)}`] };
    }
}

/** An overloaded machine, reported when it shows on OVERLOAD_RUNS runs in a row, at most once per REPEAT.overload.
 *  State: streak and lastOverload. */
export function checkOverload(ctx, state) {
    const { rows, now, dry, notify, health, load, cores, swapPct } = ctx;
    const reaperSettings = ctx.settings.reaper;
    const diskShort = health.diskGB != null && health.diskGB < reaperSettings.overloadDiskGB;
    const memoryShort = health.freePct != null && health.freePct < reaperSettings.overloadMemPct;
    const busy = load > cores * reaperSettings.overloadPerCore || swapPct > reaperSettings.overloadSwapPct;
    const overloaded = busy || diskShort || memoryShort;
    const streak = overloaded ? state.streak + 1 : 0;
    let lastOverload = state.lastOverload;
    const lines = [];
    if (streak >= OVERLOAD_RUNS && now - lastOverload > REPEAT.overload) {
        const cpuByProgram = new Map();
        for (const row of rows) {
            const program = shortCommand(row.cmd).split(" ")[0];
            cpuByProgram.set(program, (cpuByProgram.get(program) ?? 0) + row.pcpu);
        }
        const busiest = [...cpuByProgram].sort((a, b) => b[1] - a[1]).slice(0, 3);
        const top = busiest.map(([program, pcpu]) => `${program} ${Math.round(pcpu)}%`).join(", ");
        const memory = health.freePct == null ? "no memory reading" : `${health.freePct}% of memory free`;
        const disk = health.diskGB == null ? "no disk reading" : `${health.diskGB.toFixed(1)} GB of disk free`;
        const text = `overloaded: busiest programs ${top || "not known"}; ${cores} cores at load ${load.toFixed(1)}, `
            + `${disk}, ${memory}, ${Math.round(swapPct)}% of swap in use`;
        lines.push(text);
        if (!dry) {
            notify("dotime: machine overloaded", text);
            lastOverload = now;
        }
    } else if (overloaded) {
        lines.push(`overload seen: run ${streak} in a row, no notice this time`);
    }
    return { state: { streak, lastOverload }, lines, overloaded };
}

/** Free disk below reaper.lowDiskGB, reported early and at most once per REPEAT.lowDisk. State: lastLowDisk. */
export function checkLowDisk(ctx, state) {
    const { now, dry, notify, health } = ctx;
    const lowDiskGB = ctx.settings.reaper.lowDiskGB;
    if (health.diskGB == null || health.diskGB >= lowDiskGB || now - (state.lastLowDisk ?? 0) <= REPEAT.lowDisk) {
        return { state: {}, lines: [] };
    }
    const text = `disk low: ${health.diskGB.toFixed(1)} GB free, notice level ${lowDiskGB} GB`;
    if (dry) return { state: {}, lines: [text] };
    notify("dotime: disk space low", text);
    return { state: { lastLowDisk: now }, lines: [text] };
}

/** One reaper run over the given readings. Nothing is read from the machine or the state folder in here, so tests
 *  can pass any process table. settings and tz come from the caller; record(key, entry) stores an idle-slot notice.
 *  state is what the previous run returned. Runs the checks in order and merges their state and lines.
 *  Returns { state, lines, stopped }. */
export async function reap({
    rows, holders = [], queue = [], state = {}, now = Date.now(), dry = false, settings, tz,
    health = { freePct: null, diskGB: null }, load = 0, cores = 1, swapPct = 0, myPgid = null,
    notify = () => {}, record = () => {}, stop = null, cpuPs = () => "",
}) {
    let keep;
    try { keep = new RegExp(settings.reaper.keepPattern); } catch { keep = null; }
    const ctx = {
        rows, groups: groupRows(rows), holders, queue, now, dry, settings, tz, health, load, cores, swapPct, myPgid,
        notify, record, cpuPs, keep,
        // Both patterns are compiled once per run.
        isDevServer: serverTest(settings.reaper.serverPattern),
        stopIdle: stop ?? ((pgid, procs) => stopGroup(pgid, procs, { graceMs: settings.limits.killGraceMs })),
    };
    let next = { samples: {}, streak: 0, lastOverload: 0, ...state };
    const lines = [];
    const merge = (result) => {
        next = { ...next, ...result.state };
        lines.push(...result.lines);
        return result;
    };
    const servers = merge(await checkIdleServers(ctx, next));
    merge(checkStrayRuns(ctx, next));
    merge(checkIdleSlots(ctx, next));
    const overload = merge(checkOverload(ctx, next));
    merge(checkLowDisk(ctx, next));
    if (!servers.stopped.length && !servers.failed.length && !overload.overloaded) {
        lines.push(`quiet: dev-server groups under watch ${servers.watched}, ${Math.round(swapPct)}% of swap in use, `
            + `load ${load.toFixed(1)}`);
    }
    return { state: next, lines, stopped: servers.stopped };
}

async function main() {
    const dry = process.argv.includes("--dry");
    const now = Date.now();
    const settings = loadSettings();
    const files = paths();
    const stateFile = files.reaperState;
    const state = readJson(stateFile, {});
    const { holders, queue } = snapshot({ dirs: files, prune: !dry });
    const { load, cores } = probeLoad();
    const run = await reap({
        rows: parseProcessTable(probeProcessTable()), holders, queue, state, now, dry, settings, tz: timeZone(),
        health: readHealth(), load, cores, swapPct: probeSwapPct(), myPgid: probeGroupOf(process.pid),
        notify: (title, message) => sendNotice(title, message, { env: process.env, logFile: files.notifyLog }),
        record: (key, entry) => addNotice(key, entry, files.notices),
        cpuPs: probeProcessCpu,
    });
    for (const line of run.lines) console.log(`${new Date(now).toISOString()} reaper: ${line}`);
    if (dry) {
        if (!existsSync(stateFile)) console.log("reaper: dry run without saved samples, idle servers show only after real runs have covered one idle window");
        return;
    }
    writeJsonAtomic(stateFile, run.state);
}

if (isMainModule(import.meta.url)) await main();
