#!/usr/bin/env node
// Wrapper that the queue starts in a new process group: `node group.mjs <queue pid> <command> [args]`. Because the
// job and everything it starts share that group, one signal reaches all of it. The wrapper ends the way the job
// ended, and it stops the group when the queue process that started it is gone. When the command cannot be started
// at all, the wrapper says so on file descriptor 3 if the queue opened one, so the queue can tell that apart from a
// job that ran and exited 127.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isMainModule, loadSettings } from "./settings.mjs";
import { alive } from "./slots.mjs";

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];
export const NO_START_EXIT = 127;

/** How the wrapper ends once the job has ended: { exit } with a code, or { reraise, orExit } to die by the same
 *  signal, so the queue can tell a stopped job from one that exited, with orExit as the code for a signal Node does
 *  not die by. SIGUSR1 is never raised again: it would open Node's debugger in this process instead of ending it,
 *  so that one ends with the exit code a shell would give. */
export function exitPlan({ code = null, signal = null }) {
    if (!signal) return { exit: code ?? 0 };
    const shellCode = 128 + (osConstants.signals[signal] ?? 0);
    if (signal === "SIGUSR1") return { exit: shellCode };
    return { reraise: signal, orExit: shellCode };
}

/** True when the queue process that started the wrapper is gone: it is no longer the parent, or it has died. */
export const queueGone = ({ ppid, queuePid, isAlive = alive }) => ppid !== queuePid || !isAlive(queuePid);

/** The line the wrapper sends on file descriptor 3 when the command cannot be started. */
export const startFailure = (message) => `${JSON.stringify({ startFailed: message })}\n`;

function main() {
    const queuePid = Number(process.argv[2]), [program, ...args] = process.argv.slice(3);
    // The queue process has already reported any setting that does not fit.
    const { orphanCheckMs, killGraceMs } = loadSettings(process.env, { warn: () => {} }).limits;
    const ignore = () => {};
    const signalGroup = (signal) => { try { process.kill(-process.pid, signal); } catch { /* group already gone */ } };

    // With default handlers the wrapper would die before the job and lose its exit status.
    for (const signal of FORWARDED) process.on(signal, ignore);
    const job = spawn(program, args, { stdio: "inherit" });

    let orphaned = false;
    const watch = setInterval(() => {
        if (!queueGone({ ppid: process.ppid, queuePid })) return;
        clearInterval(watch);
        orphaned = true;
        signalGroup("SIGTERM");
        setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
    }, orphanCheckMs);
    watch.unref();

    job.on("error", (e) => {
        try { writeSync(3, startFailure(e.message)); } catch { process.stderr.write(`dotime-queue: start failed: exit ${NO_START_EXIT}, ${e.message}\n`); }
        process.exit(NO_START_EXIT);
    });
    job.on("exit", (code, signal) => {
        if (orphaned) signalGroup("SIGKILL");
        const plan = exitPlan({ code, signal });
        if (!plan.reraise) process.exit(plan.exit);
        for (const name of FORWARDED) process.off(name, ignore);
        process.kill(process.pid, plan.reraise);
        setTimeout(() => process.exit(plan.orExit), 1000);
    });
}

if (isMainModule(import.meta.url)) main();
