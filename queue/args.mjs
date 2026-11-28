// The command line of dotime-queue: the flags each subcommand accepts, reading their values, and the usage text.
// Anything else on the command line, in front of the `--` for `run`, is refused with a usage error, so a misspelled
// flag never changes what a command does without a word.
import { UNLABELLED } from "./kinds.mjs";

export const USAGE = [
    "dotime-queue: one shared queue for heavy jobs on this computer",
    "",
    '  dotime-queue run --label "<project>: <task>" [options] -- <command> [args]',
    "      --max-wait <min>     leave the line after this many minutes (0: wait without limit)",
    "      --max-run <min>      run limit for this job",
    "      --kind <name>        job kind, in place of the guessed one",
    '      --after-fix "<note>" run a check that failed twice on unchanged code',
    "      --priority           join the line at the front",
    "      --no-skip            run a test or lint check that already passed on this commit",
    "      --isolate            run in a git worktree of its own, on a new branch",
    "  dotime-queue integrate <id> -- <check command>",
    "  dotime-queue discard <id> [--force]",
    "  dotime-queue worktrees",
    "  dotime-queue status",
    "  dotime-queue passed [--match <text>] [--cwd <dir>]",
    "  dotime-queue history [--days <n> | --day <YYYY-MM-DD>]",
    "  dotime-queue flaky [--days <n>]",
    "  dotime-queue reasons [--days <n>] [--json]",
    '  dotime-queue schedule add --label "<project>: <task>" (--every <step> | --cron "<expr>") [options] -- <command>',
    "      --every <step>       run every so long, from now on: 15m, 2h, 1d; at least 1m",
    '      --cron "<expr>"      run at the times of a 5-field cron expression, in this computer\'s time zone',
    "      --isolate            run each time in a git worktree of its own, as run --isolate",
    "      --no-skip            run each time, also when the check already passed on the commit, as run --no-skip",
    "      --cwd <dir>          the folder to run in, in place of the current one",
    "  dotime-queue schedule list",
    "  dotime-queue schedule remove <id>",
    "  dotime-queue schedule enable <id>",
    "  dotime-queue schedule disable <id>",
    "  dotime-queue schedule tick",
    "  dotime-queue schedule install [--dry]",
    "  dotime-queue schedule uninstall [--dry]",
    "  dotime-queue setup [--write] [--cwd <dir>] [--mcp]",
    "      --write              add the queue instruction to the agent files (without it: only show)",
    "      --cwd <dir>          the project folder, in place of the top of the git repository",
    "      --mcp                also print the MCP client settings for dotime-mcp",
    "  dotime-queue help",
].join("\n");

/** text as one shell word: as it is when it holds only characters a shell leaves alone, else in single quotes. */
export function shellWord(text) {
    if (/^[\w@%+=:,./-]+$/.test(text)) return text;
    return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Per subcommand: flags that take a value, and flags that stand alone. */
export const FLAGS = Object.freeze({
    run: { values: ["--label", "--max-wait", "--max-run", "--kind", "--after-fix"], switches: ["--priority", "--no-skip", "--isolate"] },
    status: { values: [], switches: [] },
    passed: { values: ["--match", "--cwd"], switches: [] },
    history: { values: ["--days", "--day"], switches: [] },
    flaky: { values: ["--days"], switches: [] },
    reasons: { values: ["--days"], switches: ["--json"] },
    setup: { values: ["--cwd"], switches: ["--write", "--mcp"] },
    integrate: { values: [], switches: [] },
    discard: { values: [], switches: ["--force"] },
    worktrees: { values: [], switches: [] },
});

/** Per `schedule` sub-command, as FLAGS; command: the words behind "--" are the job's command and are not looked at.
 *  remove, enable and disable take the job id in front of their flags. */
export const SCHEDULE_FLAGS = Object.freeze({
    add: { values: ["--label", "--every", "--cron", "--cwd"], switches: ["--isolate", "--no-skip"], command: true },
    list: { values: [], switches: [] },
    remove: { values: [], switches: [] },
    enable: { values: [], switches: [] },
    disable: { values: [], switches: [] },
    tick: { values: [], switches: [] },
    install: { values: [], switches: ["--dry"] },
    uninstall: { values: [], switches: ["--dry"] },
});

/** The flags of the two scripts that run beside the queue, which take switches only. */
export const SCRIPT_FLAGS = Object.freeze({
    "reaper": { values: [], switches: ["--dry"] },
    "schedule-check": { values: [], switches: ["--dry", "--json"] },
});

/** The usage exit code, the same for dotime-queue and the scripts. */
export const USAGE_EXIT = 2;

/** null when every word fits the subcommand's flags, else the message to print. args[0] is the subcommand; for
 *  `run`, `integrate` and a table entry with command: true only the words in front of "--" are looked at. A value
 *  may not be empty, and no flag may be given twice.
 *  A value that starts with "--" is taken only in the --name=value spelling: in the other one it is read as the
 *  next flag, and the message says how to write it. */
export function flagError(args, table = FLAGS) {
    const allowed = table[args[0]];
    if (!allowed) return null;
    const cut = args.indexOf("--");
    const commandAfter = ["run", "integrate"].includes(args[0]) || allowed.command;
    const words = args.slice(1, commandAfter && cut >= 0 ? cut : args.length);
    const seen = new Set();
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const eq = word.indexOf("=");
        const name = eq < 0 ? word : word.slice(0, eq);
        const known = allowed.values.includes(name) || allowed.switches.includes(name);
        if (known && seen.has(name)) return `option ${name} is given twice`;
        seen.add(name);
        if (allowed.values.includes(name)) {
            const joined = eq >= 0;
            const value = joined ? word.slice(eq + 1) : words[++i];
            if (value === undefined || value === "") return `option ${name} needs a value`;
            if (!joined && value.startsWith("--")) {
                const example = `${name}=${shellWord(value)}`;
                return `option ${name} needs a value; give ${name} a value, or for the value "${value}" write ${example}`;
            }
            continue;
        }
        if (allowed.switches.includes(word)) continue;
        if (allowed.switches.includes(name)) return `option ${name} takes no value`;
        return word.startsWith("-") ? `unknown option ${name}` : `unexpected word "${word}"`;
    }
    return null;
}

// The words in front of "--": a flag behind it belongs to the job's command.
const flagWords = (args) => {
    const cut = args.indexOf("--");
    return cut < 0 ? args : args.slice(0, cut);
};

/** The value of --name <value> or --name=<value> among the flags in front of "--"; undefined when absent. */
export function opt(args, name) {
    const flags = flagWords(args);
    const joined = flags.find((a) => a.startsWith(`${name}=`));
    const at = flags.indexOf(name);
    if (joined) return joined.slice(name.length + 1);
    return at >= 0 ? flags[at + 1] : undefined;
}

/** --max-run in minutes: null when absent, NaN when it is not a number above 0. */
export function parseMaxRun(args) {
    const raw = opt(args, "--max-run");
    if (raw === undefined) return null;
    const value = Number(raw);
    return raw !== "" && Number.isFinite(value) && value > 0 ? value : NaN;
}

/** --max-wait in minutes: the fallback when absent, null when it has no value or is not a number of 0 or more. */
export function parseMaxWait(args, fallback) {
    const raw = opt(args, "--max-wait");
    if (raw === undefined) return flagWords(args).includes("--max-wait") ? null : fallback;
    const minutes = Number(raw);
    return raw !== "" && Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

/** Reads the words of `run`. Returns { label, cmd, priority, noSkip, maxWait, maxRun, kind, afterFix }, with
 *  isolate: true added for --isolate, or { error } with the text to print. settings.maxWaitMin is the wait limit
 *  without --max-wait. */
export function parseRunArgs(args, settings) {
    const cut = args.indexOf("--");
    if (args[0] !== "run" || cut < 0 || cut === args.length - 1) return { error: USAGE };
    const badFlag = flagError(args);
    if (badFlag) return { error: badFlag };
    const maxWait = parseMaxWait(args, settings.maxWaitMin);
    if (maxWait === null) return { error: "--max-wait wants a number of minutes, 0 or more; 0 means no limit" };
    const maxRun = parseMaxRun(args);
    if (Number.isNaN(maxRun)) return { error: "--max-run wants a positive number of minutes" };
    return {
        label: opt(args, "--label")?.trim() || UNLABELLED,
        cmd: args.slice(cut + 1),
        priority: flagWords(args).includes("--priority"),
        noSkip: flagWords(args).includes("--no-skip"),
        maxWait,
        maxRun,
        kind: opt(args, "--kind"),
        afterFix: opt(args, "--after-fix")?.trim() || null,
        ...(flagWords(args).includes("--isolate") ? { isolate: true } : {}),
    };
}
