#!/usr/bin/env node
// A read-only report on the scheduled jobs in ~/Library/LaunchAgents: is each one loaded, did its last run end with
// an accepted exit code, do its scripts exist, and is its log as recent as its schedule implies. Problems go out as
// one notice. Flags: --dry (no notice, no log entry) and --json. Rules come from $DOTIME_HOME/schedule-check.json.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainModule, paths, timeZone } from "./settings.mjs";
import { dateTime } from "./clock.mjs";
import { notify } from "./notify.mjs";
import { probeReadPlist, probeScheduledJobs } from "./probes.mjs";
import { appendLine, readJson } from "./files.mjs";
import { flagError, SCRIPT_FLAGS, USAGE_EXIT } from "./args.mjs";
import { DAY, HOUR, MINUTE } from "./units.mjs";

export const LIST_ERROR = "could not read the job list";

/** Why the report cannot run on this platform, or null on macOS. It reads launchd job files and launchctl, which
 *  only macOS has. */
export function platformError(platform) {
    if (platform === "darwin") return null;
    return `works on macOS only for now: it reads launchd jobs in ~/Library/LaunchAgents through launchctl, `
        + `which ${platform === "linux" ? "Linux does" : "this system does"} not have; nothing was checked`;
}

const warnOnStderr = (text) => process.stderr.write(`schedule-check: ${text}\n`);
/** The rules file as an object:
 *  { skip: [label patterns], okExit: { label: [codes] }, maxLogAgeH: { label: hours | null } }.
 *  A missing file means no rules. A file that cannot be read or is not one JSON object is reported through warn
 *  and also means no rules. */
export function readRules(file, { warn = warnOnStderr } = {}) {
    const none = { skip: [], okExit: {} };
    const missing = Symbol("no rules");
    const rules = readJson(file, missing, (problem, code) => warn(problem === "invalid"
        ? `rules file ignored: ${file} is not valid JSON`
        : `rules file ignored: ${file} could not be read (${code})`));
    if (rules === missing) return none;
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
        warn(`rules file ignored: ${file} needs one JSON object`);
        return none;
    }
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
    // A key left out is a wildcard: an entry with neither Minute nor Hour fires every minute, like StartInterval 60.
    if (entries.some((e) => e.Minute == null && e.Hour == null)) return 30 * MINUTE;
    if (entries.every((e) => e.Hour == null)) return 3 * HOUR;
    return 26 * HOUR;
}

const SCRIPT_RE = /\.(mjs|cjs|js|ts|sh|zsh|py)$/;
/** The script files among a job's arguments: absolute paths with a script extension. */
export function scriptsOf(plist) {
    const args = plist.ProgramArguments ?? [plist.Program];
    const isScript = (arg) => typeof arg === "string" && arg.startsWith("/") && SCRIPT_RE.test(arg);
    return args.filter(isScript);
}

/** Judges one job from the facts gathered about it. Returns { label, ok, problems, log }. */
export function judge({ label, plist, loaded, exit, logMtime, scriptsMissing }, rules, now, tz) {
    const problems = [];
    if (!loaded) problems.push("not loaded in the scheduler");
    if (scriptsMissing.length) problems.push(`script not found: ${scriptsMissing.join(", ")}`);
    const accepted = rules.okExit?.[label] ?? [0];
    if (loaded && exit != null && !accepted.includes(exit)) {
        problems.push(exit < 0 ? `last run ended by signal ${-exit}` : `last run exit code ${exit}`);
    }
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
    rules, rulesFile, warn = warnOnStderr, now = Date.now(), dir = join(homedir(), "Library", "LaunchAgents"),
    list = () => readdirSync(dir), status = probeScheduledJobs, readPlist = probeReadPlist,
    exists = existsSync, mtime = (file) => statSync(file).mtimeMs, tz,
}) {
    const warnings = [];
    if (!rules) rules = readRules(rulesFile, { warn: (text) => { warnings.push(text); warn(text); } });
    let files;
    try {
        files = list().filter((name) => name.endsWith(".plist")).sort();
    } catch { return { results: [], error: null, warnings }; }
    const loadedJobs = status();
    if (!loadedJobs) return { results: [], error: LIST_ERROR, warnings };
    const results = [];
    for (const name of files) {
        const plist = readPlist(join(dir, name));
        if (!plist) {
            results.push({ label: name, ok: false, problems: ["job file unreadable"], log: null });
            continue;
        }
        const label = plist.Label ?? name.replace(/\.plist$/, "");
        if ((rules.skip ?? []).some((pattern) => globMatch(pattern, label))) continue;
        const entry = loadedJobs.get(label);
        const log = plist.StandardErrorPath ?? plist.StandardOutPath;
        let logMtime = null;
        try { if (log) logMtime = mtime(log); } catch { /* no log file */ }
        const scriptsMissing = scriptsOf(plist).filter((script) => !exists(script));
        const facts = { label, plist, loaded: !!entry, exit: entry?.exit ?? null, logMtime, scriptsMissing };
        results.push(judge(facts, rules, now, tz));
    }
    return { results, error: null, warnings };
}

/** The notice text: the warnings, then the jobs with problems; null when there is nothing to say. */
export function reportText(results, warnings = []) {
    const broken = results.filter((r) => !r.ok);
    const parts = [...warnings];
    if (broken.length) {
        const each = broken.map((r) => `${r.label}: ${r.problems.join(", ")}`).join("; ");
        parts.push(`scheduled jobs with problems: ${broken.length} of ${results.length}; ${each}`);
    }
    return parts.length ? parts.join("; ") : null;
}

async function main() {
    const badFlag = flagError(["schedule-check", ...process.argv.slice(2)], SCRIPT_FLAGS);
    if (badFlag) {
        process.stderr.write(`schedule-check: ${badFlag}; usage: schedule-check.mjs [--dry] [--json]\n`);
        process.exitCode = USAGE_EXIT;
        return;
    }
    const unsupported = platformError(process.platform);
    if (unsupported) {
        process.stderr.write(`schedule-check: ${unsupported}\n`);
        process.exitCode = 1;
        return;
    }
    const dry = process.argv.includes("--dry");
    const asJson = process.argv.includes("--json");
    const now = Date.now();
    const files = paths();
    const tz = timeZone();
    const { results, error, warnings } = checkAll({ now, rulesFile: files.scheduleRules, tz });
    const text = error ? [...warnings, error].join("; ") : reportText(results, warnings);
    if (asJson) console.log(JSON.stringify(error ? { error } : results, null, 1));
    else if (error) console.log(`schedule-check ${dateTime(now, tz)}: ${text}`);
    else {
        const counts = `jobs checked ${results.length}, with problems ${results.filter((r) => !r.ok).length}`;
        console.log(`schedule-check ${dateTime(now, tz)}: ${counts}${text ? `; ${text}` : ""}`);
    }
    if (!dry) {
        if (text) {
            try {
                notify("dotime: scheduled jobs", text, { env: process.env, logFile: files.notifyLog });
            } catch { /* the printed line already says it */ }
        }
        // The report does not depend on its log: a line that cannot be written is left out.
        const line = { at: new Date(now).toISOString(), error, warnings, results };
        appendLine(files.scheduleLog, `${JSON.stringify(line)}\n`);
    }
    if (error) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) await main();
