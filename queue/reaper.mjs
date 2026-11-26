#!/usr/bin/env node
// The reaper, meant to be started by a scheduler every few minutes. It stops dev servers that have gone idle and
// sends notices about test runs outside the queue, jobs idle in a slot, an overloaded machine and a filling disk.
// Only idle dev servers are ever stopped. `--dry` prints what a run would do and changes nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isMainModule, loadSettings, paths } from "./settings.mjs";
import { alive, snapshot } from "./slots.mjs";
import { idleText, isServer, psSeconds, sampleKeepMs, serverIdleVerdict, TEST_RUN_RE } from "./idle.mjs";
import { slotIdleCheck } from "./limits.mjs";
import { strayRuns } from "./stray.mjs";
import { readHealth } from "./health.mjs";
import { notify as sendNotice } from "./notify.mjs";
import { probeGroupOf, probeLoad, probeProcessCpu, probeProcessTable, probeSwapPct } from "./probes.mjs";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
// Minimum time between two notices of the same sort.
const REPEAT = { stray: HOUR, overload: HOUR, lowDisk: 6 * HOUR };
const OVERLOAD_RUNS = 2;

/** Parses `ps -Ao pid=,ppid=,pgid=,etime=,time=,pcpu=,rss=,command=` text into rows; age in ms, cpu in seconds, rss in KB. */
export function parseProcessTable(text) {
    const rows = [];
    for (const line of String(text ?? "").split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
        if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], age: psSeconds(m[4]) * 1000, cpu: psSeconds(m[5]), pcpu: +m[6], rss: +m[7], cmd: m[8] });
    }
    return rows;
}
/** Returns a Map from process group id to its rows. */
export function groupRows(rows) {
    const groups = new Map();
    for (const row of rows) groups.set(row.pgid, [...(groups.get(row.pgid) ?? []), row]);
    return groups;
}
/** A command line cut down to its program name and first argument, with folders removed. */
export function shortCommand(command) {
    const [program = "", arg] = String(command ?? "").trim().split(/\s+/);
    return [basename(program), arg?.startsWith("/") ? basename(arg) : arg].filter(Boolean).join(" ");
}

/** Sends TERM to a process group, waits, then sends KILL to the processes that are still there. */
export async function stopGroup(pgid, procs, { graceMs = loadSettings().limits.killGraceMs, isAlive = alive } = {}) {
    try { process.kill(-pgid, "SIGTERM"); } catch { /* no such group */ }
    await new Promise((done) => setTimeout(done, graceMs));
    for (const proc of procs) {
        if (!isAlive(proc.pid)) continue;
        try { process.kill(proc.pid, "SIGKILL"); } catch { /* already gone */ }
    }
}

// Programs that only start a script: a dev server's group may hold these above the server.
// The program itself must be the launcher (or the script node runs, as pnpm and yarn appear): a folder named npm
// further along a command line does not count.
const LAUNCHER_RE = /^(\S*\/)?(npm|npx|pnpm|yarn|bun)(\s|$)|^(\S*\/)?node \S*\/(npm|npx|pnpm|yarn)(-cli)?(\.c?js)?(\s|$)|^(\S*\/)?(sh|bash|zsh) -c /;
/** True when every process in the group is the server, a process it started, or a process on the line above it that
 *  is a launcher or itself names a dev server (isServerCmd). */
export function serverOnly(procs, server, isServerCmd = () => false) {
    const byPid = new Map(procs.map((p) => [p.pid, p])), line = new Set([server.pid]);
    for (let grew = true; grew;) {
        grew = false;
        for (const p of procs) if (!line.has(p.pid) && line.has(p.ppid)) { line.add(p.pid); grew = true; }
    }
    for (let p = byPid.get(server.ppid); p && !line.has(p.pid); p = byPid.get(p.ppid)) {
        if (!LAUNCHER_RE.test(p.cmd) && !isServerCmd(p.cmd)) return false;
        line.add(p.pid);
    }
    return procs.every((p) => line.has(p.pid));
}

/** One reaper run over the given readings. Nothing is read from the machine in here, so tests can pass any process
 *  table. state is what the previous run returned. Returns { state, lines, stopped }. */
export async function reap({
    rows, holders = [], queue = [], state = {}, now = Date.now(), dry = false, settings = loadSettings(),
    health = { freePct: null, diskGB: null }, load = 0, cores = 1, swapPct = 0, myPgid = null,
    notify = () => {}, stop = stopGroup, cpuPs = () => "",
}) {
    const next = { samples: {}, streak: 0, lastOverload: 0, ...state };
    const lines = [], stopped = [], R = settings.reaper, groups = groupRows(rows);
    const isDevServer = (command) => isServer(command, R.serverPattern);
    let keep;
    try { keep = new RegExp(R.keepPattern); } catch { keep = null; }

    // Idle dev servers.
    const slotPids = new Set(holders.flatMap((h) => [h.pid, h.pgid]).filter(Boolean));
    const keepMs = sampleKeepMs(settings.idle.serverIdleMin);
    let watched = 0;
    for (const [pgid, procs] of groups) {
        // the innermost match, so a launcher of any shape that names the server (sh -ec "vite & make watch",
        // concurrently "vite" "make watch") is a process above the server, never the server itself
        const matches = procs.filter((p) => isDevServer(p.cmd)), above = new Set(matches.map((p) => p.ppid));
        const server = matches.find((p) => !above.has(p.pid));
        if (pgid <= 1 || pgid === myPgid || !server) { delete next.samples[pgid]; continue; }
        watched++;
        const exempt = procs.some((p) => TEST_RUN_RE.test(p.cmd) || slotPids.has(p.pid) || slotPids.has(p.pgid) || !!keep?.test(p.cmd));
        const cpu = procs.reduce((sum, p) => sum + p.cpu, 0), ageMs = Math.max(...procs.map((p) => p.age));
        const samples = [...(next.samples[pgid] ?? []), { t: now, cpu }].filter((s) => now - s.t <= keepMs);
        next.samples[pgid] = samples;
        const verdict = serverIdleVerdict({ ageMs, samples, now, exempt }, settings.idle), name = shortCommand(server.cmd);
        if (dry) lines.push(`server group ${pgid}: ${name}, ${Math.round(ageMs / MINUTE)} min old, ${cpu.toFixed(0)} s of CPU so far, state ${verdict.state}`);
        if (!verdict.idle) continue;
        if (!serverOnly(procs, server, isDevServer)) { // stopping the group would stop that program too
            lines.push(`idle dev server ${name} (process group ${pgid}) shares its group with another program: left running`);
            continue;
        }
        const memoryMB = Math.round(procs.reduce((sum, p) => sum + (p.rss || 0), 0) / 1024);
        stopped.push(`${name} (process group ${pgid}, ${idleText(verdict)}, ${memoryMB} MB of memory)`);
        if (!dry) { await stop(pgid, procs); delete next.samples[pgid]; }
    }
    for (const pgid of Object.keys(next.samples)) if (!groups.has(Number(pgid))) delete next.samples[pgid];
    if (stopped.length) {
        lines.push(`${dry ? "dry run, would stop after idling" : "stopped after idling"}: ${stopped.join("; ")}`);
        if (!dry) notify("dotime: dev servers stopped", stopped.join("; "));
    }

    // Large test runs that bypassed the queue: reported, never stopped.
    const livePids = new Set(rows.map((row) => row.pid));
    next.strayTold = (next.strayTold ?? []).filter((pid) => livePids.has(pid));
    for (const run of strayRuns(rows, { holders })) {
        const text = `unqueued test run: ${shortCommand(run.cmd)}, pid ${run.rootPid}, ${run.procs} test processes, ${(run.rssMB / 1024).toFixed(1)} GB of memory, left running; `
            + 'hint: start large runs with dotime-queue run --label "<project>: <task>" -- <command>';
        lines.push(text);
        if (dry || next.strayTold.includes(run.rootPid) || now - (next.lastStray ?? 0) <= REPEAT.stray) continue;
        notify("dotime: unqueued test run", text);
        next.lastStray = now;
        next.strayTold.push(run.rootPid);
    }

    // Jobs that hold a slot without doing work.
    try {
        const checked = slotIdleCheck({ holders, waiting: queue, state: next.slotIdle ?? {}, now, dry, notify, ps: cpuPs, idle: settings.idle });
        next.slotIdle = checked.state;
        lines.push(...checked.lines);
    } catch (e) {
        lines.push(`idle-slot check skipped: ${String(e?.message ?? e).slice(0, 200)}`);
    }

    // Overload counts only when it shows on consecutive runs.
    const diskShort = health.diskGB != null && health.diskGB < R.overloadDiskGB;
    const memoryShort = health.freePct != null && health.freePct < R.overloadMemPct;
    const overloaded = load > cores * R.overloadPerCore || swapPct > R.overloadSwapPct || diskShort || memoryShort;
    next.streak = overloaded ? next.streak + 1 : 0;
    if (next.streak >= OVERLOAD_RUNS && now - next.lastOverload > REPEAT.overload) {
        const cpuByProgram = new Map();
        for (const row of rows) { const program = shortCommand(row.cmd).split(" ")[0]; cpuByProgram.set(program, (cpuByProgram.get(program) ?? 0) + row.pcpu); }
        const top = [...cpuByProgram].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([program, pcpu]) => `${program} ${Math.round(pcpu)}%`).join(", ");
        const memory = health.freePct == null ? "no memory reading" : `${health.freePct}% of memory free`;
        const disk = health.diskGB == null ? "no disk reading" : `${health.diskGB.toFixed(1)} GB of disk free`;
        const text = `overloaded: busiest programs ${top || "not known"}; ${cores} cores at load ${load.toFixed(1)}, ${disk}, ${memory}, ${Math.round(swapPct)}% of swap in use`;
        lines.push(text);
        if (!dry) { notify("dotime: machine overloaded", text); next.lastOverload = now; }
    } else if (overloaded) {
        lines.push(`overload seen: run ${next.streak} in a row, no notice this time`);
    }

    if (health.diskGB != null && health.diskGB < R.lowDiskGB && now - (next.lastLowDisk ?? 0) > REPEAT.lowDisk) {
        const text = `disk low: ${health.diskGB.toFixed(1)} GB free, notice level ${R.lowDiskGB} GB`;
        lines.push(text);
        if (!dry) { notify("dotime: disk space low", text); next.lastLowDisk = now; }
    }

    if (!stopped.length && !overloaded) lines.push(`quiet: dev-server groups under watch ${watched}, ${Math.round(swapPct)}% of swap in use, load ${load.toFixed(1)}`);
    return { state: next, lines, stopped };
}

async function main() {
    const dry = process.argv.includes("--dry"), now = Date.now(), stateFile = paths().reaperState;
    let state = {};
    try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* nothing saved yet */ }
    const { holders, queue } = snapshot({ readOnly: dry }), { load, cores } = probeLoad();
    const run = await reap({
        rows: parseProcessTable(probeProcessTable()), holders, queue, state, now, dry, health: readHealth(), load, cores,
        swapPct: probeSwapPct(), myPgid: probeGroupOf(process.pid), notify: (title, message) => sendNotice(title, message), cpuPs: probeProcessCpu,
    });
    for (const line of run.lines) console.log(`${new Date(now).toISOString()} reaper: ${line}`);
    if (dry) {
        if (!existsSync(stateFile)) console.log("reaper: dry run without saved samples, idle servers show only after real runs have covered one idle window");
        return;
    }
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(run.state));
}

if (isMainModule(import.meta.url)) await main();
