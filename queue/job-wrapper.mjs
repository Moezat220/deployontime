#!/usr/bin/env node
// Wrapper that the queue starts in a new process group: `node job-wrapper.mjs <queue pid> <command> [args]`.
// Because the job and everything it starts share that group, one signal reaches all of it. The wrapper ends the way
// the job ended, and it stops the group when the queue process that started it is gone. When the command cannot be
// started at all, the wrapper says so on file descriptor 3 if the queue opened one, so the queue can tell that apart
// from a job that ran and exited 127. The job's stdio is the wrapper's own, inherited as it is. After a failure, the
// wrapper reads back what the job added to the file its stdout or stderr goes to, if it is a file (outputfile.mjs),
// and sends on file descriptor 3 the class that output points to: never the output itself.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isMainModule, loadSettings } from "./settings.mjs";
import { alive, signalGroup } from "./proctree.mjs";
import { textReason } from "./failreason.mjs";
import { outputSinks, readOutput, sourceOf } from "./outputfile.mjs";

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
export const startFailureLine = (message) => `${JSON.stringify({ startFailed: message })}\n`;

/** The message from a start-failure line in the text read from file descriptor 3, or null when there is none.
 *  Other lines and a line that was cut short are passed over. */
export function readStartFailure(text) {
    for (const line of String(text).split("\n")) {
        let sent;
        try { sent = JSON.parse(line); } catch { continue; /* not a report line */ }
        if (typeof sent?.startFailed === "string") return sent.startFailed;
    }
    return null;
}

/** The line the wrapper sends on file descriptor 3 after a failed job: seen says whether it read the output, found is
 *  what textReason() made of it, and source, when it was not read, says why (see readOutput). */
export const reasonLine = ({ seen, found, source }) =>
    `${JSON.stringify({ seen, found: found ?? null, ...(seen ? {} : { source: source ?? null }) })}\n`;

/** The { seen, found, source } of a reason line in the text read from file descriptor 3, or null when there is none. */
export function readReason(text) {
    for (const line of String(text).split("\n")) {
        let sent;
        try { sent = JSON.parse(line); } catch { continue; /* not a report line */ }
        if (typeof sent?.seen === "boolean") {
            return { seen: sent.seen, found: sent.found ?? null, ...(sent.seen ? {} : { source: sent.source ?? null }) };
        }
    }
    return null;
}

/** What the wrapper sends after the job ended with code or signal: null for a pass. Only a job that exited with a
 *  code other than 0 has its output read; a job ended by a signal is classed by the signal alone. */
export function failureReport({ code, signal }, sinks, read = readOutput) {
    if (code === 0 || (code === null && !signal)) return null;
    const got = code === null ? { source: sourceOf(sinks) } : read(sinks);
    return got.text !== undefined ? { seen: true, found: textReason(got.text, code) } : { seen: false, source: got.source };
}

/** How long the queue keeps reading the report after the wrapper has exited. */
export const REPORT_DRAIN_MS = 500;

/** Resolves with { code, signal, report } once the wrapper has exited and its report on file descriptor 3 has been
 *  read. The report is read for at most drainMs after the exit: on systems where the job inherits the descriptor,
 *  a process the job leaves behind keeps it open, and that must not keep the queue waiting. */
export function wrapperEnd(child, report, drainMs = REPORT_DRAIN_MS) {
    return new Promise((resolve) => {
        let text = "";
        let exit = null;
        let drained = !report;
        let timer = null;
        let settled = false;
        const settle = () => {
            if (settled || !exit || !drained) return;
            settled = true;
            clearTimeout(timer);
            report?.destroy();
            resolve({ ...exit, report: text });
        };
        const stopReading = () => { drained = true; settle(); };
        report?.setEncoding("utf8");
        report?.on("data", (part) => { text += part; });
        for (const event of ["end", "close", "error"]) report?.on(event, stopReading);
        child.on("exit", (code, signal) => {
            exit = { code, signal };
            timer = setTimeout(stopReading, drainMs);
            settle();
        });
    });
}

function main() {
    const queuePid = Number(process.argv[2]), [program, ...args] = process.argv.slice(3);
    // The queue process has already reported any setting that does not fit.
    const { orphanCheckMs, killGraceMs } = loadSettings(process.env, { warn: () => {} }).limits;
    const ignore = () => {};
    // A group that is already gone needs no signal.
    const signalOwnGroup = (signal) => signalGroup(process.pid, signal);

    // With default handlers the wrapper would die before the job and lose its exit status.
    for (const signal of FORWARDED) process.on(signal, ignore);
    // Noted before the job writes anything: what it wrote before is never read.
    const sinks = outputSinks();
    const job = spawn(program, args, { stdio: "inherit" });

    let orphaned = false;
    const watch = setInterval(() => {
        if (!queueGone({ ppid: process.ppid, queuePid })) return;
        clearInterval(watch);
        orphaned = true;
        signalOwnGroup("SIGTERM");
        setTimeout(() => signalOwnGroup("SIGKILL"), killGraceMs);
    }, orphanCheckMs);
    watch.unref();

    job.on("error", (e) => {
        try {
            writeSync(3, startFailureLine(e.message));
        } catch {
            process.stderr.write(`dotime-queue: start failed: exit ${NO_START_EXIT}, ${e.message}\n`);
        }
        process.exit(NO_START_EXIT);
    });
    job.on("exit", (code, signal) => {
        if (orphaned) signalOwnGroup("SIGKILL");
        const sent = failureReport({ code, signal }, sinks);
        if (sent) try { writeSync(3, reasonLine(sent)); } catch { /* no report pipe: the queue records unknown */ }
        const plan = exitPlan({ code, signal });
        if (!plan.reraise) process.exit(plan.exit);
        for (const name of FORWARDED) process.off(name, ignore);
        process.kill(process.pid, plan.reraise);
        setTimeout(() => process.exit(plan.orExit), 1000);
    });
}

if (isMainModule(import.meta.url)) main();
