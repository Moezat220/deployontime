#!/usr/bin/env node
// The dotime-queue command. `run` waits for a slot and runs one job under a run limit; `status` shows slots, line
// and gate; `passed` looks up a pass stamp; `history` sums up the journal. queue/README.md describes each in full.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainModule, loadSettings, timeZone } from "./settings.mjs";
import { minutesSince } from "./clock.mjs";
import { blockReason, blockText, decide, enqueue, gateBlocks, gateReason, parseMaxWait, releaseSlot, shouldGiveUp, snapshot, takeSlot, updateSlot } from "./slots.mjs";
import { healthVerdict, readHealth } from "./health.mjs";
import { addNotice, afterMinutes, cmdStem, codePrint, decideLimit, failStop, killTree, kindOf, kindStats, longRunAlert, MAX_TIMER_MS, opt, parseMaxRun, stemStats, UNLABELLED } from "./limits.mjs";
import { addWait, append, cmdString, findStamp, gitState, historyWindow, jobEnd, readLines, record, summarize } from "./journal.mjs";
import { notify } from "./notify.mjs";
import { folderProject, jobProject } from "./project.mjs";
import { flagError } from "./args.mjs";

const MINUTE = 60_000;
const EXIT = { usage: 2, refused: 3, gaveUp: 75, timedOut: 124, noStart: 127, left: 130 };
const REPEAT_WAIT_LINE_MS = MINUTE;

export const USAGE = [
    "dotime-queue: one shared queue for heavy jobs on this computer",
    "",
    '  dotime-queue run --label "<project>: <task>" [options] -- <command> [args]',
    "      --max-wait <min>     leave the line after this many minutes (0: wait without limit)",
    "      --max-run <min>      run limit for this job",
    "      --kind <name>        job kind, in place of the guessed one",
    '      --after-fix "<note>" run a check that failed twice on unchanged code',
    "      --priority           join the line at the front",
    "  dotime-queue status",
    "  dotime-queue passed [--match <text>] [--cwd <dir>]",
    "  dotime-queue history [--days <n> | --day <YYYY-MM-DD>]",
].join("\n");

/** Returns { label, cmd, priority, maxWait, maxRun, kind, afterFix }, or { error } with the text to print. */
export function parseRunArgs(args, settings = loadSettings()) {
    const cut = args.indexOf("--");
    if (args[0] !== "run" || cut < 0 || cut === args.length - 1) return { error: USAGE };
    const badFlag = flagError(args);
    if (badFlag) return { error: badFlag };
    const maxWait = parseMaxWait(args, settings.maxWaitMin);
    if (maxWait === null) return { error: "--max-wait wants a number of minutes, 0 or more; 0 means no limit" };
    const maxRun = parseMaxRun(args);
    if (Number.isNaN(maxRun)) return { error: "--max-run wants a positive number of minutes" };
    return {
        label: opt(args, "--label")?.trim() || UNLABELLED, cmd: args.slice(cut + 1), priority: args.slice(0, cut).includes("--priority"),
        maxWait, maxRun, kind: opt(args, "--kind"), afterFix: opt(args, "--after-fix")?.trim() || null,
    };
}

/** The lines `status` prints. gate: the reason the gate is shut, or "". */
export function statusLines({ holders, queue, gate, max, now = Date.now() }) {
    const lines = [`slots: ${holders.length} of ${max} taken, ${queue.length} waiting`];
    for (const h of holders) {
        const began = h.startedAt ?? h.at, ranMin = (now - began) / MINUTE;
        const facts = [`pid ${h.pid}`];
        if (h.kind) facts.push(`kind ${h.kind}`);
        facts.push(`${minutesSince(began, now)} min so far`);
        if (h.limitMin == null) facts.push("limit unknown");
        else {
            facts.push(`limit ${h.limitMin} min`);
            if (h.priority) facts.push(`priority (warning at ${h.limitMin} min, stop at ${h.killMin} min)`);
            facts.push(`${Math.max(0, Math.round((h.killMin ?? h.limitMin) - ranMin))} min left`);
            if (h.longRunMin && ranMin > h.longRunMin) facts.push(`past the ${h.longRunMin} min long-run mark`);
        }
        lines.push(`running "${h.label}": ${facts.join(", ")}`);
    }
    queue.forEach((q, i) => lines.push(`waiting ${i + 1} "${q.label}": pid ${q.pid}, ${minutesSince(q.at, now)} min so far${q.priority ? ", priority" : ""}`));
    lines.push(gate ? `gate: shut; ${gate}` : "gate: open");
    return lines;
}

/** One line of `history` for a project's totals. */
export function historyRow(name, t) {
    const gates = Object.entries(t.waitBy).map(([gate, min]) => `${gate} ${min} min`).join(", ") || "nothing";
    return `${name}: jobs ${t.jobs}, failed ${t.failed}, stopped ${t.stopped}, timed out ${t.timedOut}, refused ${t.refused}, gave up ${t.gaveUp}; `
        + `waited: jobs ${t.waited}, sum ${t.waitMinTotal} min, clock ${t.waitWallMin} min, clock with no job running ${t.blockedOnlyMin} min, `
        + `median ${t.waitMedian} min, p90 ${t.waitP90} min; held by: ${gates}`;
}

const say = (text) => process.stderr.write(`dotime-queue: ${text}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function cmdStatus(settings) {
    const { holders, queue } = snapshot();
    const gate = gateReason({ holders, health: healthVerdict(readHealth(), settings.health) }, settings.slots);
    for (const line of statusLines({ holders, queue, gate, max: settings.slots })) console.log(line);
    return 0;
}

function cmdPassed(args) {
    const dir = opt(args, "--cwd") || process.cwd();
    const found = findStamp(readLines(), { project: folderProject(dir), ...gitState(dir) }, opt(args, "--match") || "");
    console.log(found.text);
    return found.stamp ? 0 : 1;
}

function cmdHistory(args) {
    const day = opt(args, "--day"), daysText = opt(args, "--days");
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) { say("--day: needs a date as YYYY-MM-DD"); return EXIT.usage; }
    if (daysText !== undefined && !/^[1-9]\d*$/.test(daysText)) { say("--days: needs a whole number of days, 1 or more"); return EXIT.usage; }
    const range = historyWindow({ day, days: daysText === undefined ? 7 : Number(daysText), tz: timeZone() });
    const { all, byProject } = summarize(readLines(), range.from, range.to);
    console.log(`history: ${range.title}, jobs ${all.jobs}`);
    if (all.jobs) for (const [name, t] of [["all projects", all], ...Object.entries(byProject)]) console.log(historyRow(name, t));
    return 0;
}

/** Runs one job and resolves with the exit code for `run`. */
async function cmdRun(args, settings) {
    const parsed = parseRunArgs(args, settings);
    if (parsed.error) { if (parsed.error === USAGE) process.stderr.write(`${USAGE}\n`); else say(parsed.error); return EXIT.usage; }
    const { label, cmd, priority, maxWait, maxRun, afterFix } = parsed, L = settings.limits, max = settings.slots;
    const queuedAt = Date.now(), cwd = process.cwd(), folder = folderProject(cwd), command = cmdString(cmd);
    const project = jobProject({ label, project: folder, cwd }), tally = {};

    const past = readLines(), kind = kindOf(label, command, parsed.kind), stem = cmdStem(command);
    const window = { project, now: queuedAt, windowDays: L.windowDays };
    const limit = decideLimit({ maxRun, kind, stats: kindStats(past, { ...window, kind }), stem: stemStats(past, { ...window, stem }), priority }, L);
    const before = { ...gitState(cwd), fp: codePrint(cwd, cmd, settings.outputDirs) };
    const details = { kind, ...(stem ? { stem } : {}), limitMin: limit.limitMin, limitBasis: limit.basis, fp: before.fp, ...(afterFix ? { afterFix } : {}) };
    let slot = null, startedAt = null, written = false, commit = { head: null, clean: null };
    const finish = (outcome, exit, more = {}) => {
        if (written) return;
        written = true;
        append(record({ label, project: folder, cwd, priority, queuedAt, startedAt, endedAt: Date.now(), outcome, exit, tally, cmd: command, ...commit, extra: { ...details, ...more } }));
    };
    const verdict = failStop(past, { label, cmd: command, project, cwd, head: before.head, fp: before.fp, at: queuedAt }, L);
    if (verdict.refuse && !afterFix) {
        commit = before;
        finish("refused", EXIT.refused);
        say(`refused: exit ${EXIT.refused}; ${verdict.reason}`);
        return EXIT.refused;
    }
    if (verdict.refuse) say(`--after-fix accepted: note "${afterFix}", the check had failed twice on unchanged code`);

    // Wait in line.
    const ticket = enqueue(process.pid, label, priority);
    const leaveQueue = () => { rmSync(ticket, { force: true }); releaseSlot(slot, process.pid); };
    process.on("exit", leaveQueue);
    const whileWaiting = ["SIGINT", "SIGTERM"].map((signal) => [signal, () => { finish("left", EXIT.left, { signal }); leaveQueue(); process.exit(EXIT.left); }]);
    for (const [signal, handler] of whileWaiting) process.on(signal, handler);
    const waitFrom = Date.now();
    let shownPosition = 0, shownAt = 0;
    while (!slot) {
        const snap = snapshot(), turn = decide(snap, process.pid, max), ahead = turn.position - 1;
        // Only full slots make the health reading irrelevant to a waiter.
        const slotFree = snap.holders.length < max;
        const health = turn.go || slotFree ? healthVerdict(readHealth(), settings.health) : null;
        if (turn.go && health.ok) {
            slot = takeSlot(process.pid, label, max, { kind, limitMin: limit.limitMin, killMin: limit.killMin, longRunMin: limit.longRunMin, project, cwd, ...(priority ? { priority: true } : {}) });
        }
        if (slot) break;
        const heldBy = blockReason({ holders: snap.holders, health, ahead }, max);
        const giveUp = shouldGiveUp({ startedAt: waitFrom, now: Date.now(), maxWaitMin: maxWait });
        if (giveUp || turn.position !== shownPosition || Date.now() - shownAt > REPEAT_WAIT_LINE_MS) {
            const all = gateBlocks({ holders: snap.holders, health: health ?? healthVerdict(readHealth(), settings.health), ahead }, max);
            const why = blockText(all) || "slot lost: another job took it a moment ago";
            if (giveUp) {
                finish("gave-up", EXIT.gaveUp);
                say(`gave up: exit ${EXIT.gaveUp}, position ${turn.position}, ${minutesSince(waitFrom)} min waited; ${why}; hint: --max-wait 0 waits without limit`);
                leaveQueue();
                return EXIT.gaveUp;
            }
            say(`in line: position ${turn.position}, ${minutesSince(waitFrom)} min waited, ${maxWait ? `wait limit ${maxWait} min` : "no wait limit"}; ${why}`);
            shownPosition = turn.position;
            shownAt = Date.now();
        }
        const sleptFrom = Date.now();
        await sleep(settings.pollMs);
        addWait(tally, heldBy, Date.now() - sleptFrom);
    }

    // Run the job. The commit is read at this point because it is what a pass stamp will vouch for.
    commit = gitState(cwd);
    startedAt = Date.now();
    rmSync(ticket, { force: true });
    if (startedAt - waitFrom > 5000) say(`started: ${minutesSince(waitFrom)} min in line`);
    for (const [signal, handler] of whileWaiting) process.off(signal, handler);
    const wrapper = fileURLToPath(new URL("./group.mjs", import.meta.url));
    // File descriptor 3 is a pipe on which the wrapper reports a command that could not be started. Only the
    // wrapper holds it; the job does not inherit it.
    const child = spawn(process.execPath, [wrapper, String(process.pid), ...cmd], { stdio: ["inherit", "inherit", "inherit", "pipe"], detached: true });
    let report = "";
    child.stdio[3]?.setEncoding("utf8").on("data", (text) => { report += text; });
    updateSlot(slot, process.pid, { pgid: child.pid, startedAt });
    const signalJob = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } } };

    // INT, TERM and HUP go on to the job; the first one received is kept for the journal.
    let received = null, receivedAt = null;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => { if (!received) { received = signal; receivedAt = Date.now(); } signalJob(signal); });
    }
    process.on("exit", () => { if (child.exitCode === null && child.signalCode === null) signalJob("SIGTERM"); });

    let pastLimit = false, longRunAt = null, warnedAt = null, ended = false, done;
    const result = new Promise((resolve) => { done = resolve; });
    const end = (exit) => { if (!ended) { ended = true; releaseSlot(slot, process.pid); done(exit); } };
    const stamps = () => ({ ...(longRunAt ? { longRunAt: new Date(longRunAt).toISOString() } : {}), ...(warnedAt ? { warnedAt: new Date(warnedAt).toISOString() } : {}) });
    const endTimedOut = () => {
        if (ended) return;
        killTree(child.pid, "SIGKILL");
        finish("timed-out", EXIT.timedOut, stamps());
        say(`timed out: exit ${EXIT.timedOut}, stopped after ${limit.killMin} min; hint: the kind was taken as ${kind} (--kind <name> overrides it), and --max-run <min> sets the limit directly`);
        end(EXIT.timedOut);
    };
    afterMinutes(limit.killMin, () => {
        pastLimit = true;
        say(`run limit: stopping "${label}", KILL follows TERM after ${L.killGraceMs / 1000} s; ran ${limit.killMin} min against a limit of ${limit.limitMin} min, set by ${limit.basis}`);
        killTree(child.pid, "SIGTERM");
        setTimeout(() => killTree(child.pid, "SIGKILL"), L.killGraceMs).unref();
        // Backstop for a wrapper that never exits.
        setTimeout(endTimedOut, Math.min(L.killGraceMs + 5000, MAX_TIMER_MS)).unref();
    });
    if (priority) {
        afterMinutes(limit.limitMin, () => {
            warnedAt = Date.now();
            say(`priority warning: hard stop at ${limit.killMin} min, the ${limit.limitMin} min limit (set by ${limit.basis}) was passed by "${label}"`);
        });
    }
    if (limit.notifyLongRun) {
        afterMinutes(limit.longRunMin, () => {
            longRunAt = Date.now();
            try {
                const alert = longRunAlert({ label, project, pid: process.pid, minutes: minutesSince(startedAt, longRunAt), longRunBasis: limit.longRunBasis, limitMin: limit.limitMin, killMin: limit.killMin, startedAt, waiting: snapshot().queue, now: longRunAt });
                say(alert.message);
                notify(alert.title, alert.message);
                addNotice(alert.key, alert.entry);
            } catch { /* a notice that fails must not disturb the job */ }
        });
    }
    // "close" comes after the wrapper has exited and its report pipe is drained.
    child.on("close", (code, signal) => {
        if (pastLimit) return endTimedOut();
        const startFailed = startFailure(report);
        if (startFailed !== null) {
            finish("could-not-start", EXIT.noStart, stamps());
            say(`start failed: exit ${EXIT.noStart}, ${startFailed}`);
            return end(EXIT.noStart);
        }
        const exit = code ?? (signal ? 1 : 0), how = jobEnd({ code, signal, received });
        finish(how.outcome, exit, { ...stamps(), ...(how.signal ? { signal: how.signal, stoppedAt: new Date(receivedAt ?? Date.now()).toISOString() } : {}) });
        if (how.signal) say(`stopped: signal ${how.signal}, ${minutesSince(startedAt)} min run, journalled as stopped and not as failed`);
        end(exit);
    });
    // The wrapper is node itself, so this happens only when the system cannot start a process at all.
    child.on("error", (e) => {
        finish("could-not-start", EXIT.noStart);
        say(`start failed: exit ${EXIT.noStart}, ${e.message}`);
        end(EXIT.noStart);
    });
    return result;
}

/** The wrapper's start-failure message from its report text, or null when it reported none. */
function startFailure(text) {
    for (const line of text.split("\n")) {
        try { const sent = JSON.parse(line); if (typeof sent?.startFailed === "string") return sent.startFailed; } catch { /* not a report line */ }
    }
    return null;
}

/** Runs one subcommand and resolves with its exit code. */
export async function main(args = process.argv.slice(2)) {
    if (args[0] === "help" || args[0] === "--help") { console.log(USAGE); return 0; }
    const command = args.length ? args[0] : "status";
    const badFlag = command === "run" ? null : flagError([command, ...args.slice(1)]);
    if (badFlag) { say(badFlag); return EXIT.usage; }
    const settings = loadSettings();
    if (command === "status") return cmdStatus(settings);
    if (command === "passed") return cmdPassed(args);
    if (command === "history") return cmdHistory(args);
    return cmdRun(args, settings);
}

if (isMainModule(import.meta.url)) process.exit(await main());
