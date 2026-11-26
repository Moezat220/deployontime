#!/usr/bin/env node
// A read-only report on the scheduled jobs in ~/Library/LaunchAgents: is each one loaded, did its last run end with
// an accepted exit code, do its scripts exist, and is its log as recent as its schedule implies. Problems go out as
// one notice. Flags: --dry (no notice, no log entry) and --json. Rules come from $DOTIME_HOME/schedule-check.json.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isMainModule, paths, timeZone } from "./settings.mjs";
import { dateTime } from "./clock.mjs";
import { notify } from "./notify.mjs";
import { probeReadPlist, probeScheduledJobs } from "./probes.mjs";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const LIST_ERROR = "could not read the job list";

const warnOnStderr = (text) => process.stderr.write(`schedule-check: ${text}\n`);
/** The rules file as an object: { skip: [label patterns], okExit: { label: [codes] }, maxLogAgeH: { label: hours | null } }.
 *  A missing file means no rules. A file that cannot be read or is not one JSON object is reported through warn
 *  and also means no rules. */
export function readRules(file = paths().scheduleRules, { warn = warnOnStderr } = {}) {
    const none = { skip: [], okExit: {} };
    let rules;
    try { rules = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
        if (e instanceof SyntaxError) warn(`rules file ignored: ${file} is not valid JSON`);
        else if (e.code !== "ENOENT") warn(`rules file ignored: ${file} could not be read (${e.code ?? e.message})`);
        return none;
    }
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) { warn(`rules file ignored: ${file} needs one JSON object`); return none; }
    return rules;
}

/** Matches a label against a pattern in which * stands for any text. */
export function globMatch(pattern, label) {
    const literal = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${pattern.split("*").map(literal).join(".*")}$`).test(label);
}

/** Returns, in ms, how stale a job's log can get given how often the job is scheduled to run; null for a job
 *  that has no schedule. */
export function maxLogAgeMs(plist) {
    if (plist.StartInterval) return Math.max(3 * plist.StartInterval * 1000, 30 * MINUTE);
    const calendar = plist.StartCalendarInterval;
    if (!calendar) return null;
    const entries = Array.isArray(calendar) ? calendar : [calendar];
    if (entries.some((e) => e.Day != null)) return 32 * DAY;
    if (entries.some((e) => e.Weekday != null)) return 8 * DAY;
    if (entries.every((e) => e.Hour == null)) return 3 * HOUR;
    return 26 * HOUR;
}

/** The script files among a job's arguments: absolute paths with a script extension. */
export function scriptsOf(plist) {
    const args = plist.ProgramArguments ?? [plist.Program];
    return args.filter((arg) => typeof arg === "string" && arg.startsWith("/") && /\.(mjs|cjs|js|ts|sh|zsh|py)$/.test(arg));
}

/** Judges one job from the facts gathered about it. Returns { label, ok, problems, log }. */
export function judge({ label, plist, loaded, exit, logMtime, scriptsMissing }, rules = {}, now = Date.now(), tz = timeZone()) {
    const problems = [];
    if (!loaded) problems.push("not loaded in the scheduler");
    if (scriptsMissing.length) problems.push(`script not found: ${scriptsMissing.join(", ")}`);
    const accepted = rules.okExit?.[label] ?? [0];
    if (loaded && exit != null && !accepted.includes(exit)) problems.push(exit < 0 ? `last run ended by signal ${-exit}` : `last run exit code ${exit}`);
    const ageRules = rules.maxLogAgeH ?? {};
    const maxAge = label in ageRules ? (ageRules[label] == null ? null : ageRules[label] * HOUR) : maxLogAgeMs(plist);
    const log = plist.StandardErrorPath ?? plist.StandardOutPath ?? null;
    if (maxAge && log) {
        if (logMtime == null) { if (loaded) problems.push("log file not found"); }
        else if (now - logMtime > maxAge) problems.push(`log not written since ${dateTime(logMtime, tz)}`);
    }
    return { label, ok: problems.length === 0, problems, log };
}

/** Judges every job file in a folder. Each reading can be replaced, so tests run on made-up jobs. Without rules
 *  given, they are read from rulesFile. Returns { results, error, warnings }; error is set, and results empty, when
 *  the scheduler's job list cannot be read; warnings name a rules file that could not be used. */
export function checkAll({
    rules, rulesFile = paths().scheduleRules, warn = warnOnStderr, now = Date.now(), dir = join(homedir(), "Library", "LaunchAgents"),
    list = () => readdirSync(dir), status = probeScheduledJobs, readPlist = probeReadPlist,
    exists = existsSync, mtime = (file) => statSync(file).mtimeMs, tz = timeZone(),
} = {}) {
    const warnings = [];
    if (!rules) rules = readRules(rulesFile, { warn: (text) => { warnings.push(text); warn(text); } });
    let files;
    try { files = list().filter((name) => name.endsWith(".plist")).sort(); } catch { return { results: [], error: null, warnings }; }
    const loadedJobs = status();
    if (!loadedJobs) return { results: [], error: LIST_ERROR, warnings };
    const results = [];
    for (const name of files) {
        const plist = readPlist(join(dir, name));
        if (!plist) { results.push({ label: name, ok: false, problems: ["job file unreadable"], log: null }); continue; }
        const label = plist.Label ?? name.replace(/\.plist$/, "");
        if ((rules.skip ?? []).some((pattern) => globMatch(pattern, label))) continue;
        const entry = loadedJobs.get(label), log = plist.StandardErrorPath ?? plist.StandardOutPath;
        let logMtime = null;
        try { if (log) logMtime = mtime(log); } catch { /* no log file */ }
        const scriptsMissing = scriptsOf(plist).filter((script) => !exists(script));
        results.push(judge({ label, plist, loaded: !!entry, exit: entry?.exit ?? null, logMtime, scriptsMissing }, rules, now, tz));
    }
    return { results, error: null, warnings };
}

/** The notice text: the warnings, then the jobs with problems; null when there is nothing to say. */
export function reportText(results, warnings = []) {
    const broken = results.filter((r) => !r.ok), parts = [...warnings];
    if (broken.length) parts.push(`scheduled jobs with problems: ${broken.length} of ${results.length}; ${broken.map((r) => `${r.label}: ${r.problems.join(", ")}`).join("; ")}`);
    return parts.length ? parts.join("; ") : null;
}

async function main() {
    const dry = process.argv.includes("--dry"), asJson = process.argv.includes("--json"), now = Date.now();
    const { results, error, warnings } = checkAll({ now }), text = error ? [...warnings, error].join("; ") : reportText(results, warnings);
    if (asJson) console.log(JSON.stringify(error ? { error } : results, null, 1));
    else if (error) console.log(`schedule-check ${dateTime(now, timeZone())}: ${text}`);
    else console.log(`schedule-check ${dateTime(now, timeZone())}: jobs checked ${results.length}, with problems ${results.filter((r) => !r.ok).length}${text ? `; ${text}` : ""}`);
    if (!dry) {
        if (text) { try { notify("dotime: scheduled jobs", text); } catch { /* the printed line already says it */ } }
        try {
            const log = paths().scheduleLog;
            mkdirSync(dirname(log), { recursive: true });
            appendFileSync(log, `${JSON.stringify({ at: new Date(now).toISOString(), error, warnings, results })}\n`);
        } catch { /* the report does not depend on its log */ }
    }
    if (error) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) await main();
