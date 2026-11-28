// Settings and file locations. Every value is a built-in default unless $DOTIME_HOME/config.json replaces it; that
// file is shared by all callers on the machine, so one caller cannot loosen a limit for itself. The environment only
// selects the state folder, the time zone and the notice channel.
import { realpathSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { capacityPlan } from "./capacity.mjs";
import { readJson } from "./files.mjs";
import { MAX_TIMER_MS } from "./timer.mjs";

export const DEFAULTS = Object.freeze({
    slots: 2,
    // null: not set, so capacity.mjs picks the most slots from the cores and whether slots is set.
    maxSlots: null,
    extraSlotCpuPct: 60,
    extraSlotSettleSec: 5,
    nestedPerJob: 2,
    mcpMaxJobs: 20,
    flakyWindowDays: 14,
    notifyDoneMin: 5,
    maxWaitMin: 60,
    pollMs: 3000,
    health: { loadPerCore: 1.0, busyCpuPct: 90, minFreeMemPct: 20, minFreeDiskGB: 10, minBatteryPct: 15 },
    limits: {
        defaultMin: 30, debugMin: 15, floorMin: 10, p90Factor: 1.5, longRunFactor: 2, longRunUnmeasuredMin: 20,
        minSamples: 5, windowDays: 14, failWindowHours: 6, priorityGrace: 2, killGraceMs: 10_000, orphanCheckMs: 2000,
    },
    idle: { serverIdleMin: 30, serverCpuS: 10, slotIdleMin: 10, slotCpuS: 5 },
    reaper: {
        overloadPerCore: 2.0, overloadSwapPct: 80, overloadMemPct: 10, overloadDiskGB: 5, lowDiskGB: 20,
        serverPattern: [
            "\\bvite(\\s(?!build\\b)|$)", "\\bvitest\\b", "\\bnext dev\\b", "\\bwrangler dev\\b",
            "webpack(-dev-server| serve)", "\\bnodemon\\b",
        ].join("|"),
        keepPattern: "/Applications/|LaunchAgents",
    },
    isolateLinks: [],
    outputDirs: [
        "node_modules", "dist", "build", "out", "coverage", ".cache", ".next", ".turbo", ".wrangler", ".vercel",
        "test-results", "playwright-report",
    ],
});

const above0 = [(n) => n > 0, "a number above 0"];
const from0 = [(n) => n >= 0, "a number of 0 or more"];
const from1 = [(n) => n >= 1, "a number of 1 or more"];
const whole1 = [(n) => Number.isInteger(n) && n >= 1, "a whole number of 1 or more"];
const pct = [(n) => n > 0 && n <= 100, "a number above 0 and at most 100"];
const pct1 = [(n) => n >= 1 && n <= 100, "a number from 1 to 100"];
// Numbers may be 0 or more unless a stricter rule is listed here.
const NUMBER_RULES = {
    "slots": from1, "maxSlots": whole1, "extraSlotCpuPct": pct1, "nestedPerJob": whole1, "mcpMaxJobs": whole1,
    "flakyWindowDays": whole1, "pollMs": above0, "health.loadPerCore": above0, "health.busyCpuPct": pct,
    "limits.defaultMin": above0, "limits.debugMin": above0, "limits.floorMin": above0, "limits.p90Factor": above0,
    "limits.longRunFactor": above0, "limits.longRunUnmeasuredMin": above0, "limits.minSamples": from1,
    "limits.windowDays": above0, "limits.priorityGrace": from1, "limits.orphanCheckMs": above0,
    "idle.serverIdleMin": above0, "idle.slotIdleMin": above0, "reaper.overloadPerCore": above0,
};

export const defaultHome = () => join(homedir(), ".dotime");
export const homeDir = (env = process.env) => (env.DOTIME_HOME ? resolve(env.DOTIME_HOME) : defaultHome());

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
        waitingLine: join(home, "line"),
        nested: join(home, "nested"),
        places: join(home, "places"),
        journal: join(home, "journal.jsonl"),
        notices: join(home, "notices"),
        notifyLog: join(home, "notify.log"),
        reaperState: join(home, "reaper-state.json"),
        healthCache: join(home, "health.json"),
        scheduleRules: join(home, "schedule-check.json"),
        scheduleLog: join(home, "schedule-check.jsonl"),
        schedule: join(home, "schedule.json"),
        scheduleLock: join(home, "schedule.lock"),
        scheduleRuns: join(home, "schedule-runs"),
        tickLog: join(home, "schedule.log"),
        tickNotes: join(home, "schedule-notes.json"),
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
/** A path below the top of a repository: relative, with no empty, "." or ".." step, and not into .git. */
const insidePath = (x) => typeof x === "string" && x !== "" && !x.startsWith("/")
    && x.split("/").every((step) => step !== "" && step !== "." && step !== "..") && x.split("/")[0] !== ".git";
/** null when the value fits the setting, else a few words on what the setting needs. */
function misfit(name, fallback, value) {
    if (typeof fallback === "number" || name === "maxSlots") {
        const [fits, needs] = NUMBER_RULES[name] ?? from0;
        // A longer timer would fire at once.
        if (name.endsWith("Ms") && value > MAX_TIMER_MS) return `${needs} and at most ${MAX_TIMER_MS}`;
        return typeof value === "number" && Number.isFinite(value) && fits(value) ? null : needs;
    }
    if (name === "isolateLinks") {
        return Array.isArray(value) && value.every(insidePath) ? null : "a list of relative paths inside the repository";
    }
    if (Array.isArray(fallback)) {
        const folderName = (x) => typeof x === "string" && x !== "" && !x.includes("/");
        return Array.isArray(value) && value.every(folderName) ? null : "a list of folder names";
    }
    if (typeof value !== "string" || value === "") return "a regular expression as text";
    try { new RegExp(value); return null; } catch { return "a valid regular expression"; }
}
/** The settings of defaults, each replaced by the one in given when it fits. accepted gets the name of each one. */
function overlay(defaults, given, prefix, warn, accepted = new Set()) {
    const out = {};
    for (const [key, fallback] of Object.entries(defaults)) {
        const name = prefix + key;
        const value = given[key];
        if (isPlain(fallback)) {
            if (value !== undefined && !isPlain(value)) warn(`setting ignored: ${name} needs an object, defaults kept`);
            out[key] = overlay(fallback, isPlain(value) ? value : {}, `${name}.`, warn, accepted);
            continue;
        }
        const needs = value === undefined ? null : misfit(name, fallback, value);
        if (needs) {
            const kept = fallback === null ? "not set" : `default ${JSON.stringify(fallback)} kept`;
            warn(`setting ignored: ${name} is ${JSON.stringify(value)}, needs ${needs}, ${kept}`);
        }
        if (value !== undefined && !needs) accepted.add(name);
        out[key] = structuredClone(value === undefined || needs ? fallback : value);
    }
    for (const key of Object.keys(given)) {
        if (!(key in defaults)) warn(`setting ignored: ${prefix}${key} is not a known setting`);
    }
    return out;
}

/** The settings in force. A value that does not fit is replaced by its default, with one warning per process. The
 *  settings also carry userSet, { slots, maxSlots }, true for each of the two that the settings file sets to a value
 *  that fits, so capacityOf() can tell a slot count the user chose from the default. It is not enumerable, so the
 *  settings still compare equal to DEFAULTS when the file sets nothing. */
export function loadSettings(env = process.env, { configText, warn = warnOnce } = {}) {
    const problem = (kind, code) => warn(kind === "invalid"
        ? "config.json ignored: it is not valid JSON"
        : `config.json ignored: it could not be read (${code}), defaults kept`);
    let given = configText === undefined ? readJson(paths(env).config, {}, problem) : parseOr(configText, problem);
    if (!isPlain(given)) {
        warn("config.json ignored: it needs one JSON object");
        given = {};
    }
    const accepted = new Set();
    const settings = overlay(DEFAULTS, given, "", warn, accepted);
    settings.slots = Math.floor(settings.slots);
    if (settings.maxSlots !== null && settings.maxSlots < settings.slots) {
        warn(`setting ignored: maxSlots is ${settings.maxSlots}, needs a whole number of at least slots (${settings.slots}), not set`);
        settings.maxSlots = null;
        accepted.delete("maxSlots");
    }
    const userSet = { slots: accepted.has("slots"), maxSlots: accepted.has("maxSlots") };
    Object.defineProperty(settings, "userSet", { value: userSet, enumerable: false });
    return settings;
}

/** The capacity plan for these settings on a computer with this many cores, as capacityPlan() makes it. Settings
 *  without userSet, such as ones built by hand, count as setting neither slots nor maxSlots. */
export const capacityOf = (settings, cores = availableParallelism()) =>
    capacityPlan({ settings, userSet: settings.userSet ?? {}, cores });
