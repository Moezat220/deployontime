#!/usr/bin/env node
// Helpers for publishing benchmark results: the settings scaled to a computer, the machine description, the raw
// results that bench/run.mjs writes with --json, and a short Markdown summary of them.
//
// usage: node bench/report.mjs settings [--agents 4]   prints threads=, mem=, cores= and ram_mb= lines
//        node bench/report.mjs summary <results.json>    prints a Markdown summary
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

export const SETTINGS_RULE = "threads per suite = max(1, round(2 × cores / agents)), so the agents ask for about " +
    "twice the busy threads the computer has; memory per thread is 400 MB unless agents × threads × 400 MB would be " +
    "more than half the RAM, then it is lowered to fit half the RAM";

// The published run's rule, applied to any computer instead of tuned to one.
export function scaledSettings({ cores, ramMB, agents }) {
    const threads = Math.max(1, Math.round((2 * cores) / agents));
    const half = ramMB / 2;
    const mem = agents * threads * 400 > half ? Math.max(1, Math.floor(half / (agents * threads))) : 400;
    return { threads, mem };
}

export const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export function summarize(rounds, ways = ["direct", "queue"]) {
    const summary = {};
    for (const way of ways) {
        const rows = rounds.filter((row) => row.way === way);
        if (!rows.length) continue;
        const stat = (key) => {
            const values = rows.map((row) => row[key]);
            return { median: median(values), lowest: Math.min(...values), highest: Math.max(...values) };
        };
        summary[way] = {
            rounds: rows.length,
            notAllGreen: rows.filter((row) => row.neverGreen > 0).length,
            seconds: stat("seconds"),
            runs: stat("runs"),
            errors: stat("errors"),
            firstFailed: stat("firstFailed"),
        };
    }
    return summary;
}

function read(command, args, cwd) {
    const out = spawnSync(command, args, { cwd, encoding: "utf8" });
    return out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
}

export function machine(repoDir) {
    const name = read("sw_vers", ["-productName"]);
    const version = read("sw_vers", ["-productVersion"]);
    const build = read("sw_vers", ["-buildVersion"]);
    return {
        chip: read("sysctl", ["-n", "machdep.cpu.brand_string"]),
        model: read("sysctl", ["-n", "hw.model"]),
        cores: cpus().length,
        ramMB: Math.round(totalmem() / 2 ** 20),
        os: [name, version, build && `(${build})`].filter(Boolean).join(" ") || null,
        node: process.version,
        commit: read("git", ["rev-parse", "HEAD"], repoDir),
    };
}

export function results({ options, deadlineMs, aloneMedianMs, machine, rounds, complete, error }) {
    return {
        complete,
        ...(error ? { error } : {}),
        configuration: { ...options, deadlineMs, aloneMedianMs },
        machine,
        rounds,
        summary: summarize(rounds),
    };
}

function timeCell(row, tries) {
    if (!row) return "not run";
    if (!row.neverGreen) return `${row.seconds} s`;
    return `not green after ${tries} tries (${row.neverGreen} agents red, ${row.seconds} s)`;
}

const range = (stat) => (stat ? `${stat.median} (${stat.lowest} to ${stat.highest})` : "not run");

export function markdown(data) {
    const c = data.configuration;
    const m = data.machine;
    const lines = ["## Benchmark results", ""];
    if (!data.complete) lines.push(`**Not complete:** ${data.error ?? "the run stopped before the end"}.`, "");
    lines.push(
        `Machine: ${m.chip ?? m.model ?? "unknown"}${m.model && m.chip ? ` (${m.model})` : ""}, ${m.cores} cores, ` +
            `${m.ramMB} MB RAM, ${m.os ?? "unknown system"}, Node ${m.node}, commit ${m.commit ?? "unknown"}`,
        "",
        `Settings: ${c.agents} agents, ${c.threads} threads × ${c.tests} tests per suite, ${c.mem} MB per thread, ` +
            `${c.tries} tries, ${c.repeat} rounds each way, timeout ${c.slack} × the median test alone ` +
            (c.deadlineMs ? `(${c.aloneMedianMs} ms alone, a test fails above ${c.deadlineMs} ms)` : "(not measured)"),
        "",
    );
    const scaled = scaledSettings({ cores: m.cores, ramMB: m.ramMB, agents: c.agents });
    const follows = scaled.threads === c.threads && scaled.mem === c.mem;
    const how = follows ? "These settings follow" : "These settings were chosen by hand, not by";
    lines.push(`${how} the scaling rule: ${SETTINGS_RULE}.`, "");
    if (!data.rounds.length) return [...lines, "No round finished.", ""].join("\n");
    const total = c.agents * c.threads * c.tests;
    const round = (way, r) => data.rounds.find((row) => row.way === way && row.repeat === r);
    const repeats = [...new Set(data.rounds.map((row) => row.repeat))].sort((a, b) => a - b);
    lines.push("| | Started directly | Through `dotime-queue` |", "| --- | --- | --- |");
    for (const r of repeats) {
        lines.push(`| Round ${r}: time until every agent had a green run | ` +
            `${timeCell(round("direct", r), c.tries)} | ${timeCell(round("queue", r), c.tries)} |`);
    }
    const s = data.summary;
    const cell = (way, key) => range(s[way]?.[key]);
    lines.push(
        `| Rounds not all green | ${s.direct ? `${s.direct.notAllGreen} of ${s.direct.rounds}` : "not run"} | ` +
            `${s.queue ? `${s.queue.notAllGreen} of ${s.queue.rounds}` : "not run"} |`,
        `| Suite runs, median (range) | ${cell("direct", "runs")} | ${cell("queue", "runs")} |`,
        `| First-run failures of ${total} tests, median (range) | ${cell("direct", "firstFailed")} | ` +
            `${cell("queue", "firstFailed")} |`,
        `| Tries without a result, median (range) | ${cell("direct", "errors")} | ${cell("queue", "errors")} |`,
        "",
    );
    return lines.join("\n");
}

function settingsCommand(args) {
    let agents = 4;
    if (args.length) {
        if (args.length !== 2 || args[0] !== "--agents" || !/^[1-9]\d*$/.test(args[1])) {
            console.error("report: usage: node bench/report.mjs settings [--agents <whole number above 0>]");
            process.exit(2);
        }
        agents = Number(args[1]);
    }
    const cores = cpus().length;
    const ramMB = Math.round(totalmem() / 2 ** 20);
    const { threads, mem } = scaledSettings({ cores, ramMB, agents });
    console.log([`cores=${cores}`, `ram_mb=${ramMB}`, `agents=${agents}`, `threads=${threads}`, `mem=${mem}`,
        `rule=${SETTINGS_RULE}`].join("\n"));
}

function summaryCommand(args) {
    if (args.length !== 1) {
        console.error("report: usage: node bench/report.mjs summary <results.json>");
        process.exit(2);
    }
    let data;
    try {
        data = JSON.parse(readFileSync(args[0], "utf8"));
    } catch (error) {
        console.log(`## Benchmark results\n\nNo results could be read from ${args[0]}: ${error.message}\n`);
        return;
    }
    console.log(markdown(data));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
    const [command, ...args] = process.argv.slice(2);
    if (command === "settings") settingsCommand(args);
    else if (command === "summary") summaryCommand(args);
    else {
        console.error("report: usage: node bench/report.mjs settings|summary ...");
        process.exit(2);
    }
}
