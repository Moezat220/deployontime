#!/usr/bin/env node
// The dotime-mcp command: an MCP server on standard input and output that offers the machine queue as tools
// (queue_status, queue_passed, queue_history, queue_run, queue_job). It is JSON-RPC 2.0, one message per line, written
// by hand with no SDK. It serves both kinds of MCP client:
// - revision 2026-07-28, which has no handshake: every request names its protocol version in
//   _meta["io.modelcontextprotocol/protocolVersion"], and server/discover lists the versions this server supports;
// - revision 2025-11-25 and the ones before it, which open with initialize and notifications/initialized.
// A request with no version in _meta is served the earlier way, whether initialize came first or not. Logging goes
// to standard error only. Input that is not a valid message is answered with a JSON-RPC error and never ends the
// server; it ends when its input closes, or on INT, TERM or HUP. Jobs started with queue_run run detached and go on.
// On 2026-07-28 it offers the tasks extension (see tasks.mjs): queue_run answers with a task when the request's _meta
// asks for that extension, and tasks/get, tasks/cancel and tasks/update serve it. Other clients poll queue_job.
import { readFileSync } from "node:fs";
import { isMainModule, loadSettings, paths, timeZone } from "../queue/settings.mjs";
import { jobsDir, pruneJobs } from "./jobs.mjs";
import { cancelTask, createdTask, getTask, TASKS_EXTENSION, updateTask, wantsTasks } from "./tasks.mjs";
import { callTool, realToolDeps, TOOLS } from "./tools.mjs";

export const MODERN_VERSIONS = Object.freeze(["2026-07-28"]);
/** Revisions answered with initialize; the first is the one offered to a client that asks for another. */
export const HANDSHAKE_VERSIONS = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
/** The versions a request may name in _meta. */
export const SUPPORTED_VERSIONS = Object.freeze([...MODERN_VERSIONS, HANDSHAKE_VERSIONS[0]]);
export const ERRORS = Object.freeze({
    parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603,
    unsupportedVersion: -32022,
});
/** The longest message line read; a longer one is dropped and answered with a parse error. */
export const MAX_LINE_BYTES = 1024 * 1024;
const META = "io.modelcontextprotocol/";
const LIST_TTL_MS = 60 * 60 * 1000;
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const SERVER_INFO = Object.freeze({ name: "dotime-mcp", title: "DeployOnTime machine queue", version: VERSION });
const INSTRUCTIONS = "Run heavy commands (test suites, builds) with queue_run instead of starting them directly, "
    + "then poll queue_job with the job id until it is finished (a client with the tasks extension gets a task "
    + "instead and its result when the job ends). queue_status shows the slots and the line; "
    + "queue_passed finds the pass stamp of a folder's commit; queue_history sums up the journal.";

const isPlain = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const isId = (id) => typeof id === "string" || Number.isInteger(id);
const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const failure = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
const short = (text) => (text.length > 100 ? `${text.slice(0, 100)}...` : text);

/** How a request is to be served, from the version in its _meta: { modern } or { error } with the reply to send. */
function eraOf(id, params) {
    const meta = isPlain(params?._meta) ? params._meta : {};
    const requested = meta[`${META}protocolVersion`];
    if (requested === undefined) return { modern: false };
    if (typeof requested !== "string" || !SUPPORTED_VERSIONS.includes(requested)) {
        return { error: failure(id, ERRORS.unsupportedVersion, "Unsupported protocol version", { supported: [...SUPPORTED_VERSIONS], requested }) };
    }
    const modern = MODERN_VERSIONS.includes(requested);
    if (modern && !isPlain(meta[`${META}clientCapabilities`])) {
        return { error: failure(id, ERRORS.invalidParams, `Invalid params: _meta needs ${META}clientCapabilities, an object`) };
    }
    return { modern };
}

/** A result in the shape of the era it is sent in: a modern one names its type and the server. */
const shaped = (result, modern) => (modern ? { resultType: "complete", ...result, _meta: { [`${META}serverInfo`]: SERVER_INFO } } : result);

/** The server: handleLine(text) gives the reply to one input line, or null when none is due (a notification, a
 *  reply from the client, an empty line). context() gives the settings, files and zone for one tool call, plus the
 *  tool deps. Nothing in here throws or ends the process. */
export function createServer({ context, log = () => {} }) {
    const methods = {
        initialize(params) {
            const asked = params?.protocolVersion;
            if (typeof asked !== "string") return { error: "Invalid params: initialize needs protocolVersion, a string" };
            const protocolVersion = HANDSHAKE_VERSIONS.includes(asked) ? asked : HANDSHAKE_VERSIONS[0];
            return {
                result: {
                    protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS,
                },
            };
        },
        ping: () => ({ result: {} }),
        "server/discover": () => ({
            modern: true,
            result: {
                supportedVersions: [...SUPPORTED_VERSIONS], capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
                instructions: INSTRUCTIONS,
                ttlMs: LIST_TTL_MS, cacheScope: "public",
            },
        }),
        "tools/list": (_params, modern) => ({
            result: { tools: TOOLS.map((tool) => structuredClone(tool)), ...(modern ? { ttlMs: LIST_TTL_MS, cacheScope: "public" } : {}) },
        }),
        "tools/call"(params, modern) {
            if (typeof params?.name !== "string") return { error: "Invalid params: tools/call needs name, a string" };
            const args = params.arguments ?? {};
            if (!isPlain(args)) return { error: "Invalid params: arguments must be an object" };
            const ctx = context();
            const out = callTool(params.name, args, ctx);
            if (!out) return { error: `Unknown tool: ${short(params.name)}` };
            // A job that started becomes a task for a client that asked for one; a refusal stays a plain result.
            if (modern && params.name === "queue_run" && !out.isError && wantsTasks(params)) {
                return { result: createdTask(out.structuredContent.jobId, ctx) };
            }
            return { result: out };
        },
        "tasks/get": (params, modern) => (modern ? getTask(params, context()) : null),
        "tasks/cancel": (params, modern) => (modern ? cancelTask(params, context()) : null),
        "tasks/update": (_params, modern) => (modern ? updateTask() : null),
    };

    function handleMessage(message) {
        if (Array.isArray(message)) return failure(null, ERRORS.invalidRequest, "Invalid request: batches are not supported, send one message per line");
        if (!isPlain(message) || message.jsonrpc !== "2.0") {
            const id = isId(message?.id) ? message.id : null;
            return failure(id, ERRORS.invalidRequest, 'Invalid request: expected a JSON-RPC 2.0 object with "jsonrpc": "2.0"');
        }
        const hasId = Object.hasOwn(message, "id");
        if (typeof message.method !== "string") {
            // A reply from the client to a request: this server sends none, so there is nothing to match it with.
            if (hasId && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) return null;
            return failure(isId(message.id) ? message.id : null, ERRORS.invalidRequest, "Invalid request: method must be a string");
        }
        // Notifications (initialized, cancelled and any other) are never answered; every request here ends at once.
        if (!hasId) return null;
        if (!isId(message.id)) return failure(null, ERRORS.invalidRequest, "Invalid request: id must be a string or a whole number");
        const { id, method, params } = message;
        if (params !== undefined && !isPlain(params)) return failure(id, ERRORS.invalidParams, "Invalid params: params must be an object");
        const handler = Object.hasOwn(methods, method) ? methods[method] : null;
        if (!handler) return failure(id, ERRORS.methodNotFound, `Method not found: ${short(method)}`);
        const era = method === "initialize" ? { modern: false } : eraOf(id, params);
        if (era.error) return era.error;
        const out = handler(params, era.modern);
        // The tasks methods are only part of revision 2026-07-28.
        if (!out) return failure(id, ERRORS.methodNotFound, `Method not found: ${short(method)}`);
        if (out.error) return failure(id, ERRORS.invalidParams, out.error);
        return reply(id, shaped(out.result, era.modern || !!out.modern));
    }

    return {
        handleLine(line) {
            const text = line.trim();
            if (!text) return null;
            let message;
            try { message = JSON.parse(text); } catch { return failure(null, ERRORS.parse, "Parse error: the line is not valid JSON"); }
            try {
                return handleMessage(message);
            } catch (e) {
                log(`internal error: ${e?.stack ?? e}`);
                return failure(isPlain(message) && isId(message.id) ? message.id : null, ERRORS.internal, "Internal error");
            }
        },
    };
}

/** Splits a byte stream into lines and hands each one to onLine. A line longer than maxBytes, its newline not
 *  counted, is dropped as it comes, and onTooLong() is called once for it. Returns { push(chunk), end() }. */
export function lineReader(onLine, onTooLong, maxBytes = MAX_LINE_BYTES) {
    let parts = [];
    let size = 0;
    let dropping = false;
    const flush = () => {
        const line = Buffer.concat(parts).toString("utf8");
        parts = [];
        size = 0;
        onLine(line);
    };
    return {
        push(chunk) {
            let from = 0;
            for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, from)) {
                if (dropping) dropping = false;
                else if (size + at - from > maxBytes) {
                    parts = [];
                    size = 0;
                    onTooLong();
                } else {
                    parts.push(chunk.subarray(from, at));
                    flush();
                }
                from = at + 1;
            }
            if (from >= chunk.length || dropping) return;
            parts.push(chunk.subarray(from));
            size += chunk.length - from;
            if (size > maxBytes) {
                parts = [];
                size = 0;
                dropping = true;
                onTooLong();
            }
        },
        end() { if (size && !dropping) flush(); },
    };
}

/** Runs the server on standard input and output until the input closes. Resolves with the exit code. */
export async function main(env = process.env) {
    const log = (text) => process.stderr.write(`dotime-mcp: ${text}\n`);
    // Read again for every call, as each run of dotime-queue reads them, so a change to config.json counts at once.
    const context = () => ({ settings: loadSettings(env), files: paths(env), tz: timeZone(env), ...realToolDeps(env) });
    try { pruneJobs(jobsDir(paths(env).home)); } catch (e) { log(`old jobs could not be pruned: ${e.message}`); }
    const server = createServer({ context, log });
    let closed = false;
    const send = (message) => {
        if (!message || closed) return;
        process.stdout.write(`${JSON.stringify(message)}\n`);
    };
    return new Promise((resolve) => {
        const finish = (code) => {
            if (closed) return;
            closed = true;
            // Whatever is still buffered for stdout is written before the process ends.
            if (process.stdout.writableLength) process.stdout.once("drain", () => resolve(code));
            else resolve(code);
        };
        process.stdout.on("error", () => finish(0));
        for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.once(signal, () => finish(code));
        const reader = lineReader(
            (line) => send(server.handleLine(line)),
            () => send(failure(null, ERRORS.parse, `Parse error: a message line is longer than ${MAX_LINE_BYTES} bytes`)),
        );
        process.stdin.on("data", (chunk) => reader.push(chunk));
        process.stdin.on("end", () => { reader.end(); finish(0); });
        process.stdin.on("error", () => finish(0));
    });
}

if (isMainModule(import.meta.url)) process.exit(await main());
