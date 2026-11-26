#!/usr/bin/env node
// Wrapper that the queue starts in a new process group: `node group.mjs <queue pid> <command> [args]`. Because the
// job and everything it starts share that group, one signal reaches all of it. The wrapper ends the way the job
// ended, and it stops the group when the queue process that started it is gone.
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { loadSettings } from "./settings.mjs";
import { alive } from "./slots.mjs";

const queuePid = Number(process.argv[2]), [program, ...args] = process.argv.slice(3);
// The queue process has already reported any setting that does not fit.
const { orphanCheckMs, killGraceMs } = loadSettings(process.env, { warn: () => {} }).limits;
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];
const ignore = () => {};
const signalGroup = (signal) => { try { process.kill(-process.pid, signal); } catch { /* group already gone */ } };

// With default handlers the wrapper would die before the job and lose its exit status.
for (const signal of FORWARDED) process.on(signal, ignore);
const job = spawn(program, args, { stdio: "inherit" });

let orphaned = false;
const watch = setInterval(() => {
    if (process.ppid === queuePid && alive(queuePid)) return;
    clearInterval(watch);
    orphaned = true;
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
}, orphanCheckMs);
watch.unref();

job.on("error", (e) => {
    process.stderr.write(`dotime-queue: start failed: exit 127, ${e.message}\n`);
    process.exit(127);
});
job.on("exit", (code, signal) => {
    if (orphaned) signalGroup("SIGKILL");
    if (!signal) process.exit(code ?? 0);
    // Die by the same signal, so the queue can tell a stopped job from one that exited. Not by SIGUSR1: it would open
    // Node's debugger in this process instead of ending it, so that one ends with the exit code a shell would give.
    if (signal === "SIGUSR1") process.exit(128 + osConstants.signals.SIGUSR1);
    for (const name of FORWARDED) process.off(name, ignore);
    process.kill(process.pid, signal);
    setTimeout(() => process.exit(128 + (osConstants.signals[signal] ?? 0)), 1000); // a signal Node does not die by
});
