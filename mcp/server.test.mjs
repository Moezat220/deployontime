// Tests of the MCP server. Most start the real mcp/server.mjs and talk to it over its standard streams, one JSON
// message per line, each with a state folder of its own whose config.json sets short polls and health limits so wide
// that no reading of this computer shuts the gate. Jobs run through the real dotime-queue in a temp git repository.
// Signals are sent only to processes started here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv, isolateProcess, makeRepo, pause, tempDir, track, until } from "../queue/testkit.mjs";

isolateProcess("mcp");
const { lineReader } = await import("./server.mjs");
const { argumentProblems, queueArgs, TOOLS } = await import("./tools.mjs");
const { createJob, jobFiles, pruneJobs, tailLines } = await import("./jobs.mjs");
const { alive } = await import("../queue/proctree.mjs");

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url)), NODE = process.execPath;
const WIDE_OPEN = { loadPerCore: 1000, minFreeMemPct: 0, minFreeDiskGB: 0, minBatteryPct: 0 };
const MODERN_META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const TASKS_META = { ...MODERN_META, "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } } };
const JOB_WAIT_MS = 30_000;

function sandbox(config = {}) {
    const home = tempDir("mcp-home");
    writeFileSync(join(home, "config.json"), JSON.stringify({ pollMs: 60, ...config, health: WIDE_OPEN, limits: { killGraceMs: 250 } }));
    const repo = makeRepo(join(tempDir("mcp-repo"), "shop"));
    return { home, repo, env: cleanEnv(home) };
}

/** Starts the server. detached: it leads its own process group, as a server started in a terminal does. */
function startServer(box, { detached = false, cwd = box.repo, env = box.env } = {}) {
    const child = track(spawn(NODE, [SERVER], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached }));
    const replies = [];
    let pending = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
        pending += chunk;
        for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
            replies.push(JSON.parse(pending.slice(0, at)));
            pending = pending.slice(at + 1);
        }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    let nextId = 0;
    const send = (message) => child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    const replyTo = async (id) => {
        await until(() => replies.some((r) => r.id === id), 20_000);
        return replies.find((r) => r.id === id);
    };
    const request = (method, params) => {
        const id = ++nextId;
        send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
        return replyTo(id);
    };
    const call = async (name, args, meta) => {
        const reply = await request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
        assert.ok(reply.result, `tools/call ${name} gave ${JSON.stringify(reply)}`);
        return reply.result;
    };
    const close = () => { child.stdin.end(); return exited; };
    return { child, replies, send, request, call, close, exited, stderr: () => stderr };
}

const jobsFolder = (box) => join(box.home, "mcp-jobs");
const jobFilesOf = (box) => { try { return readdirSync(jobsFolder(box)); } catch { return []; } };

/** Starts a job, registers its runner's process group for cleanup, and gives its id. */
async function runJob(server, box, args) {
    const started = await server.call("queue_run", { cwd: box.repo, ...args });
    assert.equal(started.isError, false, started.content[0].text);
    const id = started.structuredContent.jobId;
    const pidFile = jobFiles(jobsFolder(box), id).pid;
    await until(() => existsSync(pidFile));
    track(JSON.parse(readFileSync(pidFile, "utf8")).runnerPid, { group: true });
    return id;
}

async function jobUntil(server, id, wanted = (info) => info.state === "finished") {
    let last;
    for (const end = Date.now() + JOB_WAIT_MS; Date.now() < end;) {
        last = await server.call("queue_job", { jobId: id });
        if (wanted(last.structuredContent)) return last;
        await pause(100);
    }
    throw new Error(`job ${id} did not reach the expected state: ${JSON.stringify(last?.structuredContent)}`);
}

const nodeCommand = (script) => [NODE, "-e", script];
const untilFile = (file) => `const fs = require("node:fs"); `
    + `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(file)})) { clearInterval(t); console.log("done"); } }, 20);`;

// ---- the protocol ----

test("handshake: initialize answers with the client's version or the newest it serves, and notifications get no reply", async () => {
    const box = sandbox();
    const server = startServer(box);
    const init = await server.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-11-25");
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.result.serverInfo.name, "dotime-mcp");
    assert.equal(init.result.resultType, undefined);
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const ping = await server.request("ping");
    assert.deepEqual(ping.result, {});
    assert.deepEqual(server.replies.map((r) => r.id), [1, 2], "the notification was not answered");
    assert.equal((await server.request("initialize", { protocolVersion: "2025-06-18" })).result.protocolVersion, "2025-06-18");
    assert.equal((await server.request("initialize", { protocolVersion: "2099-01-01" })).result.protocolVersion, "2025-11-25");
    assert.equal((await server.request("initialize", {})).error.code, -32602);
    const list = await server.request("tools/list");
    assert.equal(list.result.tools.length, 5);
    assert.equal((await server.close()).code, 0);
});

test("no handshake: a request that names its version in _meta is served statelessly, and one without a version too", async () => {
    const box = sandbox();
    const server = startServer(box);
    const plain = await server.request("tools/list");
    assert.equal(plain.result.tools.length, 5);
    assert.equal(plain.result.resultType, undefined);
    const discover = await server.request("server/discover", { _meta: MODERN_META });
    assert.deepEqual(discover.result.supportedVersions, ["2026-07-28", "2025-11-25"]);
    assert.equal(discover.result.resultType, "complete");
    assert.deepEqual(discover.result.capabilities, { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } });
    assert.equal(discover.result["_meta"]["io.modelcontextprotocol/serverInfo"].name, "dotime-mcp");
    assert.equal(typeof discover.result.ttlMs, "number");
    const modern = await server.request("tools/list", { _meta: MODERN_META });
    assert.equal(modern.result.resultType, "complete");
    assert.equal(modern.result.cacheScope, "public");
    assert.equal(modern.result.tools.length, 5);
    const status = await server.call("queue_status", {}, MODERN_META);
    assert.equal(status.resultType, "complete");
    assert.equal(status.isError, false);
    const older = await server.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } });
    assert.equal(older.result.resultType, undefined);
    const wrong = await server.request("tools/list", { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
    assert.deepEqual(wrong.error, {
        code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28", "2025-11-25"], requested: "1900-01-01" },
    });
    assert.equal((await server.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": 7 } })).error.code, -32022);
    const noCapabilities = await server.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
    assert.equal(noCapabilities.error.code, -32602);
    assert.match(noCapabilities.error.message, /clientCapabilities/);
    await server.close();
});

test("tools/list: the five tools in a fixed order, each with a strict object schema", async () => {
    const box = sandbox();
    const server = startServer(box);
    const { tools } = (await server.request("tools/list")).result;
    assert.deepEqual(tools.map((t) => t.name), ["queue_status", "queue_passed", "queue_history", "queue_run", "queue_job"]);
    for (const tool of tools) {
        assert.equal(tool.inputSchema.type, "object", tool.name);
        assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
        assert.equal(typeof tool.description, "string", tool.name);
        assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    assert.deepEqual(byName.queue_run.required, ["label", "command"]);
    assert.deepEqual(byName.queue_run.properties.command.items, { type: "string", maxLength: 32768 });
    assert.deepEqual(byName.queue_run.properties.kind.enum, ["test", "lint", "build", "deploy", "debug", "other"]);
    assert.deepEqual(Object.keys(byName.queue_run.properties), ["label", "command", "cwd", "kind", "maxRunMin", "noSkip", "afterFix"]);
    assert.deepEqual(byName.queue_passed.required, ["match"]);
    assert.deepEqual(byName.queue_job.required, ["jobId"]);
    const { description, ...days } = byName.queue_history.properties.days;
    assert.deepEqual(days, { type: "integer", minimum: 1, maximum: 365 });
    assert.equal(typeof description, "string");
    assert.equal(tools.find((t) => t.name === "queue_run").annotations.readOnlyHint, false);
    await server.close();
});

test("malformed input: every bad line gets a JSON-RPC error or nothing, and the server keeps serving", async () => {
    const box = sandbox();
    const server = startServer(box);
    const lines = [
        "not json",
        "[]",
        '[{"jsonrpc":"2.0","id":90,"method":"ping"}]',
        '"just text"',
        '{"jsonrpc":"1.0","id":1,"method":"ping"}',
        '{"jsonrpc":"2.0","id":{},"method":"ping"}',
        '{"jsonrpc":"2.0","id":null,"method":"ping"}',
        '{"jsonrpc":"2.0","id":2}',
        '{"jsonrpc":"2.0","id":3,"method":"no/such/method"}',
        '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"no_such_tool"}}',
        '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":[1]}',
        '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"queue_status","arguments":[]}}',
        '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":42}}',
        "",
        "   ",
        '{"jsonrpc":"2.0","id":8,"result":{}}',
        '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":3}}',
        '{"jsonrpc":"2.0","method":"no/such/notification"}',
        `{"jsonrpc":"2.0","id":9,"method":"ping","params":{"pad":"${"x".repeat(1100 * 1024)}"}}`,
        "ÿþ{",
        '{"jsonrpc":"2.0","id":10,"method":"constructor"}',
        '{"jsonrpc":"2.0","id":11,"method":"ping"}',
    ];
    for (const line of lines) server.send(line);
    await until(() => server.replies.some((r) => r.id === 11), 20_000);
    assert.deepEqual(server.replies.map((r) => [r.id, r.error?.code ?? "ok"]), [
        [null, -32700], [null, -32600], [null, -32600], [null, -32600], [1, -32600], [null, -32600], [null, -32600],
        [2, -32600], [3, -32601], [4, -32602], [5, -32602], [6, -32602], [7, -32602], [null, -32700], [null, -32700],
        [10, -32601], [11, "ok"],
    ]);
    assert.match(server.replies[9].error.message, /^Unknown tool: no_such_tool$/);
    assert.match(server.replies[13].error.message, /longer than/);
    assert.equal(server.child.exitCode, null, "the server is still running");
    assert.equal((await server.close()).code, 0);
});

test("lineReader: lines split across chunks are joined, and a line over the limit is dropped once", () => {
    const seen = [];
    let tooLong = 0;
    const reader = lineReader((line) => seen.push(line), () => { tooLong++; }, 10);
    reader.push(Buffer.from("ab"));
    reader.push(Buffer.from("c\nde"));
    reader.push(Buffer.from("f\n0123456789"));
    reader.push(Buffer.from("abcdef"));
    reader.push(Buffer.from("more\nok\nlast"));
    reader.end();
    assert.deepEqual(seen, ["abc", "def", "ok", "last"]);
    assert.equal(tooLong, 1);
    const exact = [];
    let over = 0;
    const bounded = lineReader((line) => exact.push(line), () => { over++; }, 10);
    bounded.push(Buffer.from("0123456789\n01234567890\n01234"));
    bounded.push(Buffer.from("567890\nfits\n"));
    assert.deepEqual(exact, ["0123456789", "fits"]);
    assert.equal(over, 2);
});

// ---- the tools ----

test("queue_status: the status lines, with the counts as fields", async () => {
    const box = sandbox();
    const server = startServer(box);
    const status = await server.call("queue_status", {});
    assert.equal(status.isError, false);
    assert.equal(status.content[0].text, "slots: 0 of 2 taken, 0 waiting\ngate: open");
    assert.deepEqual(status.structuredContent, {
        slots: 2, taken: 0, waiting: 0, gateOpen: true, gate: null, running: [], line: [], lines: ["slots: 0 of 2 taken, 0 waiting", "gate: open"],
    });
    await server.close();
});

test("queue_run: a check runs, the same check on the same commit is skipped, and queue_passed and queue_history see both", async () => {
    const box = sandbox();
    const server = startServer(box);
    const none = await server.call("queue_passed", { match: "unit tests", cwd: box.repo });
    assert.equal(none.structuredContent.stamp, false);
    assert.match(none.content[0].text, /^no stamp: no finished run on record/);
    const args = { label: "shop: unit tests", command: nodeCommand("console.log('all green')") };
    const first = await runJob(server, box, args);
    const ran = (await jobUntil(server, first)).structuredContent;
    assert.equal(ran.exitCode, 0);
    assert.equal(ran.outcome, "ran");
    assert.equal(ran.ok, true);
    assert.equal(ran.tail, "all green");
    const passed = await server.call("queue_passed", { match: "unit tests", cwd: box.repo });
    assert.equal(passed.structuredContent.stamp, true);
    assert.match(passed.content[0].text, /^stamp: commit [0-9a-f]{8}, passed 0 min ago by "shop: unit tests"/);
    const second = await runJob(server, box, args);
    const skipped = await jobUntil(server, second);
    assert.equal(skipped.structuredContent.outcome, "skipped");
    assert.equal(skipped.structuredContent.exitCode, 0);
    assert.equal(skipped.structuredContent.ok, true);
    assert.equal(skipped.structuredContent.stamp.head, passed.structuredContent.head);
    assert.match(skipped.content[0].text, /finished, exit 0, outcome skipped\nlast 1 lines of output:\ndotime-queue: skipped: "shop: unit tests"/);
    const third = await runJob(server, box, { ...args, noSkip: true });
    assert.equal((await jobUntil(server, third)).structuredContent.outcome, "ran");
    const history = await server.call("queue_history", { days: 1 });
    assert.match(history.content[0].text, /jobs 3$/m);
    assert.match(history.content[0].text, /^shop: jobs 3, failed 0, .*skipped 1/m);
    assert.equal(history.structuredContent.jobs, 3);
    const outside = await server.call("queue_passed", { match: "unit", cwd: tempDir("mcp-plain") });
    assert.equal(outside.content[0].text, "no stamp: this folder is not a git checkout");
    await server.close();
});

test("queue_run: a failing command finishes with its own exit code, outcome ran, and its output", async () => {
    const box = sandbox();
    const server = startServer(box);
    const id = await runJob(server, box, { label: "shop: lint", command: nodeCommand("console.error('two problems'); process.exit(1)") });
    const failed = await jobUntil(server, id);
    assert.equal(failed.structuredContent.exitCode, 1);
    assert.equal(failed.structuredContent.outcome, "ran");
    assert.equal(failed.structuredContent.ok, false);
    assert.equal(failed.structuredContent.flaky, null);
    assert.match(failed.content[0].text, /^job [0-9a-f]{24} "shop: lint": finished, exit 1, outcome ran\nlast 1 lines of output:\ntwo problems$/);
    const short = await server.call("queue_job", { jobId: id, tailLines: 0 });
    assert.equal(short.content[0].text.includes("two problems"), false);
    await server.close();
});

test("queue_job: a check that passed and then failed on the same clean commit is flaky; its pass is not", async () => {
    const box = sandbox();
    const server = startServer(box);
    const runs = join(tempDir("mcp-flaky"), "runs");
    const script = `const fs = require("node:fs"); const seen = fs.existsSync(${JSON.stringify(runs)}); `
        + `fs.writeFileSync(${JSON.stringify(runs)}, "x"); process.exit(seen ? 1 : 0)`;
    const args = { label: "shop: unit tests", command: nodeCommand(script), noSkip: true };
    const passed = (await jobUntil(server, await runJob(server, box, args))).structuredContent;
    assert.deepEqual([passed.exitCode, passed.flaky], [0, null]);
    const failed = await jobUntil(server, await runJob(server, box, args));
    const note = "flaky: this check passed and failed on the same commit once in 14 days, last 0 min ago; "
        + "the failure may not come from your change";
    assert.equal(failed.structuredContent.exitCode, 1);
    assert.deepEqual(failed.structuredContent.flaky, {
        mixedCommits: 1, passes: 1, fails: 1, lastEndedAt: failed.structuredContent.flaky.lastEndedAt, note,
    });
    assert.match(failed.structuredContent.flaky.lastEndedAt, /^\d{4}-\d\d-\d\dT/);
    assert.match(failed.content[0].text, new RegExp(`^job [0-9a-f]{24} "shop: unit tests": finished, exit 1, outcome ran; ${note}\n`));
    await server.close();
});

test("queue_run: words that look like flags or shell code reach the command as they are", async () => {
    const box = sandbox();
    const server = startServer(box);
    const words = ["--label", "$(touch hacked)", "a b; rm -rf x", "*", "--"];
    const script = "console.log(JSON.stringify(process.argv.slice(1)))";
    const id = await runJob(server, box, { label: "--odd: build words", command: [NODE, "-e", script, "--", ...words], kind: "build", maxRunMin: 5 });
    const done = await jobUntil(server, id);
    assert.equal(done.structuredContent.exitCode, 0);
    assert.deepEqual(JSON.parse(done.structuredContent.tail), words);
    assert.equal(existsSync(join(box.repo, "hacked")), false);
    await server.close();
});

test("queue_run: a job waits while the slots are full, and Ctrl-C of the server leaves the jobs running and nothing else", async () => {
    const box = sandbox({ slots: 1 });
    const server = startServer(box, { detached: true });
    const flag = join(tempDir("mcp-flag"), "go");
    const holder = await runJob(server, box, { label: "shop: build site", command: nodeCommand(untilFile(flag)) });
    await jobUntil(server, holder, (info) => info.state === "running");
    const waiter = await runJob(server, box, { label: "shop: build docs", command: nodeCommand("console.log('docs')") });
    const waiting = await jobUntil(server, waiter, (info) => info.state === "waiting");
    assert.equal(waiting.structuredContent.position, 1);
    assert.match(waiting.content[0].text, /: waiting, position 1 in line$/m);
    const status = await server.call("queue_status", {});
    assert.equal(status.structuredContent.taken, 1);
    assert.equal(status.structuredContent.waiting, 1);
    const runners = [holder, waiter].map((id) => JSON.parse(readFileSync(jobFiles(jobsFolder(box), id).pid, "utf8")).runnerPid);
    // As Ctrl-C in a terminal does: INT to the server's whole process group.
    process.kill(-server.child.pid, "SIGINT");
    const end = await server.exited;
    assert.equal(end.code, 130);
    await pause(300);
    const group = spawnSync("ps", ["-A", "-o", "pgid="], { encoding: "utf8" }).stdout.split("\n").map(Number);
    assert.equal(group.includes(server.child.pid), false, "a process of the server's group is left");
    for (const pid of runners) assert.equal(alive(pid), true, `runner ${pid} is still running`);
    writeFileSync(flag, "");
    const later = startServer(box);
    for (const id of [holder, waiter]) {
        const done = await jobUntil(later, id);
        assert.equal(done.structuredContent.exitCode, 0);
        assert.equal(done.structuredContent.outcome, "ran");
    }
    await later.close();
});

test("argument checks: every bad argument is a tool error that says what is wrong, and nothing is started", async () => {
    const box = sandbox();
    const server = startServer(box);
    const file = join(box.repo, "notes.txt");
    const run = { label: "shop: unit tests", command: ["npm", "test"] };
    const cases = [
        ["queue_run", { ...run, command: "npm test" }, /command must be an array of strings/],
        ["queue_run", { ...run, command: [] }, /command must have at least 1 item/],
        ["queue_run", { ...run, command: ["npm", 3] }, /command\[1\]: item must be a string/],
        ["queue_run", { ...run, command: [" ", "test"] }, /command\[0\] must name the program/],
        ["queue_run", { ...run, command: ["npm", "a\u0000b"] }, /command\[1\] must not contain a NUL/],
        ["queue_run", { command: ["npm", "test"] }, /label is required/],
        ["queue_run", { ...run, label: "no colon here" }, /label must look like "<project>: <task>"/],
        ["queue_run", { ...run, label: `${"p".repeat(41)}: tests` }, /at most 40 characters before the colon/],
        ["queue_run", { ...run, label: "shop: tests\nmore" }, /control characters/],
        ["queue_run", { ...run, shell: true }, /unknown argument "shell"/],
        ["queue_run", { ...run, cwd: "shop" }, /cwd must be an absolute path/],
        ["queue_run", { ...run, cwd: join(box.repo, "missing") }, /cwd does not exist/],
        ["queue_run", { ...run, cwd: file }, /cwd is not a folder/],
        ["queue_run", { ...run, kind: "fast" }, /kind must be one of test, lint, build, deploy, debug, other/],
        ["queue_run", { ...run, maxRunMin: 0 }, /maxRunMin must be above 0/],
        ["queue_run", { ...run, maxRunMin: "5" }, /maxRunMin must be a number/],
        ["queue_run", { ...run, noSkip: "yes" }, /noSkip must be a boolean/],
        ["queue_run", { ...run, afterFix: "" }, /afterFix must not be empty/],
        ["queue_run", { ...run, afterFix: "fixed\nit" }, /afterFix must be one line/],
        ["queue_passed", {}, /match is required/],
        ["queue_passed", { match: "x", cwd: "/no/such/folder/here" }, /cwd does not exist/],
        ["queue_history", { days: 0 }, /days must be at least 1/],
        ["queue_history", { days: 1.5 }, /days must be a whole number/],
        ["queue_history", { days: "7" }, /days must be a whole number/],
        ["queue_job", {}, /jobId is required/],
        ["queue_job", { jobId: "../../journal" }, /is not a job id/],
        ["queue_job", { jobId: "0".repeat(24), tailLines: -1 }, /tailLines must be at least 0/],
        ["queue_status", { verbose: true }, /unknown argument "verbose"/],
    ];
    for (const [name, args, message] of cases) {
        const out = await server.call(name, args);
        assert.equal(out.isError, true, `${name} ${JSON.stringify(args)}`);
        assert.match(out.content[0].text, new RegExp(`^invalid arguments for ${name}: `));
        assert.match(out.content[0].text, message, `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(jobFilesOf(box), []);
    await server.close();
});

test("queue_job: two identical jobs started together each get their own journal line", async () => {
    const box = sandbox();
    const server = startServer(box);
    const command = nodeCommand("setTimeout(() => console.log('built'), 3000)");
    const label = "shop: build pages";
    // Both requests go out before either reply is read; the first one is stopped by its run limit.
    const replies = [
        server.call("queue_run", { label, command, cwd: box.repo, maxRunMin: 0.02 }),
        server.call("queue_run", { label, command, cwd: box.repo }),
    ];
    const [limited, free] = (await Promise.all(replies)).map((r) => r.structuredContent.jobId);
    const [stopped, ran] = [await jobUntil(server, limited), await jobUntil(server, free)];
    assert.deepEqual([stopped.structuredContent.exitCode, stopped.structuredContent.outcome, stopped.structuredContent.ok], [124, "timed-out", false]);
    assert.deepEqual([ran.structuredContent.exitCode, ran.structuredContent.outcome, ran.structuredContent.ok], [0, "ran", true]);
    const pids = [limited, free].map((id) => JSON.parse(readFileSync(jobFiles(jobsFolder(box), id).pid, "utf8")).queuePid);
    const lines = readFileSync(join(box.home, "journal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.pid).sort(), [...pids].sort());
    await server.close();
});

test("queue_job: a finished job with no journal line of its own has no outcome, even beside an identical one", async () => {
    const box = sandbox();
    const server = startServer(box);
    const args = { label: "shop: build pages", command: nodeCommand("console.log('built')") };
    const done = await jobUntil(server, await runJob(server, box, args));
    assert.equal(done.structuredContent.outcome, "ran");
    const id = "cd".repeat(12);
    const files = createJob(jobsFolder(box), id, { v: 1, id, ...args, cwd: box.repo, createdAt: Date.now() - 5000 });
    writeFileSync(files.pid, JSON.stringify({ runnerPid: 1, runnerStartedAt: 0, queuePid: 999_999, startedAt: Date.now() - 5000 }));
    writeFileSync(files.exit, JSON.stringify({ exit: 0, signal: null, endedAt: Date.now() }));
    const orphan = await server.call("queue_job", { jobId: id });
    assert.equal(orphan.structuredContent.outcome, null);
    assert.equal(orphan.structuredContent.ok, false);
    assert.match(orphan.content[0].text, /outcome unknown \(no journal line found\)/);
    await server.close();
});

test("queue_run: a relative DOTIME_HOME is made absolute where the server starts, so the job uses the same state folder", async () => {
    const box = sandbox();
    const env = { ...box.env, DOTIME_HOME: basename(box.home) };
    const server = startServer(box, { cwd: dirname(box.home), env });
    const id = await runJob(server, box, { label: "shop: build pages", command: nodeCommand("console.log('built')") });
    const done = await jobUntil(server, id);
    assert.deepEqual([done.structuredContent.exitCode, done.structuredContent.outcome], [0, "ran"]);
    assert.equal(existsSync(join(box.home, "journal.jsonl")), true);
    assert.equal(existsSync(join(box.repo, basename(box.home))), false, "no second state folder inside the job's folder");
    await server.close();
});

test("queue_run: past mcpMaxJobs jobs that still wait or run, a further one is refused until one has finished", async () => {
    const box = sandbox({ mcpMaxJobs: 1 });
    const server = startServer(box);
    const flag = join(tempDir("mcp-flag"), "go");
    const first = await runJob(server, box, { label: "shop: build site", command: nodeCommand(untilFile(flag)) });
    const filesBefore = jobFilesOf(box).length;
    const refused = await server.call("queue_run", { label: "shop: build docs", command: nodeCommand("1"), cwd: box.repo });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^queue_run refused: 1 jobs started here are still waiting or running, and mcpMaxJobs in config\.json allows 1;/);
    assert.equal(jobFilesOf(box).length, filesBefore, "nothing was started");
    writeFileSync(flag, "");
    await jobUntil(server, first);
    const later = await runJob(server, box, { label: "shop: build docs", command: nodeCommand("1") });
    assert.equal((await jobUntil(server, later)).structuredContent.exitCode, 0);
    await server.close();
});

test("queue_job: an unknown id is a tool error, and a job whose runner ended without a result is lost", async () => {
    const box = sandbox();
    const server = startServer(box);
    const unknown = await server.call("queue_job", { jobId: "0".repeat(24) });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown job 0{24}: it was never started here or was pruned after 7 days/);
    const gone = spawnSync(NODE, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    const id = "ab".repeat(12);
    const files = createJob(jobsFolder(box), id, { v: 1, id, label: "shop: lost", command: ["true"], cwd: box.repo, createdAt: Date.now() });
    writeFileSync(files.pid, JSON.stringify({ runnerPid: Number(gone.stdout), runnerStartedAt: Date.now() - 1000, queuePid: 1, startedAt: Date.now() }));
    writeFileSync(files.log, "dotime-queue: in line\n");
    const lost = await server.call("queue_job", { jobId: id });
    assert.equal(lost.isError, false);
    assert.equal(lost.structuredContent.state, "lost");
    assert.match(lost.content[0].text, /lost; its runner ended without a result/);
    await server.close();
});

// ---- tasks ----

/** Starts queue_run as a task and gives the CreateTaskResult, with the runner's group registered for cleanup. */
async function startTask(server, box, args) {
    const created = await server.call("queue_run", { cwd: box.repo, ...args }, TASKS_META);
    assert.equal(created.resultType, "task", JSON.stringify(created));
    const pidFile = jobFiles(jobsFolder(box), created.taskId).pid;
    await until(() => existsSync(pidFile));
    track(JSON.parse(readFileSync(pidFile, "utf8")).runnerPid, { group: true });
    return created;
}

async function taskUntil(server, taskId, wanted = (task) => task.status !== "working") {
    let last;
    for (const end = Date.now() + JOB_WAIT_MS; Date.now() < end;) {
        last = await server.request("tasks/get", { taskId, _meta: MODERN_META });
        assert.ok(last.result, JSON.stringify(last));
        if (wanted(last.result)) return last.result;
        await pause(100);
    }
    throw new Error(`task ${taskId} did not reach the expected state: ${JSON.stringify(last?.result)}`);
}

test("tasks: queue_run with the tasks extension answers with a task, and tasks/get gives the result once it passed", async () => {
    const box = sandbox();
    const server = startServer(box);
    const flag = join(tempDir("mcp-flag"), "go");
    const created = await startTask(server, box, { label: "shop: unit tests", command: nodeCommand(untilFile(flag)) });
    assert.match(created.taskId, /^[0-9a-f]{24}$/);
    assert.deepEqual(
        [created.status, created.statusMessage, created.ttlMs, created.pollIntervalMs, created.content],
        ["working", "starting", null, 5000, undefined],
    );
    for (const at of [created.createdAt, created.lastUpdatedAt]) assert.match(at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(created["_meta"]["io.modelcontextprotocol/serverInfo"].name, "dotime-mcp");
    const running = await taskUntil(server, created.taskId, (task) => task.statusMessage.startsWith("running"));
    assert.deepEqual([running.resultType, running.status, running.statusMessage], ["complete", "working", "running for 0 min"]);
    writeFileSync(flag, "");
    const done = await taskUntil(server, created.taskId);
    assert.deepEqual([done.status, done.result.isError, done.result.structuredContent.outcome], ["completed", false, "ran"]);
    assert.equal(done.statusMessage, "finished, exit 0, outcome ran");
    assert.equal(done.result.structuredContent.tail, "done");
    const job = await server.call("queue_job", { jobId: created.taskId });
    assert.deepEqual(done.result.content, job.content);
    assert.equal(done.lastUpdatedAt, job.structuredContent.endedAt);
    await server.close();
});

test("tasks: a failed command is completed with isError, and a lost job is failed", async () => {
    const box = sandbox();
    const server = startServer(box);
    const created = await startTask(server, box, { label: "shop: lint", command: nodeCommand("process.exit(1)") });
    const done = await taskUntil(server, created.taskId);
    assert.deepEqual([done.status, done.result.isError, done.result.structuredContent.exitCode], ["completed", true, 1]);
    assert.equal(done.statusMessage, "finished, exit 1, outcome ran");
    const gone = spawnSync(NODE, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    const id = "cd".repeat(12);
    const files = createJob(jobsFolder(box), id, { v: 1, id, label: "shop: lost", command: ["true"], cwd: box.repo, createdAt: Date.now() });
    writeFileSync(files.pid, JSON.stringify({ runnerPid: Number(gone.stdout), runnerStartedAt: Date.now() - 1000, queuePid: 1, startedAt: Date.now() }));
    const lost = (await server.request("tasks/get", { taskId: id, _meta: MODERN_META })).result;
    assert.equal(lost.status, "failed");
    assert.deepEqual(lost.error, { code: -32603, message: "the job's runner ended without a result; queue_job shows its output" });
    assert.equal(lost.result, undefined);
    assert.equal((await server.request("tasks/cancel", { taskId: id, _meta: MODERN_META })).result.resultType, "complete");
    await server.close();
});

test("tasks: tasks/cancel takes a waiting job out of the line and stops a running one", async () => {
    const box = sandbox({ slots: 1 });
    const server = startServer(box);
    const holder = await startTask(server, box, { label: "shop: build site", command: nodeCommand("setInterval(() => {}, 1000)") });
    await taskUntil(server, holder.taskId, (task) => task.statusMessage.startsWith("running"));
    const waiter = await startTask(server, box, { label: "shop: build docs", command: nodeCommand("console.log('docs')") });
    const waiting = await taskUntil(server, waiter.taskId, (task) => task.statusMessage.startsWith("waiting"));
    assert.equal(waiting.statusMessage, "waiting for a slot, position 1");
    for (const task of [waiter, holder]) {
        const cancel = await server.request("tasks/cancel", { taskId: task.taskId, _meta: MODERN_META });
        assert.deepEqual(Object.keys(cancel.result).sort(), ["_meta", "resultType"]);
        assert.equal(cancel.result.resultType, "complete");
    }
    const left = await taskUntil(server, waiter.taskId);
    assert.deepEqual([left.status, left.result.isError, left.result.structuredContent.outcome], ["completed", true, "left"]);
    const stopped = await taskUntil(server, holder.taskId);
    assert.deepEqual([stopped.status, stopped.result.isError, stopped.result.structuredContent.outcome], ["completed", true, "stopped"]);
    const again = await server.request("tasks/cancel", { taskId: holder.taskId, _meta: MODERN_META });
    assert.equal(again.result.resultType, "complete");
    await server.close();
});

test("tasks: an unknown task and tasks/update are errors, other tools and plain clients never get a task", async () => {
    const box = sandbox();
    const server = startServer(box);
    for (const method of ["tasks/get", "tasks/cancel"]) {
        for (const taskId of ["0".repeat(24), "not a job", undefined]) {
            const reply = await server.request(method, { ...(taskId === undefined ? {} : { taskId }), _meta: MODERN_META });
            assert.equal(reply.error.code, -32602, `${method} ${taskId}`);
            assert.match(reply.error.message, /unknown task/);
        }
    }
    const update = await server.request("tasks/update", { taskId: "0".repeat(24), inputResponses: {}, _meta: MODERN_META });
    assert.equal(update.error.code, -32602);
    const status = await server.call("queue_status", {}, TASKS_META);
    assert.deepEqual([status.resultType, status.isError], ["complete", false]);
    const refused = await server.call("queue_run", { label: "no colon", command: ["true"] }, TASKS_META);
    assert.deepEqual([refused.resultType, refused.isError], ["complete", true]);
    const args = { cwd: box.repo, label: "shop: build", command: nodeCommand("console.log('built')") };
    const modern = await server.call("queue_run", args, MODERN_META);
    assert.equal(modern.resultType, "complete");
    assert.deepEqual(Object.keys(modern.structuredContent), ["jobId", "state", "label", "command", "cwd"]);
    // A client that opened with initialize: today's answer, and no tasks methods at all.
    await server.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const plain = await server.call("queue_run", args, {
        "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } },
    });
    assert.equal(plain.resultType, undefined);
    assert.match(plain.content[0].text, /^started job [0-9a-f]{24}: "shop: build"/);
    const older = { ...TASKS_META, "io.modelcontextprotocol/protocolVersion": "2025-11-25" };
    assert.equal((await server.call("queue_run", args, older)).resultType, undefined);
    for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) {
        assert.equal((await server.request(method, { taskId: plain.structuredContent.jobId })).error.code, -32601, method);
        assert.equal((await server.request(method, { taskId: plain.structuredContent.jobId, _meta: older })).error.code, -32601, method);
    }
    for (const id of [modern.structuredContent.jobId, plain.structuredContent.jobId]) await jobUntil(server, id);
    await server.close();
});

// ---- the job files ----

test("queueArgs: every value is joined to its flag, and the command follows --", () => {
    const args = queueArgs({ label: "--x: y", command: ["npm", "--", "test"], kind: "test", maxRunMin: 2.5, noSkip: true, afterFix: "--fixed" });
    assert.deepEqual(args, ["run", "--label=--x: y", "--kind=test", "--max-run=2.5", "--no-skip", "--after-fix=--fixed", "--", "npm", "--", "test"]);
    assert.deepEqual(queueArgs({ label: "a: b", command: ["make"] }), ["run", "--label=a: b", "--", "make"]);
});

test("argumentProblems: names every problem at once", () => {
    const schema = TOOLS.find((t) => t.name === "queue_run").inputSchema;
    assert.deepEqual(argumentProblems({ extra: 1, label: 5 }, schema), [
        'unknown argument "extra"', "command is required", "label must be a string",
    ]);
});

test("pruneJobs: old finished jobs go, an active one stays, and the newest are kept up to the limit", () => {
    const dir = join(tempDir("mcp-prune"), "mcp-jobs");
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const make = (id, createdAt, { exit = true, pid = null } = {}) => {
        const files = createJob(dir, id, { id, createdAt });
        writeFileSync(files.log, "output\n");
        if (exit) writeFileSync(files.exit, JSON.stringify({ exit: 0, endedAt: createdAt }));
        if (pid) writeFileSync(files.pid, JSON.stringify(pid));
        return files;
    };
    make("a".repeat(24), now - 8 * day);
    make("b".repeat(24), now - 8 * day, { exit: false, pid: { runnerPid: process.pid, runnerStartedAt: now } });
    make("c".repeat(24), now - 2 * day);
    make("d".repeat(24), now - day);
    make("e".repeat(24), now - 1000);
    writeFileSync(join(dir, "unrelated.txt"), "kept");
    const removed = pruneJobs(dir, { now, keepJobs: 2, check: (pid) => pid === process.pid });
    assert.deepEqual(removed.sort(), ["a".repeat(24), "c".repeat(24)]);
    assert.deepEqual(readdirSync(dir).sort(), [
        ..."bde".split("").flatMap((c) => [`${c.repeat(24)}.json`, `${c.repeat(24)}.log`, ...(c === "b" ? [`${c.repeat(24)}.pid`] : [`${c.repeat(24)}.exit`])]),
        "unrelated.txt",
    ].sort());
    assert.throws(() => jobFiles(dir, "../x"), /not a job id/);
});

test("tailLines: the last lines only, cut when very long, and never through a symlink or from a FIFO", () => {
    const dir = tempDir("mcp-tail");
    const log = join(dir, "job.log");
    writeFileSync(log, `${Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")}\n${"z".repeat(3000)}\n`);
    const tail = tailLines(log, 3);
    assert.deepEqual(tail.slice(0, 2), ["line 98", "line 99"]);
    assert.equal(tail[2], `${"z".repeat(2000)} [cut]`);
    assert.deepEqual(tailLines(log, 0), []);
    assert.deepEqual(tailLines(join(dir, "missing.log"), 5), []);
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "do not show\n");
    symlinkSync(secret, join(dir, "link.log"));
    assert.deepEqual(tailLines(join(dir, "link.log"), 5), []);
    mkdirSync(join(dir, "folder.log"));
    assert.deepEqual(tailLines(join(dir, "folder.log"), 5), []);
    assert.equal(spawnSync("mkfifo", [join(dir, "pipe.log")]).status, 0);
    assert.deepEqual(tailLines(join(dir, "pipe.log"), 5), [], "a FIFO is refused without waiting for a writer");
});
