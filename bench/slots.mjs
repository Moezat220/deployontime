#!/usr/bin/env node
// Benchmark: does the queue get faster with more slots, and when does it get slower?
// For each slot count it runs two workloads through dotime-queue, each with all of its agents starting at once:
//   - LIGHT: several agents whose suites use few threads, so together they keep fewer threads busy than the computer
//     has cores. Here waiting for a slot leaves cores idle, and more slots should help.
//   - HEAVY: fewer agents whose suites use many threads, so together they want more threads than there are cores.
//     Here more slots let more suites share the cores at once, and tests may slow down past their limit and fail.
// Each agent needs one green run and retries after a failure, as in run.mjs. Every slot count gets the same waits
// between tries. For each round it reports the time until every agent is green, the suite runs, the tests that
// failed in the first runs and the highest share of the cores that was busy (sampled every second).
//
// Each round uses a state folder of its own. A slot count sets `slots` and `maxSlots` to that number, so the count
// is fixed; the entry `auto` writes an empty config.json, so the queue runs with its defaults: the base slots and
// extra slots while the CPU has room. The health gate keeps its defaults. It is heavy on purpose. Run it on an
// otherwise quiet computer.
//
// usage: node bench/slots.mjs [--repeat 1] [--slots 2,3,4,6] [--light-agents 6] [--light-threads 1]
//                             [--heavy-agents 4] [--heavy-threads 5] [--tests 20] [--mem 400] [--tries 8]
//                             [--work 250] [--slack 1.6]
// --mem is megabytes per thread, --work the CPU work per test, --slack how much slower than alone a test may get.
// --slots also takes `auto` among the counts, for example --slots 2,6,auto; it is not in the list by default.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../queue/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SUITE = join(here, "suite.mjs");
const CLI = join(here, "..", "queue", "cli.mjs");

/** The --slots entry that runs the queue with its default settings, extra slots included. */
export const AUTO = "auto";

/** The config.json of a round: a fixed slot count, or the defaults for AUTO. */
export const roundConfig = (slots) => (slots === AUTO ? {} : { slots, maxSlots: slots });

const defaults = {
    repeat: 1, slots: [2, 3, 4, 6], "light-agents": 6, "light-threads": 1, "heavy-agents": 4, "heavy-threads": 5,
    tests: 20, mem: 400, tries: 8, work: 250, slack: 1.6,
};

/** Reads the options. Returns { opts } or { error }: every option needs a value, none may come twice. */
export function readOptions(argv) {
    const opts = { ...defaults };
    const given = new Set();
    for (let i = 0; i < argv.length; i += 2) {
        const flag = argv[i];
        const raw = argv[i + 1];
        const name = flag.replace(/^--/, "");
        if (!flag.startsWith("--") || !Object.hasOwn(defaults, name)) return { error: `unknown option: ${flag}` };
        if (given.has(name)) return { error: `option given twice: ${flag}` };
        given.add(name);
        if (raw === undefined) return { error: `option needs a value: ${flag}` };
        if (name === "slots") {
            const entry = (part) => (part.trim() === AUTO ? AUTO : /^\d+$/.test(part.trim()) ? Number(part) : NaN);
            const list = raw.split(",").map(entry);
            if (list.some((n) => n !== AUTO && (!Number.isInteger(n) || n < 1))) {
                return { error: `--slots needs whole numbers of 1 or more or "auto", split by commas: ${raw}` };
            }
            if (new Set(list).size !== list.length) return { error: `--slots names a count twice: ${raw}` };
            opts.slots = list;
            continue;
        }
        const value = raw.trim() === "" ? NaN : Number(raw);
        const whole = name !== "slack";
        if (!Number.isFinite(value) || value <= 0 || (whole && !Number.isInteger(value))) {
            return { error: `${flag} needs ${whole ? "a whole number" : "a number"} above 0: ${raw}` };
        }
        opts[name] = value;
    }
    return { opts };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** "12 s" for one value, "12 s (10 to 15)" for several: the median, then the lowest and highest. */
export function summary(values, unit = "") {
    const mid = `${median(values)}${unit}`;
    return values.length > 1 ? `${mid} (${Math.min(...values)} to ${Math.max(...values)})` : mid;
}

/** The share of all cores that was busy between two `os.cpus()` readings, from 0 to 1. */
export function busyShare(before, after) {
    let busy = 0;
    let total = 0;
    after.forEach((cpu, i) => {
        const was = before[i]?.times;
        if (!was) return;
        const spent = (key) => cpu.times[key] - was[key];
        const all = spent("user") + spent("nice") + spent("sys") + spent("idle") + spent("irq");
        busy += all - spent("idle");
        total += all;
    });
    return total > 0 ? busy / total : 0;
}

// A small seeded random number generator, as in run.mjs. The seed leaves out the slot count, so every slot count
// gets the same waits between tries.
function seeded(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set();
let stopping = false;

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

/** The queue run of try `run` of agent n with the given suite words, as in run.mjs: a retry passes --after-fix, and
 *  every run passes --no-skip, because each slot count repeats the suites on the same commit and the queue would
 *  otherwise skip a suite that passed before. --max-wait 0 keeps a long wait for a slot in the measurement instead
 *  of ending it as a give-up. */
export const queuedRun = (load, n, run, suite) => [
    CLI, "run", "--label", `bench: ${load.name.toLowerCase()} agent ${n}`,
    "--max-run", "30", "--max-wait", "0", "--no-skip",
    ...(run > 1 ? ["--after-fix", "benchmark retry on unchanged code"] : []), "--", process.execPath, ...suite];

async function agent(n, load, deadline, env, repo, repeat, opts) {
    const random = seeded(repeat * 104729 + n * 7919 + (load.name === "HEAVY" ? 31 : 0));
    const suite = [SUITE, load.threads, opts.tests, opts.work, deadline, opts.mem].map(String);
    const queued = (run) => queuedRun(load, n, run, suite);
    let firstFailed = null;
    let runs = 0;
    let errors = 0;
    for (let run = 1; run <= opts.tries && !stopping; run++) {
        const { code, result } = await runOnce(queued(run), env, repo);
        if (result) runs++;
        else errors++;
        if (run === 1) firstFailed = result?.failed ?? null;
        if (code === 0 && result) return { runs, errors, green: true, firstFailed };
        if (run < opts.tries) await sleep((5 + random() * 25) * 1000);
    }
    return { runs, errors, green: false, firstFailed };
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

async function round(home, load, slots, deadline, repo, repeat, opts) {
    const state = join(home, `state-${repeat}-${slots}-${load.name.toLowerCase()}`);
    mkdirSync(state);
    writeFileSync(join(state, "config.json"), `${JSON.stringify(roundConfig(slots))}\n`);
    const env = { ...process.env, DOTIME_HOME: state, DOTIME_NOTIFY: "log" };
    await quiet();
    let peak = 0;
    let last = cpus();
    const sampler = setInterval(() => {
        const now = cpus();
        peak = Math.max(peak, busyShare(last, now));
        last = now;
    }, 1000);
    const start = Date.now();
    try {
        const agents = await Promise.all(Array.from({ length: load.agents },
            (_, i) => agent(i + 1, load, deadline, env, repo, repeat, opts)));
        return {
            seconds: Math.round((Date.now() - start) / 1000),
            runs: agents.reduce((sum, a) => sum + a.runs, 0),
            errors: agents.reduce((sum, a) => sum + a.errors, 0),
            firstFailed: agents.reduce((sum, a) => sum + (a.firstFailed ?? 0), 0),
            neverGreen: agents.filter((a) => !a.green).length,
            peakPct: Math.round(peak * 100),
        };
    } finally {
        clearInterval(sampler);
    }
}

async function main(opts) {
    const home = mkdtempSync(join(tmpdir(), "dotime-bench-slots-"));
    const repo = join(home, "repo");
    // On a signal, stop the running suites and queue commands and wait for them to end (they may still write their
    // journal line), then remove the temporary folder and exit.
    async function stop(exit) {
        if (stopping) return;
        stopping = true;
        const ended = [...children].map((child) => new Promise((resolve) => child.once("close", resolve)));
        for (const child of children) child.kill("SIGTERM");
        const late = setTimeout(() => children.forEach((child) => child.kill("SIGKILL")), 15_000);
        await Promise.all(ended);
        clearTimeout(late);
        rmSync(home, { recursive: true, force: true });
        process.exit(exit);
    }
    process.on("SIGINT", () => stop(130));
    process.on("SIGTERM", () => stop(143));
    try {
        spawnSync("git", ["init", "-q", repo]);
        writeFileSync(join(repo, "readme.txt"), "bench\n");
        spawnSync("git", ["-C", repo, "add", "."]);
        const author = ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid"];
        spawnSync("git", ["-C", repo, ...author, "commit", "-qm", "bench"]);

        await quiet();
        const alone = await runOnce([SUITE, 1, 6, opts.work, 1e9, opts.mem].map(String), process.env, repo);
        if (stopping) return;
        if (!alone.result) {
            console.error(`bench: the suite did not run on its own (exit ${alone.code}); nothing to measure`);
            if (alone.err.trim()) console.error(alone.err.trim());
            process.exitCode = 1;
            return;
        }
        const deadline = Math.round(alone.result.medianMs * opts.slack);
        const cores = cpus().length;
        const loads = [
            { name: "LIGHT", agents: opts["light-agents"], threads: opts["light-threads"] },
            { name: "HEAVY", agents: opts["heavy-agents"], threads: opts["heavy-threads"] },
        ];
        console.log(`computer: ${cores} cores · median test with one thread running alone: ` +
            `${alone.result.medianMs} ms · a test fails above ${deadline} ms`);
        for (const load of loads) {
            console.log(`${load.name}: ${load.agents} agents × ${load.threads} threads = ` +
                `${load.agents * load.threads} busy threads, ${opts.tests} tests per thread`);
        }
        console.log(`slot counts ${opts.slots.join(", ")}, up to ${opts.tries} tries, ${opts.repeat} repeats\n`);

        const rows = new Map(opts.slots.map((slots) => [slots, { LIGHT: [], HEAVY: [] }]));
        for (let r = 1; r <= opts.repeat; r++) {
            for (const slots of opts.slots) {
                for (const load of loads) {
                    const result = await round(home, load, slots, deadline, repo, r, opts);
                    rows.get(slots)[load.name].push(result);
                    const end = result.neverGreen
                        ? `${result.neverGreen} of ${load.agents} agents not green after ${opts.tries} tries ` +
                          `(${result.seconds} s)`
                        : `all green after ${result.seconds} s`;
                    console.log(`run ${r} slots ${slots} ${load.name}: ${end}, ${result.runs} suite runs, ` +
                        `${result.firstFailed} of ${load.agents * load.threads * opts.tests} tests failed ` +
                        `in the first runs, peak CPU ${result.peakPct}%` +
                        (result.errors ? `, ${result.errors} tries ended without a result` : ""));
                }
            }
        }

        console.log(`\n${opts.repeat > 1 ? `median of ${opts.repeat} runs (lowest to highest)` : "results"}; ` +
            "failures are tests that failed in the first runs, * marks a run where not every agent got green:");
        const header = ["slots", "LIGHT time", "LIGHT failures", "LIGHT peak CPU",
            "HEAVY time", "HEAVY failures", "HEAVY peak CPU"];
        const table = [header];
        for (const [slots, byLoad] of rows) {
            const cells = [String(slots)];
            for (const load of loads) {
                const list = byLoad[load.name];
                const pick = (key) => list.map((row) => row[key]);
                const stuck = list.some((row) => row.neverGreen) ? " *" : "";
                cells.push(summary(pick("seconds"), " s") + stuck, summary(pick("firstFailed")),
                    summary(pick("peakPct"), "%"));
            }
            table.push(cells);
        }
        const widths = header.map((_, c) => Math.max(...table.map((row) => row[c].length)));
        for (const row of table) console.log(row.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd());
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const read = readOptions(process.argv.slice(2));
    if (read.error) {
        console.error(`bench: ${read.error}`);
        process.exit(EXIT.usage);
    }
    await main(read.opts);
}
