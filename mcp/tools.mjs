// The queue tools of the MCP server: their definitions, the strict check of their arguments, and what each one does.
// The read tools use the queue's own modules in this process, the same way the dotime-queue command does. queue_run
// never runs a command itself: it stores the request and starts runner.mjs detached, which starts dotime-queue run, so
// the job keeps its own process group, waits under the queue's slot and line rules, and outlives the server. No text
// is ever handed to a shell: the command is an array of words, passed on as separate arguments.
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { historyLines, statusLines } from "../queue/cli.mjs";
import { flakyFor } from "../queue/flaky.mjs";
import { gateReason } from "../queue/gate.mjs";
import { gitState, isRepository } from "../queue/git.mjs";
import { healthVerdict, readHealth, savedCpuTimes } from "../queue/health.mjs";
import { cmdString, findStamp, historyWindow, isFailedRun, lineProject, parseLines, readLines } from "../queue/journal.mjs";
import { folderProject } from "../queue/project.mjs";
import { snapshot } from "../queue/slots.mjs";
import {
    activeJobs, createJob, JOB_ID_RE, jobsDir, KEEP_DAYS, newJobId, pruneJobs, readJob, runnerActive, sameProcess, START_GRACE_MS, tailLines,
} from "./jobs.mjs";

const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));
export const KINDS = Object.freeze(["test", "lint", "build", "deploy", "debug", "other"]);
// A usage error is the one end of dotime-queue run that writes no journal line (see queue/README.md, Exit codes).
const USAGE_EXIT = 2;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// "<project>: <task>": the project part is what the queue reads as the project, up to 40 characters before the colon.
const LABEL_RE = /^[^:\s][^:]{0,39}:\s*\S/;

const text = (type, description, more = {}) => ({ type, description, ...more });
const cwdProperty = (what) => text("string", `Absolute path of an existing folder ${what}. Default: the server's folder.`);

/** The tools, in the order tools/list gives them. */
export const TOOLS = Object.freeze([
    {
        name: "queue_status",
        title: "Queue status",
        description: "Shows the queue: taken and free slots, running and waiting jobs, and whether the health gate is "
            + "open. The same lines as `dotime-queue status`.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: "queue_passed",
        title: "Pass stamp",
        description: "Looks up the pass stamp of a folder: the newest clean run on its current commit whose label or "
            + "command contains match. The same as `dotime-queue passed --match <text> --cwd <dir>`.",
        inputSchema: {
            type: "object",
            properties: {
                match: text("string", "Text to find in the label or command of the run, such as \"unit tests\".", {
                    minLength: 1, maxLength: 500,
                }),
                cwd: cwdProperty("inside the git checkout to look at"),
            },
            required: ["match"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: "queue_history",
        title: "Queue history",
        description: "Totals of the queue journal per project: jobs, failures, skips and time spent waiting. The same "
            + "as `dotime-queue history --days <n>`.",
        inputSchema: {
            type: "object",
            properties: { days: text("integer", "Number of days to sum up, ending today. Default: 7.", { minimum: 1, maximum: 365 }) },
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: "queue_run",
        title: "Run a job through the queue",
        description: "Starts a heavy command (a test suite, a build) through the queue and returns at once with a job "
            + "id; poll queue_job for its state and output. The job waits for a free slot and an open health gate, "
            + "runs in a process group of its own under a run limit, and keeps running if this server exits. A test "
            + "or lint check that already passed on the same clean commit is skipped (outcome skipped) unless noSkip "
            + "is true. The command is a list of words and is never read by a shell. Job records are kept for "
            + "7 days.",
        inputSchema: {
            type: "object",
            properties: {
                label: text("string", "\"<project>: <task>\", such as \"shop-api: unit tests\".", { minLength: 3, maxLength: 200 }),
                command: text("array", "The command and its arguments, one word each, such as [\"npm\", \"test\"].", {
                    items: { type: "string", maxLength: 32768 }, minItems: 1, maxItems: 1000,
                }),
                cwd: cwdProperty("to run the command in"),
                kind: text("string", "Job kind, in place of the one guessed from the label and command.", { enum: KINDS }),
                maxRunMin: text("number", "Run limit for this job in minutes.", { exclusiveMinimum: 0, maximum: 10080 }),
                noSkip: text("boolean", "Run a test or lint check even when it already passed on this commit."),
                afterFix: text("string", "A note on what was fixed, to run a check that failed twice on unchanged code.", {
                    minLength: 1, maxLength: 500,
                }),
                isolate: text("boolean", "Run in a git worktree of its own on a new branch, so jobs side by side never edit "
                    + "the same files; bring it back with dotime-queue integrate <id> -- <check> once it passed."),
            },
            required: ["label", "command"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    {
        name: "queue_job",
        title: "Job state",
        description: "The state of a job started with queue_run: starting, waiting, running, finished or lost (its "
            + "runner ended without a result). For a finished job: the exit code and the outcome from the queue "
            + "journal (ran, skipped, refused, timed-out, gave-up, left, stopped, could-not-start). flaky is null, or "
            + "for a failed or refused run of a check that also passed on the same clean commit, the counts and a note. Also the "
            + "last lines of its output.",
        inputSchema: {
            type: "object",
            properties: {
                jobId: text("string", "The job id queue_run returned.", { minLength: 1, maxLength: 100 }),
                tailLines: text("integer", "How many lines of output to return, from the end. Default: 40.", { minimum: 0, maximum: 500 }),
            },
            required: ["jobId"],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
]);

const TYPES = {
    string: (v) => typeof v === "string",
    integer: (v) => Number.isInteger(v),
    number: (v) => typeof v === "number" && Number.isFinite(v),
    boolean: (v) => typeof v === "boolean",
    array: Array.isArray,
};

/** The problems of one value against a schema of the small subset the tools use, each a short sentence. */
function problemsOf(name, value, schema) {
    if (!TYPES[schema.type](value)) {
        const a = schema.type === "array" ? "an array" : schema.type === "integer" ? "a whole number" : `a ${schema.type}`;
        return [`${name} must be ${a}${schema.type === "array" && schema.items ? ` of ${schema.items.type}s` : ""}`];
    }
    const out = [];
    if (schema.enum && !schema.enum.includes(value)) out.push(`${name} must be one of ${schema.enum.join(", ")}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) {
        out.push(schema.minLength === 1 ? `${name} must not be empty` : `${name} must have at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${name} must have at most ${schema.maxLength} characters`);
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${name} must be at least ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) out.push(`${name} must be above ${schema.exclusiveMinimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${name} must be at most ${schema.maximum}`);
    if (schema.type === "array") {
        if (value.length < (schema.minItems ?? 0)) out.push(`${name} must have at least ${schema.minItems} item${schema.minItems > 1 ? "s" : ""}`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${name} must have at most ${schema.maxItems} items`);
        if (schema.items) {
            const bad = value.findIndex((item) => problemsOf("", item, schema.items).length);
            if (bad >= 0) out.push(`${name}[${bad}]: ${problemsOf("item", value[bad], schema.items).join("; ")}`);
        }
    }
    return out;
}

/** The problems of a tool's arguments against its input schema: unknown names, missing ones, and values that do not
 *  fit. An empty list means they fit. */
export function argumentProblems(args, schema) {
    const out = [];
    for (const name of Object.keys(args)) if (!Object.hasOwn(schema.properties, name)) out.push(`unknown argument ${JSON.stringify(name)}`);
    for (const name of schema.required ?? []) if (args[name] === undefined) out.push(`${name} is required`);
    for (const [name, property] of Object.entries(schema.properties)) {
        if (args[name] !== undefined) out.push(...problemsOf(name, args[name], property));
    }
    return out;
}

class ArgumentError extends Error {}
class Refusal extends Error {}
const fail = (message) => { throw new ArgumentError(message); };
const refuse = (message) => { throw new Refusal(message); };

/** The folder a tool works in: an absolute path to an existing folder, given as its real path, or the server's own
 *  folder when none is given. */
function folderOf(given, ctx) {
    if (given === undefined) {
        try { return realpathSync(ctx.cwd()); } catch { fail("the server's own folder was removed; give cwd"); }
    }
    if (given.includes("\u0000")) fail("cwd must not contain a NUL character");
    if (!isAbsolute(given)) fail(`cwd must be an absolute path, got ${JSON.stringify(given)}`);
    let stat;
    try { stat = statSync(given); } catch { fail(`cwd does not exist: ${given}`); }
    if (!stat.isDirectory()) fail(`cwd is not a folder: ${given}`);
    return realpathSync(given);
}

const result = (lines, structured) => ({ text: lines.join("\n"), structured });

function queueStatus(_args, ctx) {
    const { settings, files } = ctx;
    const { holders, queue, nested } = snapshot({ dirs: files });
    const health = healthVerdict(ctx.readHealth({ limits: settings.health, cpuSince: savedCpuTimes(files.healthCache) }), settings.health);
    const gate = gateReason({ holders, health }, settings.slots);
    const lines = statusLines({ holders, queue, nested, gate, max: settings.slots });
    const now = Date.now();
    const job = (entry) => ({
        label: entry.label, pid: entry.pid, minutes: Math.max(0, Math.round((now - (entry.startedAt ?? entry.at)) / 60_000)),
        ...(entry.kind ? { kind: entry.kind } : {}),
    });
    return result(lines, {
        slots: settings.slots, taken: holders.length, waiting: queue.length, gateOpen: !gate, gate: gate || null,
        running: holders.map(job), line: queue.map(job), lines,
    });
}

function queuePassed(args, ctx) {
    const cwd = folderOf(args.cwd, ctx);
    const commit = gitState(cwd);
    const folder = { project: folderProject(cwd), ...commit, repository: commit.head !== null || isRepository(cwd) };
    const found = findStamp(readLines(ctx.files.journal), folder, args.match, { tz: ctx.tz });
    const stamp = found.stamp;
    return result([found.text], {
        stamp: !!stamp, text: found.text, cwd,
        ...(stamp ? { head: stamp.head, label: stamp.label, command: stamp.cmd, endedAt: stamp.endedAt, runMin: stamp.runMin } : {}),
    });
}

function queueHistory(args, ctx) {
    const days = args.days ?? 7;
    const range = historyWindow({ days, tz: ctx.tz });
    const { all, byProject, lines } = historyLines(readLines(ctx.files.journal), range);
    return result(lines, { days, jobs: all.jobs, all, byProject, lines });
}

/** The words of `dotime-queue run` for a request. Every value is joined to its flag with "=", so a value that starts
 *  with "--" is never read as the next flag, and the command follows "--". */
export function queueArgs({ label, command, kind, maxRunMin, noSkip, afterFix, isolate }) {
    return [
        "run", `--label=${label}`,
        ...(kind ? [`--kind=${kind}`] : []),
        ...(maxRunMin !== undefined ? [`--max-run=${maxRunMin}`] : []),
        ...(noSkip ? ["--no-skip"] : []),
        ...(afterFix !== undefined ? [`--after-fix=${afterFix}`] : []),
        ...(isolate ? ["--isolate"] : []),
        "--", ...command,
    ];
}

function queueRun(args, ctx) {
    const label = args.label.trim();
    if (CONTROL_RE.test(args.label)) fail("label must not contain line breaks or other control characters");
    if (!LABEL_RE.test(label)) fail(`label must look like "<project>: <task>", with at most 40 characters before the colon`);
    if (args.command[0].trim() === "") fail("command[0] must name the program to run");
    const nul = args.command.findIndex((word) => word.includes("\u0000"));
    if (nul >= 0) fail(`command[${nul}] must not contain a NUL character`);
    if (args.afterFix !== undefined && (CONTROL_RE.test(args.afterFix) || !args.afterFix.trim())) {
        fail("afterFix must be one line of text");
    }
    const cwd = folderOf(args.cwd, ctx);
    const dir = jobsDir(ctx.files.home);
    pruneJobs(dir, { check: ctx.sameProcess });
    const max = ctx.settings.mcpMaxJobs;
    const active = activeJobs(dir, { check: ctx.sameProcess }).length;
    if (active >= max) {
        refuse(`refused: ${active} jobs started here are still waiting or running, and mcpMaxJobs in config.json allows `
            + `${max}; wait until one has finished (see queue_job and queue_status), then start this one again`);
    }
    const id = newJobId();
    const request = {
        v: 1, id, label, command: args.command, cwd, createdAt: Date.now(),
        queueArgs: queueArgs({ ...args, label, afterFix: args.afterFix?.trim() }),
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.maxRunMin !== undefined ? { maxRunMin: args.maxRunMin } : {}),
        ...(args.noSkip ? { noSkip: true } : {}),
        ...(args.afterFix !== undefined ? { afterFix: args.afterFix.trim() } : {}),
        ...(args.isolate ? { isolate: true } : {}),
    };
    createJob(dir, id, request);
    ctx.startRunner(dir, id, cwd, ctx.files.home);
    const lines = [
        `started job ${id}: "${label}", command ${cmdString(args.command)}, in ${cwd}`,
        "it waits for a slot under the queue's rules; call queue_job with this jobId for its state and output",
    ];
    return result(lines, { jobId: id, state: "starting", label, command: args.command, cwd });
}

/** Starts the runner of a job detached: in a session and process group of its own, with no tie to this process's
 *  standard streams, so it keeps going when the server exits or is stopped. home is the state folder as an absolute
 *  path: the runner and the queue run in the job's folder, where a relative DOTIME_HOME would name another folder. */
export function startRunner(dir, id, cwd, home, env = process.env) {
    const child = spawn(process.execPath, [RUNNER, dir, id], { cwd, detached: true, stdio: "ignore", env: { ...env, DOTIME_HOME: home } });
    child.on("error", () => { /* the job shows as lost once START_GRACE_MS has passed */ });
    child.unref();
    return child.pid;
}

/** The journal line of a finished job, among the parsed journal rows: the one its own queue process wrote, found by
 *  that process's pid. A line queued before the process started is from an earlier process that had the same pid.
 *  No line: null, never the line of another job. */
function journalLine(request, pid, rows) {
    if (!Number.isInteger(pid?.queuePid)) return null;
    const from = pid.startedAt - 2000;
    return rows
        .find((row) => row.pid === pid.queuePid && row.label === request.label && Date.parse(row.queuedAt) >= from) ?? null;
}

/** The flaky facts of the check a finished job ran, for a failed run or a refusal only, else null: the same note
 *  `dotime-queue run` prints then. */
function flakyOf(row, journal, { settings }) {
    if (!row || !(isFailedRun(row) || row.outcome === "refused")) return null;
    const check = { label: row.label, cmd: row.cmd, project: lineProject(row), cwd: row.cwd };
    return flakyFor(journal, check, { now: Date.now(), windowDays: settings.flakyWindowDays });
}

/** Where a job stands now: { state, position?, nested?, since? }; since is when a running job started (ms). */
function stateOf(job, files, check) {
    if (job.exit) return { state: "finished" };
    if (!runnerActive(job, Date.now(), check)) return { state: "lost" };
    const pid = job.pid?.queuePid;
    if (!pid) return { state: "starting" };
    const { holders, queue, nested } = snapshot({ dirs: files });
    const holder = holders.find((h) => h.pid === pid);
    if (holder) return { state: "running", since: holder.startedAt ?? holder.at };
    const at = queue.findIndex((q) => q.pid === pid);
    if (at >= 0) return { state: "waiting", position: at + 1 };
    const inner = nested.find((n) => n.pid === pid);
    if (inner) return { state: inner.waiting ? "waiting" : "running", nested: true, ...(inner.waiting ? {} : { since: inner.startedAt ?? inner.at }) };
    return { state: "starting" };
}

/** A job and where it stands, for the tasks of the MCP server: { job, where }, or null for an id that names no job. */
export function jobStatus(id, ctx) {
    if (typeof id !== "string" || !JOB_ID_RE.test(id)) return null;
    const job = readJob(jobsDir(ctx.files.home), id);
    if (!job.request) return null;
    return { job, where: stateOf(job, ctx.files, ctx.sameProcess) };
}

function queueJob(args, ctx) {
    const id = args.jobId;
    if (!JOB_ID_RE.test(id)) fail(`jobId ${JSON.stringify(id)} is not a job id; queue_run returns one`);
    const dir = jobsDir(ctx.files.home);
    const job = readJob(dir, id);
    if (!job.request) fail(`unknown job ${id}: it was never started here or was pruned after ${KEEP_DAYS} days`);
    const { request } = job;
    const where = stateOf(job, ctx.files, ctx.sameProcess);
    const info = {
        jobId: id, state: where.state, label: request.label, command: request.command, cwd: request.cwd,
        createdAt: new Date(request.createdAt).toISOString(),
        ...(where.position ? { position: where.position } : {}),
        ...(where.nested ? { nested: true } : {}),
    };
    let head = `job ${id} "${request.label}": ${where.state}`;
    if (where.position) head += `, position ${where.position} in line`;
    if (where.state === "starting" && !job.pid) head += ` (no runner yet; lost after ${START_GRACE_MS / 1000} s)`;
    if (where.state === "lost") head += "; its runner ended without a result, see the output";
    if (job.exit) {
        const journal = parseLines(readLines(ctx.files.journal));
        const row = journalLine(request, job.pid, journal);
        const flaky = flakyOf(row, journal, ctx);
        const outcome = row?.outcome ?? (job.exit.exit === USAGE_EXIT ? "usage-error" : null);
        Object.assign(info, {
            exitCode: job.exit.exit, outcome, ok: job.exit.exit === 0 && (outcome === "ran" || outcome === "skipped"),
            endedAt: new Date(job.exit.endedAt).toISOString(),
            ...(job.exit.signal ? { signal: job.exit.signal } : {}),
            ...(job.exit.error ? { error: job.exit.error } : {}),
            ...(row?.stamp ? { stamp: row.stamp } : {}),
            flaky,
        });
        head += `, exit ${job.exit.exit ?? "none"}${job.exit.signal ? ` (signal ${job.exit.signal})` : ""}`;
        head += `, outcome ${outcome ?? "unknown (no journal line found)"}`;
        if (job.exit.error) head += `; ${job.exit.error}`;
        if (flaky) head += `; ${flaky.note}`;
    }
    const count = args.tailLines ?? 40;
    const tail = tailLines(job.files.log, count);
    info.tail = tail.join("\n");
    const lines = [head];
    if (count > 0) lines.push(tail.length ? `last ${tail.length} lines of output:` : job.exit ? "no output" : "no output yet", ...tail);
    return result(lines, info);
}

const HANDLERS = {
    queue_status: queueStatus, queue_passed: queuePassed, queue_history: queueHistory, queue_run: queueRun, queue_job: queueJob,
};

/** The deps a real server hands to the tools, on top of the settings, files and zone read for each call. */
export const realToolDeps = (env) => ({
    env, cwd: () => process.cwd(), readHealth, sameProcess, kill: (pid, signal) => process.kill(pid, signal),
    startRunner: (dir, id, cwd, home) => startRunner(dir, id, cwd, home, env),
});

/** Runs a tool and gives the tools/call result: { content, structuredContent, isError }. A tool name that is not
 *  in TOOLS gives null, for the caller to answer with a protocol error. Arguments that do not fit, and any failure
 *  inside a tool, give a result with isError and a sentence on what went wrong; nothing here throws. */
export function callTool(name, args, ctx) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return null;
    const error = (message) => ({ content: [{ type: "text", text: message }], isError: true });
    const problems = argumentProblems(args, tool.inputSchema);
    if (problems.length) return error(`invalid arguments for ${name}: ${problems.join("; ")}`);
    try {
        const out = HANDLERS[name](args, ctx);
        // The fields again as JSON text, for clients that do not read structuredContent.
        const content = [{ type: "text", text: out.text }, { type: "text", text: JSON.stringify(out.structured) }];
        return { content, structuredContent: out.structured, isError: false };
    } catch (e) {
        if (e instanceof ArgumentError) return error(`invalid arguments for ${name}: ${e.message}`);
        if (e instanceof Refusal) return error(`${name} ${e.message}`);
        return error(`${name} failed: ${e?.message ?? String(e)}`);
    }
}
