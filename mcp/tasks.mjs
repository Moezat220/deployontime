// The MCP tasks extension (io.modelcontextprotocol/tasks) of revision 2026-07-28, for queue_run: a client that asks
// for it in a request gets the job back as a task, and its own polling of tasks/get hands the result to the agent
// once the job has finished, with no queue_job rounds. A task is a job of mcp/jobs.mjs and its id is the job id, so a
// task outlives the server as a job does. Each function gives { result } or { error } for the server to send.
import { callTool, jobStatus, lostFacts } from "./tools.mjs";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
/** How often a client is asked to poll tasks/get. */
export const POLL_INTERVAL_MS = 5000;
// The error of a task whose job ended without a result: the queue broke, not the command.
const LOST_CODE = -32603;

const iso = (ms) => new Date(Number(ms) || 0).toISOString();
const isPlain = (x) => !!x && typeof x === "object" && !Array.isArray(x);

/** True when the request's _meta says the client takes task answers. */
export function wantsTasks(params) {
    const caps = params?._meta?.["io.modelcontextprotocol/clientCapabilities"];
    return isPlain(caps) && isPlain(caps.extensions) && isPlain(caps.extensions[TASKS_EXTENSION]);
}

/** The latest moment a job is known to have changed: its end, its start in a slot, its runner's start, its request. */
function lastUpdated({ job, where }) {
    return iso(job.exit?.endedAt ?? where.since ?? job.pid?.startedAt ?? job.request.createdAt);
}

/** A few words on a job that is still working. */
export function workingMessage(where, now = Date.now()) {
    if (where.state === "waiting") return where.position ? `waiting for a slot, position ${where.position}` : "waiting for a nested place";
    if (where.state === "running") return `running for ${Math.max(0, Math.round((now - (where.since ?? now)) / 60_000))} min`;
    return "starting";
}

const STATUS = { finished: "completed", lost: "failed" };
const fields = (id, status) => ({
    taskId: id, status: STATUS[status.where.state] ?? "working",
    createdAt: iso(status.job.request.createdAt), lastUpdatedAt: lastUpdated(status), ttlMs: null,
});

/** The CreateTaskResult for a queue_run call that started a job. */
export function createdTask(id, ctx) {
    const status = jobStatus(id, ctx);
    return {
        resultType: "task", ...fields(id, status), status: "working", statusMessage: workingMessage(status.where),
        pollIntervalMs: POLL_INTERVAL_MS,
    };
}

const unknown = (id) => ({ error: `Invalid params: unknown task ${JSON.stringify(String(id).slice(0, 100))}` });

/** tasks/get: a working job gives working, a finished one completed with the queue_job result (isError unless it
 *  passed or was skipped), a lost one failed, with a message that says it was cut off, when the journal recorded
 *  that, and the job that started it again, if any. */
export function getTask(params, ctx) {
    const id = params?.taskId;
    const status = jobStatus(id, ctx);
    if (!status) return unknown(id);
    const base = fields(id, status);
    if (base.status === "working") return { result: { ...base, statusMessage: workingMessage(status.where), pollIntervalMs: POLL_INTERVAL_MS } };
    if (base.status === "failed") {
        const message = lostFacts(status.job, ctx).text;
        return { result: { ...base, statusMessage: "lost", error: { code: LOST_CODE, message } } };
    }
    const job = callTool("queue_job", { jobId: id }, ctx);
    const outcome = job.structuredContent?.outcome ?? "unknown";
    const result = { ...job, isError: !job.structuredContent?.ok };
    return { result: { ...base, statusMessage: `finished, exit ${status.job.exit.exit ?? "none"}, outcome ${outcome}`, result } };
}

/** tasks/cancel: TERM to the job's runner, which passes it on to the queue process, so a waiting job leaves the line
 *  and a running one is stopped, as the queue does for a signal. A job that has ended already is just answered. */
export function cancelTask(params, ctx) {
    const id = params?.taskId;
    const status = jobStatus(id, ctx);
    if (!status) return unknown(id);
    if (status.where.state === "finished" || status.where.state === "lost") return { result: {} };
    const pid = status.job.pid;
    if (!pid || !ctx.sameProcess(pid.runnerPid, pid.runnerStartedAt, { strict: true, ticks: pid.runnerTicks })) {
        return { error: "Invalid params: the job is still starting and cannot be stopped yet; cancel it again in a moment" };
    }
    try { ctx.kill(pid.runnerPid, "SIGTERM"); } catch (e) {
        if (e.code !== "ESRCH") return { error: `Invalid params: the job could not be stopped (${e.code ?? e.message})` };
    }
    return { result: {} };
}

/** tasks/update: no job ever waits for input, so there is never anything to update. */
export const updateTask = () => ({ error: "Invalid params: no task here ever needs input, so tasks/update has nothing to update" });
