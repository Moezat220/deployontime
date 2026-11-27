#!/usr/bin/env node
// Benchmark: several agents start the same test suite at the same moment, once straight away and once through
// dotime-queue. Each agent needs one green run. After a failure it waits a few seconds, as an agent reading the
// failure would, and runs the suite again. The benchmark reports, for each way:
//   - the time until every agent has a green run,
//   - how many suite runs that took,
//   - how many tests failed in the first runs (these failures come only from the busy computer: the code is the same).
//
// It uses a temporary state folder and a temporary git repository, so it never touches ~/.dotime or your projects.
// It is heavy on purpose: it loads every core. Run it on an otherwise quiet computer.
//
// usage: node bench/run.mjs [--repeat 3] [--agents 4] [--threads 5] [--tests 20] [--mem 400] [--tries 8]
//                           [--work 250] [--slack 1.6] [--json results.json]
// --mem is megabytes per thread, --work the CPU work per test, --slack how much slower than alone a test may get.
// --json writes the raw results (settings, machine, every round and agent) to a file after each round, and copies
// each queued round's journal into a journals folder beside it.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../queue/settings.mjs";
import { machine, median, results } from "./report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SUITE = join(here, "suite.mjs");
const CLI = join(here, "..", "queue", "cli.mjs");

const defaults = { repeat: 3, agents: 4, threads: 5, tests: 20, mem: 400, tries: 8, work: 250, slack: 1.6 };
const opts = { ...defaults };
const argv = process.argv.slice(2);
const given = new Set();
let jsonFile = null;
for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, "");
    if (given.has(name)) {
        console.error(`bench: option given twice: ${argv[i]}`);
        process.exit(2);
    }
    given.add(name);
    if (argv[i] === "--json" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
        jsonFile = resolve(argv[i + 1]);
        continue;
    }
    const value = Number(argv[i + 1]);
    const whole = name !== "slack";
    if (!argv[i].startsWith("--") || !Object.hasOwn(defaults, name) || !Number.isFinite(value) || value <= 0 ||
        (whole && !Number.isInteger(value))) {
        console.error(`bench: unknown option or bad value: ${argv[i]} ${argv[i + 1] ?? ""}`);
        process.exit(2);
    }
    opts[name] = value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A small seeded random number generator: in one repeat both ways get the same waits between tries, and each
// repeat gets other waits, so the repeats show how much the result depends on when agents retry.
function seeded(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function runOnce(args, env, cwd) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
        children.add(child);
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err = (err + chunk).slice(-2000)));
        child.on("close", (code) => {
            children.delete(child);
            const line = out.split("\n").find((l) => l.startsWith("{"));
            resolve({ code, result: line ? JSON.parse(line) : null, err });
        });
    });
}

// Through the queue, a retry passes --after-fix: the code here never changes, so without it the queue's
// repeated-failure stop would refuse a third try, and the result would show that refusal instead of the load. Every
// run passes --no-skip: each round repeats a suite that passed in the round before on the same commit, and the queue
// would otherwise skip it.
async function agent(n, way, deadline, env, repo, repeat) {
    const random = seeded(repeat * 104729 + n * 7919);
    const suite = [SUITE, opts.threads, opts.tests, opts.work, deadline, opts.mem].map(String);
    const queued = (run) => [CLI, "run", "--label", `bench: agent ${n}`, "--max-run", "30", "--no-skip",
        ...(run > 1 ? ["--after-fix", "benchmark retry on unchanged code"] : []), "--", process.execPath, ...suite];
    const start = Date.now();
    let firstFailed = null;
    // A try that prints no result (a crash, a refusal, a usage error) is not a suite run: it is counted apart.
    let runs = 0;
    let errors = 0;
    for (let run = 1; run <= opts.tries; run++) {
        const { code, result } = await runOnce(way === "queue" ? queued(run) : suite, env, repo);
        if (result) runs++;
        else errors++;
        if (run === 1) firstFailed = result?.failed ?? null;
        if (code === 0 && result) {
            return { agent: n, runs, errors, seconds: (Date.now() - start) / 1000, green: true, firstFailed };
        }
        if (run < opts.tries) await sleep((5 + random() * 25) * 1000);
    }
    return { agent: n, runs, errors, seconds: (Date.now() - start) / 1000, green: false, firstFailed };
}

async function quiet() {
    const limit = cpus().length * 0.5;
    for (let waited = 0; loadavg()[0] > limit; waited += 5) {
        if (waited >= 300) {
            console.log(`note: the load is still ${loadavg()[0].toFixed(1)} after 5 minutes; going on anyway`);
            return;
        }
        await sleep(5000);
    }
}

// Each round gets a state folder of its own, so no round sees the journal of another.
async function round(way, deadline, repo, repeat) {
    const state = join(home, `state-${repeat}-${way}`);
    mkdirSync(state);
    const env = { ...process.env, DOTIME_HOME: state, DOTIME_NOTIFY: "log" };
    await quiet();
    const start = Date.now();
    const starts = Array.from({ length: opts.agents }, (_, i) => agent(i + 1, way, deadline, env, repo, repeat));
    current = { state, name: `round-${repeat}-${way}-stopped` };
    const agents = await Promise.all(starts);
    const seconds = Math.round((Date.now() - start) / 1000);
    current = null;
    keepJournal(state, `round-${repeat}-${way}`);
    return {
        seconds,
        runs: agents.reduce((sum, a) => sum + a.runs, 0),
        errors: agents.reduce((sum, a) => sum + a.errors, 0),
        firstFailed: agents.reduce((sum, a) => sum + (a.firstFailed ?? 0), 0),
        neverGreen: agents.filter((a) => !a.green).length,
        agents,
    };
}

// With --json, the results so far are written after each round, so a run that is stopped still leaves them. The
// file is written beside its place and then renamed, so a stop in the middle never leaves half a file.
const measured = { deadlineMs: null, aloneMedianMs: null, rounds: [] };
let current = null;
function writeResults(complete, error) {
    if (!jsonFile) return;
    mkdirSync(dirname(jsonFile), { recursive: true });
    const queueSlots = loadSettings({ DOTIME_HOME: home }).slots;
    const data = results({ options: opts, ...measured, queueSlots, machine: machine(join(here, "..")), complete,
        error });
    writeFileSync(`${jsonFile}.tmp`, JSON.stringify(data, null, 2) + "\n");
    renameSync(`${jsonFile}.tmp`, jsonFile);
}

// With --json, each queued round's journal is copied out before the temporary folder is removed.
function keepJournal(state, name) {
    if (!jsonFile || !existsSync(join(state, "journal.jsonl"))) return;
    mkdirSync(join(dirname(jsonFile), "journals"), { recursive: true });
    copyFileSync(join(state, "journal.jsonl"), join(dirname(jsonFile), "journals", `${name}.jsonl`));
}

const home = mkdtempSync(join(tmpdir(), "dotime-bench-"));
const repo = join(home, "repo");
// On a signal, stop the running suites and queue commands and wait for them to end (they may still write their
// journal line), then remove the temporary folder and exit.
const children = new Set();
let stopping = false;
async function stop(exit) {
    if (stopping) return;
    stopping = true;
    const ended = [...children].map((child) => new Promise((resolve) => child.once("close", resolve)));
    for (const child of children) child.kill("SIGTERM");
    const late = setTimeout(() => children.forEach((child) => child.kill("SIGKILL")), 15_000);
    await Promise.all(ended);
    clearTimeout(late);
    if (current) keepJournal(current.state, current.name);
    if (measured.deadlineMs) writeResults(false, `stopped by a signal (exit ${exit})`);
    rmSync(home, { recursive: true, force: true });
    process.exit(exit);
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
async function main() {
    try {
        spawnSync("git", ["init", "-q", repo]);
        writeFileSync(join(repo, "readme.txt"), "bench\n");
        spawnSync("git", ["-C", repo, "add", "."]);
        const author = ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid"];
        spawnSync("git", ["-C", repo, ...author, "commit", "-qm", "bench"]);

        await quiet();
        const alone = await runOnce([SUITE, opts.threads, 6, opts.work, 1e9, opts.mem].map(String), process.env, repo);
        if (!alone.result) {
            console.error(`bench: the suite did not run on its own (exit ${alone.code}); nothing to measure`);
            writeResults(false, `the suite did not run on its own (exit ${alone.code})`);
            if (alone.err.trim()) console.error(alone.err.trim());
            process.exitCode = 1;
            return;
        }
        const deadline = Math.round(alone.result.medianMs * opts.slack);
        Object.assign(measured, { deadlineMs: deadline, aloneMedianMs: alone.result.medianMs });
        console.log(`computer: ${cpus().length} cores · median test with one suite running alone: ` +
            `${alone.result.medianMs} ms · ` +
            `a test fails above ${deadline} ms`);
        console.log(`${opts.agents} agents, each running ${opts.threads * opts.tests} tests ` +
            `(${opts.threads} threads × ${opts.tests}), up to ${opts.tries} tries\n`);

        const rows = { direct: [], queue: [] };
        for (let r = 1; r <= opts.repeat; r++) {
            for (const way of ["direct", "queue"]) {
                const result = await round(way, deadline, repo, r);
                rows[way].push(result);
                measured.rounds.push({ way, repeat: r, ...result });
                writeResults(false, "the run stopped before the last round");
                const end = result.neverGreen
                    ? `${result.neverGreen} of ${opts.agents} agents still not green after ${opts.tries} tries ` +
                      `(${result.seconds} s)`
                    : `all green after ${result.seconds} s`;
                console.log(`run ${r} ${way.padEnd(6)}: ${end}, ${result.runs} suite runs, ` +
                    `${result.firstFailed} of ${opts.agents * opts.threads * opts.tests} tests failed ` +
                    "in the first runs" +
                    (result.errors ? `, ${result.errors} tries ended without a result` : ""));
            }
        }

        console.log("\nmedian of", opts.repeat, "runs (lowest to highest):");
        for (const way of ["direct", "queue"]) {
            const pick = (key) => rows[way].map((row) => row[key]);
            const range = (key) => `${Math.min(...pick(key))} to ${Math.max(...pick(key))}`;
            const stuck = pick("neverGreen").filter((n) => n > 0).length;
            console.log(`${way.padEnd(6)}: time to the end ${median(pick("seconds"))} s (${range("seconds")}), ` +
                `not all green in ${stuck} of ${opts.repeat} runs, ` +
                `suite runs ${median(pick("runs"))} (${range("runs")}), ` +
                `first-run failures ${median(pick("firstFailed"))} (${range("firstFailed")})`);
        }
        writeResults(true);
    } catch (error) {
        writeResults(false, `the benchmark failed: ${error?.message ?? error}`);
        throw error;
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

await main();
