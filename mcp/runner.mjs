#!/usr/bin/env node
// The runner of one job the MCP server started: `node runner.mjs <jobs folder> <job id>`. The server starts it
// detached, so it leads a process group and a session of its own and keeps going after the server exits or is
// stopped with Ctrl-C. It starts `dotime-queue run` with the words the server stored in the job's request, sends that
// command's output to the job log, writes the pids to the pid file, and once the command has ended writes its exit
// code to the exit file. The queue's own rules apply unchanged: the queue process waits for a slot, runs the job in
// a process group of its own and journals it. INT, TERM and HUP sent to the runner are passed on to it.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../queue/files.mjs";
import { startTicks } from "../queue/linux.mjs";
import { RERUN_MARKER } from "../queue/lost.mjs";
import { isMainModule } from "../queue/settings.mjs";
import { jobFiles, readJob } from "./jobs.mjs";

const CLI = fileURLToPath(new URL("../queue/cli.mjs", import.meta.url));
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];
// When this process started (wall clock, ms), to tell it from a later process that is given the same pid; on Linux also
// in clock ticks since boot, which a change of the wall clock cannot move.
const BORN = Math.round(Date.now() - process.uptime() * 1000);
const TICKS = startTicks(process.pid);
const ticksField = (name, ticks) => (Number.isInteger(ticks) ? { [name]: ticks } : {});

/** Runs the job and resolves with the runner's exit code: 0 once the exit file is written, 2 when the job cannot be
 *  read. Nothing in here ends the process. */
export function runJobFromRequest(dir, id) {
    let files;
    try { files = jobFiles(dir, id); } catch { return Promise.resolve(2); }
    const { request } = readJob(dir, id);
    if (!request || !Array.isArray(request.queueArgs) || typeof request.cwd !== "string") return Promise.resolve(2);
    const finish = (fields) => writeJsonAtomic(files.exit, { ...fields, endedAt: Date.now() });
    let log;
    try {
        log = openSync(files.log, "a");
    } catch (e) {
        finish({ exit: null, signal: null, error: `the job log could not be opened (${e.code ?? e.message})` });
        return Promise.resolve(0);
    }
    const startedAt = Date.now();
    let child;
    try {
        // The re-run of a lost job tells the queue so, and its journal line names the job it stands in for.
        const env = { ...process.env };
        delete env[RERUN_MARKER];
        if (typeof request.rerunOf === "string") env[RERUN_MARKER] = request.rerunOf;
        child = spawn(process.execPath, [CLI, ...request.queueArgs], { cwd: request.cwd, stdio: ["ignore", log, log], env });
    } catch (e) {
        finish({ exit: null, signal: null, error: `the queue could not be started (${e.message})` });
        return Promise.resolve(0);
    } finally {
        closeSync(log);
    }
    const forward = FORWARDED.map((signal) => [signal, () => { try { child.kill(signal); } catch { /* gone */ } }]);
    for (const [signal, handler] of forward) process.on(signal, handler);
    try {
        if (child.pid) {
            writeJsonAtomic(files.pid, {
                runnerPid: process.pid, runnerStartedAt: BORN, ...ticksField("runnerTicks", TICKS), queuePid: child.pid, startedAt,
                ...ticksField("queueTicks", startTicks(child.pid)),
            });
        }
    } catch { /* the job still runs; queue_job reports it as lost once START_GRACE_MS has passed */ }
    return new Promise((resolve) => {
        let ended = false;
        const end = (fields) => {
            if (ended) return;
            ended = true;
            for (const [signal, handler] of forward) process.off(signal, handler);
            finish(fields);
            resolve(0);
        };
        child.on("error", (e) => end({ exit: null, signal: null, error: `the queue could not be started (${e.message})` }));
        child.on("exit", (code, signal) => end({ exit: code, signal }));
    });
}

if (isMainModule(import.meta.url)) process.exit(await runJobFromRequest(process.argv[2], process.argv[3]));
