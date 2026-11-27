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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SUITE = join(here, "suite.mjs");
const CLI = join(here, "..", "queue", "cli.mjs");

const defaults = { repeat: 3, agents: 4, threads: 5, tests: 20, mem: 400, tries: 8, work: 250, slack: 1.6 };
const opts = { ...defaults };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, "");
    const value = Number(argv[i + 1]);
    if (!(name in defaults) || !Number.isFinite(value) || value <= 0) {
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
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", () => {});
        child.on("close", (code) => {
            const line = out.split("\n").find((l) => l.startsWith("{"));
            resolve({ code, result: line ? JSON.parse(line) : null });
        });
    });
}

async function agent(n, way, deadline, env, repo, repeat) {
    const random = seeded(repeat * 104729 + n * 7919);
    const suite = [SUITE, opts.threads, opts.tests, opts.work, deadline, opts.mem].map(String);
    const queued = [CLI, "run", "--label", `bench: agent ${n}`, "--max-run", "30", "--", process.execPath, ...suite];
    const args = way === "queue" ? queued : suite;
    const start = Date.now();
    let firstFailed = null;
    for (let run = 1; run <= opts.tries; run++) {
        const { code, result } = await runOnce(args, env, repo);
        if (firstFailed === null) firstFailed = result?.failed ?? null;
        if (code === 0) return { runs: run, seconds: (Date.now() - start) / 1000, green: true, firstFailed };
        await sleep((5 + random() * 25) * 1000);
    }
    return { runs: opts.tries, seconds: (Date.now() - start) / 1000, green: false, firstFailed };
}

async function quiet() {
    const limit = cpus().length * 0.5;
    for (let waited = 0; waited < 300 && loadavg()[0] > limit; waited += 5) await sleep(5000);
}

async function round(way, deadline, env, repo, repeat) {
    await quiet();
    const start = Date.now();
    const starts = Array.from({ length: opts.agents }, (_, i) => agent(i + 1, way, deadline, env, repo, repeat));
    const agents = await Promise.all(starts);
    return {
        seconds: Math.round((Date.now() - start) / 1000),
        runs: agents.reduce((sum, a) => sum + a.runs, 0),
        firstFailed: agents.reduce((sum, a) => sum + (a.firstFailed ?? 0), 0),
        neverGreen: agents.filter((a) => !a.green).length,
    };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const home = mkdtempSync(join(tmpdir(), "dotime-bench-"));
const repo = join(home, "repo");
const env = { ...process.env, DOTIME_HOME: join(home, "state"), DOTIME_NOTIFY: "log" };
try {
    spawnSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "readme.txt"), "bench\n");
    spawnSync("git", ["-C", repo, "add", "."]);
    const author = ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid"];
    spawnSync("git", ["-C", repo, ...author, "commit", "-qm", "bench"]);

    await quiet();
    const alone = await runOnce([SUITE, opts.threads, 6, opts.work, 1e9, opts.mem].map(String), env, repo);
    const deadline = Math.round(alone.result.medianMs * opts.slack);
    console.log(`computer: ${cpus().length} cores · one test alone: ${alone.result.medianMs} ms · ` +
        `a test fails above ${deadline} ms`);
    console.log(`${opts.agents} agents, each running ${opts.threads * opts.tests} tests ` +
        `(${opts.threads} threads × ${opts.tests}), up to ${opts.tries} tries\n`);

    const rows = { direct: [], queue: [] };
    for (let r = 1; r <= opts.repeat; r++) {
        for (const way of ["direct", "queue"]) {
            const result = await round(way, deadline, env, repo, r);
            rows[way].push(result);
            const end = result.neverGreen
                ? `${result.neverGreen} of ${opts.agents} agents still not green after ${opts.tries} tries ` +
                  `(${result.seconds} s)`
                : `all green after ${result.seconds} s`;
            console.log(`run ${r} ${way.padEnd(6)}: ${end}, ${result.runs} suite runs, ` +
                `${result.firstFailed} of ${opts.agents * opts.threads * opts.tests} tests failed in the first runs`);
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
} finally {
    rmSync(home, { recursive: true, force: true });
}
