import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLAGS, flagError, SCHEDULE_FLAGS, SCRIPT_FLAGS, opt, parseMaxRun, parseMaxWait, parseRunArgs, shellWord, USAGE } from "./args.mjs";
import { DEFAULTS } from "./settings.mjs";

test("flagError: accepts each subcommand's own flags in both spellings", () => {
    assert.equal(flagError([
        "run", "--priority", "--label", "docs-site: build", "--max-wait=5", "--max-run", "40", "--kind", "build",
        "--after-fix", "raised the pool size", "--", "make",
    ]), null);
    assert.equal(flagError(["passed", "--match", "lint", "--cwd=/srv/shop-api"]), null);
    assert.equal(flagError(["history", "--days", "3"]), null);
    assert.equal(flagError(["status"]), null);
});

test("flagError: refuses an unknown or misspelled flag, a stray word and a missing value", () => {
    assert.equal(flagError(["passed", "--mach", "lint"]), "unknown option --mach");
    assert.equal(flagError(["passed", "--match"]), "option --match needs a value");
    assert.equal(flagError(["history", "--day=2040-01-01", "--weeks", "2"]), "unknown option --weeks");
    assert.equal(flagError(["status", "now"]), 'unexpected word "now"');
    assert.equal(flagError(["run", "--max-runn=90", "--", "make"]), "unknown option --max-runn");
    assert.equal(flagError(["run", "-p", "--", "make"]), "unknown option -p");
});

test("flagError: an empty value is refused like a missing one", () => {
    assert.equal(flagError(["passed", "--match", ""]), "option --match needs a value");
    assert.equal(flagError(["passed", "--match="]), "option --match needs a value");
    assert.equal(flagError(["passed", "--cwd="]), "option --cwd needs a value");
    assert.equal(flagError(["run", "--kind=", "--", "make"]), "option --kind needs a value");
    assert.equal(flagError(["run", "--label=", "--", "make"]), "option --label needs a value");
    assert.equal(flagError(["history", "--days", ""]), "option --days needs a value");
});

test("flagError: a word that looks like a flag is never taken as a value, and the message says how to give one", () => {
    assert.equal(
        flagError(["run", "--label", "--priority", "--", "make"]),
        'option --label needs a value; give --label a value, or for the value "--priority" write --label=--priority',
    );
    assert.equal(
        flagError(["passed", "--match", "--cwd", "/srv/shop-api"]),
        'option --match needs a value; give --match a value, or for the value "--cwd" write --match=--cwd',
    );
    assert.equal(flagError(["run", "--kind", "--", "make"]), "option --kind needs a value");
    assert.equal(flagError(["run", "--max-wait", "-1", "--", "make"]), null);
});

test("flagError: the hint quotes a value that a shell would split or change", () => {
    assert.equal(
        flagError(["run", "--label", "--docs site: build", "--", "make"]),
        `option --label needs a value; give --label a value, or for the value "--docs site: build" write --label='--docs site: build'`,
    );
    assert.equal(
        flagError(["run", "--after-fix", "--it's fixed", "--", "make"]),
        `option --after-fix needs a value; give --after-fix a value, or for the value "--it's fixed" write --after-fix='--it'\\''s fixed'`,
    );
});

test("shellWord: leaves a plain word as it is and quotes the rest", () => {
    assert.equal(shellWord("--priority"), "--priority");
    assert.equal(shellWord("/srv/shop-api"), "/srv/shop-api");
    assert.equal(shellWord("two words"), "'two words'");
    assert.equal(shellWord("tab\there"), "'tab\there'");
    assert.equal(shellWord("$HOME"), "'$HOME'");
    assert.equal(shellWord("it's"), `'it'\\''s'`);
    assert.equal(shellWord(""), "''");
});

test("flagError: the --name=value spelling may carry a value that starts with --", () => {
    assert.equal(flagError(["run", "--label=--priority", "--", "make"]), null);
    assert.equal(flagError(["run", "--after-fix=--retries was the culprit", "--priority", "--", "make"]), null);
    assert.equal(flagError(["passed", "--match=--coverage"]), null);
});

test("parseRunArgs: a value written as --name=--value is the value, not a flag", () => {
    const parsed = parseRunArgs(["run", "--label=--nightly", "--after-fix=--retries was the culprit", "--", "make"], DEFAULTS);
    assert.deepEqual([parsed.label, parsed.afterFix, parsed.priority], ["--nightly", "--retries was the culprit", false]);
    assert.equal(parseRunArgs(["run", "--label=--priority", "--", "make"], DEFAULTS).priority, false);
    assert.equal(opt(["passed", "--match=--coverage"], "--match"), "--coverage");
});

test("flagError: a flag given twice is refused", () => {
    assert.equal(flagError(["run", "--max-run", "5", "--max-run", "90", "--", "make"]), "option --max-run is given twice");
    assert.equal(flagError(["run", "--label=a", "--label", "b", "--", "make"]), "option --label is given twice");
    assert.equal(flagError(["run", "--priority", "--priority", "--", "make"]), "option --priority is given twice");
    assert.equal(flagError(["history", "--days", "2", "--days=3"]), "option --days is given twice");
});

test("flagError: run ignores everything behind the --, which belongs to the job", () => {
    assert.equal(flagError(["run", "--label", "shop-api: lint", "--", "pnpm", "lint", "--fix", "--max-runn", "1"]), null);
});

test("FLAGS: lists the subcommands the usage text names", () => {
    assert.deepEqual(Object.keys(FLAGS), [
        "run", "status", "passed", "history", "flaky", "setup", "integrate", "discard", "worktrees",
    ]);
    for (const name of Object.keys(FLAGS)) assert.match(USAGE, new RegExp(`^  dotime-queue ${name}\\b`, "m"), name);
});

test("flagError: flaky takes --days with a value and nothing else", () => {
    assert.equal(flagError(["flaky"]), null);
    assert.equal(flagError(["flaky", "--days", "7"]), null);
    assert.equal(flagError(["flaky", "--day", "7"]), "unknown option --day");
    assert.equal(flagError(["flaky", "--days"]), "option --days needs a value");
});

test("flagError: setup takes --cwd with a value and --write and --mcp alone", () => {
    assert.equal(flagError(["setup", "--write", "--mcp", "--cwd", "/srv/shop-api"]), null);
    assert.equal(flagError(["setup", "--wirte"]), "unknown option --wirte");
    assert.equal(flagError(["setup", "--cwd"]), "option --cwd needs a value");
    assert.equal(flagError(["setup", "--write=yes"]), "option --write takes no value");
    assert.equal(flagError(["setup", "--write", "--write"]), "option --write is given twice");
    assert.equal(flagError(["setup", "now"]), 'unexpected word "now"');
});

test("opt: reads a flag in either spelling, in front of the -- only", () => {
    const args = ["run", "--label", "mobile-app: bundle", "--kind=build", "--after-fix=", "--", "make", "--kind", "lint", "--label=inner"];
    assert.deepEqual(
        [opt(args, "--label"), opt(args, "--kind"), opt(args, "--after-fix"), opt(args, "--max-run")],
        ["mobile-app: bundle", "build", "", undefined],
    );
    assert.equal(opt(["passed", "--match", "suite"], "--match"), "suite");
});

test("parseMaxRun: null when absent, the minutes when valid, NaN otherwise", () => {
    assert.equal(parseMaxRun(["run", "--", "make"]), null);
    assert.equal(parseMaxRun(["run", "--max-run", "0.5", "--", "make"]), 0.5);
    assert.equal(parseMaxRun(["run", "--max-run=90", "--", "make"]), 90);
    for (const value of ["Infinity", "", "x9", "-4", "0"]) assert.equal(Number.isNaN(parseMaxRun(["run", `--max-run=${value}`, "--", "make"])), true, value);
});

test("parseMaxWait: leaves a flag alone when it belongs to the job's command", () => {
    assert.equal(parseMaxWait(["run", "--label", "shop-api: lint", "--", "pnpm", "lint", "--max-wait=2"], 45), 45);
});

test("parseMaxWait: null when the value is missing or is not a number of 0 or more", () => {
    for (const flags of [["--max-wait="], ["--max-wait", "ten"], ["--max-wait"], ["--max-wait=-0.5"], ["--max-wait", "NaN"]]) {
        assert.equal(parseMaxWait(["run", ...flags, "--", "pnpm", "lint"], 45), null, flags.join(" "));
    }
});

test("parseMaxWait: takes the minutes from either spelling, and the fallback without the flag", () => {
    assert.equal(parseMaxWait(["run", "--max-wait=8", "--", "pnpm", "lint"], 45), 8);
    assert.equal(parseMaxWait(["run", "--priority", "--max-wait", "0", "--", "pnpm", "lint"], 45), 0);
    assert.equal(parseMaxWait(["run", "--max-wait", "0.25", "--", "pnpm", "lint"], 45), 0.25);
    assert.equal(parseMaxWait(["run", "--", "pnpm", "lint"], 45), 45);
    assert.equal(parseMaxWait(["history"], 45), 45);
});

test("parseRunArgs: reads every flag in front of the -- and the command behind it", () => {
    const args = [
        "run", "--priority", "--label", "  mobile-app: store upload ", "--max-wait=7", "--max-run", "40", "--kind", "deploy",
        "--after-fix", " rotated the signing key ", "--no-skip", "--", "make", "upload", "--priority", "--label", "inner",
    ];
    assert.deepEqual(parseRunArgs(args, DEFAULTS), {
        label: "mobile-app: store upload",
        cmd: ["make", "upload", "--priority", "--label", "inner"],
        priority: true,
        noSkip: true,
        maxWait: 7,
        maxRun: 40,
        kind: "deploy",
        afterFix: "rotated the signing key",
    });
});

test("parseRunArgs: fills in defaults for flags that are left out", () => {
    assert.deepEqual(
        parseRunArgs(["run", "--", "make"], { ...DEFAULTS, maxWaitMin: 25 }),
        { label: "unnamed", cmd: ["make"], priority: false, noSkip: false, maxWait: 25, maxRun: null, kind: undefined, afterFix: null },
    );
});

test("parseRunArgs: the usage text for a missing command, a short message for a bad number", () => {
    for (const args of [
        ["run"],
        ["run", "--label", "docs-site: build"],
        ["run", "--label", "docs-site: build", "--"],
        ["start", "--", "make"],
        [],
    ]) assert.equal(parseRunArgs(args, DEFAULTS).error, USAGE);
    assert.equal(parseRunArgs(["run", "--max-wait", "-1", "--", "make"], DEFAULTS).error, "--max-wait wants a number of minutes, 0 or more; 0 means no limit");
    assert.equal(parseRunArgs(["run", "--max-run=0", "--", "make"], DEFAULTS).error, "--max-run wants a positive number of minutes");
});

test("parseRunArgs: refuses a flag that run does not know, and a flag without its value", () => {
    assert.equal(parseRunArgs(["run", "--max-runn", "90", "--", "make"], DEFAULTS).error, "unknown option --max-runn");
    assert.equal(parseRunArgs(["run", "--label=docs-site: build", "--prio", "--", "make", "--prio"], DEFAULTS).error, "unknown option --prio");
    assert.equal(parseRunArgs(["run", "--label", "docs-site: build", "stray", "--", "make"], DEFAULTS).error, 'unexpected word "stray"');
    assert.equal(parseRunArgs(["run", "--priority=yes", "--", "make"], DEFAULTS).error, "option --priority takes no value");
    assert.equal(parseRunArgs(["run", "--kind", "--", "make"], DEFAULTS).error, "option --kind needs a value");
    assert.equal(parseRunArgs(["run", "--label", "docs-site: build", "--", "make", "--unknown-to-the-queue"], DEFAULTS).error, undefined);
});

test("USAGE: names every subcommand and flag that FLAGS accepts, and no other flag", () => {
    for (const [command, { values, switches }] of Object.entries(FLAGS)) {
        assert.equal(USAGE.includes(`dotime-queue ${command}`), true, command);
        for (const flag of [...values, ...switches]) assert.equal(new RegExp(`${flag}(?![\\w-])`).test(USAGE), true, flag);
    }
    const known = new Set([...Object.values(FLAGS), ...Object.values(SCHEDULE_FLAGS)].flatMap(({ values, switches }) => [...values, ...switches]));
    for (const flag of USAGE.match(/--[\w-]+/g)) assert.equal(known.has(flag), true, flag);
});

test("SCHEDULE_FLAGS: one usage line per schedule sub-command, naming each of its flags", () => {
    assert.deepEqual(Object.keys(SCHEDULE_FLAGS), ["add", "list", "remove", "enable", "disable", "tick", "install", "uninstall"]);
    for (const [sub, { values, switches }] of Object.entries(SCHEDULE_FLAGS)) {
        const line = USAGE.split("\n").find((l) => l.startsWith(`  dotime-queue schedule ${sub}`));
        assert.ok(line, sub);
        for (const flag of [...values, ...switches]) assert.equal(new RegExp(`${flag}(?![\\w-])`).test(sub === "add" ? USAGE : line), true, flag);
    }
});

test("flagError: schedule add looks only in front of the --; the others take their own switches only", () => {
    const add = ["add", "--label", "shop-api: lint", "--every", "1h", "--isolate", "--cwd", "/srv/shop-api", "--", "npm", "run", "lint", "--fix"];
    assert.equal(flagError(add, SCHEDULE_FLAGS), null);
    assert.equal(flagError(["add", "--evry", "1h", "--", "make"], SCHEDULE_FLAGS), "unknown option --evry");
    assert.equal(flagError(["add", "--cron", "--", "make"], SCHEDULE_FLAGS), "option --cron needs a value");
    assert.equal(flagError(["add", "--every", "1h", "--every", "2h", "--", "make"], SCHEDULE_FLAGS), "option --every is given twice");
    assert.equal(flagError(["install", "--dry"], SCHEDULE_FLAGS), null);
    assert.equal(flagError(["tick", "--dry"], SCHEDULE_FLAGS), "unknown option --dry");
    assert.equal(flagError(["list", "extra"], SCHEDULE_FLAGS), 'unexpected word "extra"');
    assert.equal(flagError(["tick", "--", "make"], SCHEDULE_FLAGS), "unknown option --");
});

test("flagError: the scripts beside the queue accept their own switches and nothing else", () => {
    assert.equal(flagError(["reaper", "--dry"], SCRIPT_FLAGS), null);
    assert.equal(flagError(["schedule-check", "--json", "--dry"], SCRIPT_FLAGS), null);
    assert.equal(flagError(["reaper", "--dryy"], SCRIPT_FLAGS), "unknown option --dryy");
    assert.equal(flagError(["schedule-check", "--json=yes"], SCRIPT_FLAGS), "option --json takes no value");
});

test("parseRunArgs: --isolate adds isolate: true, and without it the result has no isolate field", () => {
    assert.equal(parseRunArgs(["run", "--isolate", "--label", "shop-api: rename", "--", "make"], DEFAULTS).isolate, true);
    assert.equal("isolate" in parseRunArgs(["run", "--", "make", "--isolate"], DEFAULTS), false);
    assert.equal(flagError(["run", "--isolate=yes", "--", "make"]), "option --isolate takes no value");
});

test("flagError: integrate looks only in front of the --, discard takes --force, worktrees takes nothing", () => {
    assert.equal(flagError(["integrate", "--", "npm", "test", "--watch"]), null);
    assert.equal(flagError(["integrate", "--fast", "--", "npm", "test"]), "unknown option --fast");
    assert.equal(flagError(["discard", "--force"]), null);
    assert.equal(flagError(["discard", "--forse"]), "unknown option --forse");
    assert.equal(flagError(["worktrees", "--all"]), "unknown option --all");
});
