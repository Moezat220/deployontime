// Settings and file locations. Every value is a built-in default unless $DOTIME_HOME/config.json replaces it; that
// file is shared by all callers on the machine, so one caller cannot loosen a limit for itself. The environment only
// selects the state folder, the time zone and the notice channel.
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readJson } from "./files.mjs";

export const DEFAULTS = Object.freeze({
    slots: 2,
    maxWaitMin: 60,
    pollMs: 3000,
    health: { loadPerCore: 1.0, minFreeMemPct: 20, minFreeDiskGB: 10, minBatteryPct: 15 },
    limits: {
        defaultMin: 30, debugMin: 15, floorMin: 10, p90Factor: 1.5, longRunFactor: 2, longRunUnmeasuredMin: 20,
        minSamples: 5, windowDays: 14, failWindowHours: 6, priorityGrace: 2, killGraceMs: 10_000, orphanCheckMs: 2000,
    },
    idle: { serverIdleMin: 30, serverCpuS: 10, slotIdleMin: 10, slotCpuS: 5 },
    reaper: {
        overloadPerCore: 2.0, overloadSwapPct: 80, overloadMemPct: 10, overloadDiskGB: 5, lowDiskGB: 20,
        serverPattern: "\\bvite(\\s(?!build\\b)|$)|\\bvitest\\b|\\bnext dev\\b|\\bwrangler dev\\b|webpack(-dev-server| serve)|\\bnodemon\\b",
        keepPattern: "/Applications/|LaunchAgents",
    },
    outputDirs: ["node_modules", "dist", "build", "out", "coverage", ".cache", ".next", ".turbo", ".wrangler", ".vercel", "test-results", "playwright-report"],
});

const MAX_MS = 2 ** 31 - 1; // the longest wait one timer can hold
const above0 = [(n) => n > 0, "a number above 0"];
const from0 = [(n) => n >= 0, "a number of 0 or more"];
const from1 = [(n) => n >= 1, "a number of 1 or more"];
// Numbers may be 0 or more unless a stricter rule is listed here.
const NUMBER_RULES = {
    "slots": from1, "pollMs": above0, "health.loadPerCore": above0,
    "limits.defaultMin": above0, "limits.debugMin": above0, "limits.floorMin": above0, "limits.p90Factor": above0,
    "limits.longRunFactor": above0, "limits.longRunUnmeasuredMin": above0, "limits.minSamples": from1,
    "limits.windowDays": above0, "limits.priorityGrace": from1, "limits.orphanCheckMs": above0,
    "idle.serverIdleMin": above0, "idle.slotIdleMin": above0, "reaper.overloadPerCore": above0,
};

export const defaultHome = () => join(homedir(), ".dotime");
export const homeDir = (env = process.env) => (env.DOTIME_HOME ? resolve(env.DOTIME_HOME) : defaultHome());

const realOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };
/** True only for a state folder that exists inside the system temp folder. Test-only switches need this. */
export function isSandbox(env = process.env) {
    if (!env.DOTIME_HOME) return false;
    const home = realOrNull(env.DOTIME_HOME), tmp = realOrNull(tmpdir());
    return !!home && !!tmp && home.startsWith(tmp + sep) && home !== realOrNull(defaultHome());
}

/** True when this module file is the script node was started with, also through a symlink. */
export function isMainModule(moduleUrl, script = process.argv[1]) {
    try { return pathToFileURL(realpathSync(script)).href === moduleUrl; } catch { return false; }
}

export function paths(env = process.env) {
    const home = homeDir(env);
    return {
        home,
        config: join(home, "config.json"),
        slots: join(home, "slots"),
        line: join(home, "line"),
        journal: join(home, "journal.jsonl"),
        notices: join(home, "notices.json"),
        notifyLog: join(home, "notify.log"),
        reaperState: join(home, "reaper-state.json"),
        scheduleRules: join(home, "schedule-check.json"),
        scheduleLog: join(home, "schedule-check.jsonl"),
    };
}

export function timeZone(env = process.env) {
    const zone = env.DOTIME_TZ || "UTC";
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return zone; } catch { return "UTC"; }
}

const told = new Set();
function warnOnce(text) {
    if (told.has(text)) return;
    told.add(text);
    process.stderr.write(`dotime-queue: ${text}\n`);
}

function parseOr(text, problem) {
    try { return JSON.parse(text); } catch { problem("invalid"); return {}; }
}
const isPlain = (x) => !!x && typeof x === "object" && !Array.isArray(x);
/** null when the value fits the setting, else a few words on what the setting needs. */
function misfit(name, fallback, value) {
    if (typeof fallback === "number") {
        const [fits, needs] = NUMBER_RULES[name] ?? from0;
        if (name.endsWith("Ms") && value > MAX_MS) return `${needs} and at most ${MAX_MS}`; // a longer timer would fire at once
        return typeof value === "number" && Number.isFinite(value) && fits(value) ? null : needs;
    }
    if (Array.isArray(fallback)) {
        return Array.isArray(value) && value.every((x) => typeof x === "string" && x !== "" && !x.includes("/")) ? null : "a list of folder names";
    }
    if (typeof value !== "string" || value === "") return "a regular expression as text";
    try { new RegExp(value); return null; } catch { return "a valid regular expression"; }
}
function overlay(defaults, given, prefix, warn) {
    const out = {};
    for (const [key, fallback] of Object.entries(defaults)) {
        const name = prefix + key, value = given[key];
        if (isPlain(fallback)) {
            if (value !== undefined && !isPlain(value)) warn(`setting ignored: ${name} needs an object, defaults kept`);
            out[key] = overlay(fallback, isPlain(value) ? value : {}, `${name}.`, warn);
            continue;
        }
        const needs = value === undefined ? null : misfit(name, fallback, value);
        if (needs) warn(`setting ignored: ${name} is ${JSON.stringify(value)}, needs ${needs}, default ${JSON.stringify(fallback)} kept`);
        out[key] = structuredClone(value === undefined || needs ? fallback : value);
    }
    for (const key of Object.keys(given)) if (!(key in defaults)) warn(`setting ignored: ${prefix}${key} is not a known setting`);
    return out;
}

/** The settings in force. A value that does not fit is replaced by its default, with one warning per process. */
export function loadSettings(env = process.env, { configText, warn = warnOnce } = {}) {
    const problem = (kind, code) => warn(kind === "invalid"
        ? "config.json ignored: it is not valid JSON"
        : `config.json ignored: it could not be read (${code}), defaults kept`);
    let given = configText === undefined ? readJson(paths(env).config, {}, problem) : parseOr(configText, problem);
    if (!isPlain(given)) {
        warn("config.json ignored: it needs one JSON object");
        given = {};
    }
    const settings = overlay(DEFAULTS, given, "", warn);
    settings.slots = Math.floor(settings.slots);
    return settings;
}
