// Tests for `dotime-queue setup`: the block in a file's text, the plan for a folder, and the command itself, started
// as a script in a temp project folder. Nothing outside the temp folders is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv, isolateProcess, tempDir } from "./testkit.mjs";

const home = isolateProcess("setup");
const { applyPlan, BEGIN, blockText, END, mcpLines, planFolder, planText } = await import("./setup.mjs");
const { cmdSetup } = await import("./cli.mjs");

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const cli = (args, cwd) => spawnSync(process.execPath, [CLI, "setup", ...args], {
    cwd, env: cleanEnv(home), encoding: "utf8", timeout: 30_000,
});
const read = (dir, name) => readFileSync(join(dir, name), "utf8");
// The files in dir with their text, so a test can tell that nothing changed.
const tree = (dir) => Object.fromEntries(readdirSync(dir).sort().map((name) => [name, read(dir, name)]));
const OWN = "# Shop API\n\nRun `make lint` before you commit.\n";
const isRoot = process.getuid?.() === 0;

// ---- planText ----

test("planText: a missing file gets the block alone; an empty one too", () => {
    assert.deepEqual(planText(null), { action: "create", text: `${blockText()}\n` });
    assert.deepEqual(planText(""), { action: "add", text: `${blockText()}\n` });
});

test("planText: a file without a block keeps every byte and gets the block after a blank line", () => {
    const added = planText(OWN);
    assert.equal(added.action, "add");
    assert.equal(added.text, `${OWN}\n${blockText()}\n`);
});

test("planText: a file without a trailing newline gets its last line ended, then the block", () => {
    const text = "# Shop API\nNo newline at the end";
    assert.equal(planText(text).text, `${text}\n\n${blockText()}\n`);
});

test("planText: a CRLF file gets the block in CRLF, and an update keeps CRLF", () => {
    const text = "# Shop API\r\nRun make lint.\r\n";
    const added = planText(text);
    assert.equal(added.text, `${text}\r\n${blockText("\r\n")}\r\n`);
    assert.equal(added.text.replaceAll("\r\n", "").includes("\n"), false);
    assert.deepEqual(planText(added.text), { action: "unchanged", text: added.text });
    const old = added.text.replace("Start every test run", "Start every run");
    assert.deepEqual(planText(old), { action: "update", text: added.text });
});

test("planText: an old block is replaced between the markers and the text around it stays byte for byte", () => {
    const before = "# Shop API\n\nIntro.\n\n", after = "\n## Style\n\nTabs, not spaces.";
    const text = `${before}${BEGIN}\nan old instruction\n${END}${after}`;
    const planned = planText(text);
    assert.equal(planned.action, "update");
    assert.equal(planned.text, `${before}${blockText()}${after}`);
    assert.deepEqual(planText(planned.text), { action: "unchanged", text: planned.text });
    const atStart = planText(`${BEGIN}\nold\n${END}`);
    assert.deepEqual(atStart, { action: "update", text: blockText() });
});

test("planText: a begin marker without an end, two blocks, or an end before the begin is refused", () => {
    for (const text of [`${BEGIN}\nold\n`, `${END}\n${BEGIN}\n`, `${blockText()}\n${blockText()}\n`, `x\n${END}\n`]) {
        assert.match(planText(text).error, /markers do not form one begin and one end/, text);
    }
});

// ---- planFolder and applyPlan ----

test("planFolder: with no agent file, AGENTS.md is the one to create", () => {
    const dir = tempDir("setup-empty");
    const plan = planFolder(dir);
    assert.deepEqual(plan.changes.map((c) => [c.file, c.action]), [["AGENTS.md", "create"]]);
    assert.deepEqual(applyPlan(plan).lines, ["would create AGENTS.md"]);
    assert.deepEqual(readdirSync(dir), []);
});

test("planFolder: a CLAUDE.md that links to AGENTS.md is planned once", () => {
    const dir = tempDir("setup-link");
    writeFileSync(join(dir, "AGENTS.md"), OWN);
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    assert.deepEqual(planFolder(dir).changes.map((c) => [c.file, c.action]), [["AGENTS.md", "add"]]);
});

test("planFolder: an agent file that links outside the project folder is refused", () => {
    const dir = tempDir("setup-outside"), elsewhere = tempDir("setup-elsewhere");
    writeFileSync(join(elsewhere, "notes.md"), OWN);
    symlinkSync(join(elsewhere, "notes.md"), join(dir, "CLAUDE.md"));
    assert.match(planFolder(dir).error, /^CLAUDE\.md: is a link to .*, outside the project folder$/);
    assert.equal(read(elsewhere, "notes.md"), OWN);
});

test("planFolder: a folder that does not exist, and a file in place of a folder, are named", () => {
    const dir = tempDir("setup-missing");
    assert.deepEqual(planFolder(join(dir, "gone")), { error: `${join(dir, "gone")}: no such folder`, folder: true });
    writeFileSync(join(dir, "plain.txt"), "x");
    assert.equal(planFolder(join(dir, "plain.txt")).folder, true);
});

test("applyPlan: a write that fails part way names the file and what was written before it", () => {
    const dir = tempDir("setup-partial");
    writeFileSync(join(dir, "AGENTS.md"), OWN);
    writeFileSync(join(dir, "CLAUDE.md"), OWN);
    let calls = 0;
    const writeFile = (path, text) => {
        if (++calls === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        writeFileSync(path, text);
    };
    const done = applyPlan(planFolder(dir), { write: true, writeFile });
    assert.deepEqual(done, {
        lines: ["added the block to AGENTS.md"], changed: ["AGENTS.md"], error: "CLAUDE.md: cannot be written (ENOSPC)",
    });
});

test("cmdSetup: a removed current folder without --cwd is a usage error", () => {
    const said = [], warned = [];
    const code = cmdSetup(["setup"], {
        cwd: () => { throw new Error("ENOENT"); }, print: (line) => said.push(line), warn: (line) => warned.push(line),
    });
    assert.deepEqual([code, said], [2, []]);
    assert.deepEqual(warned, [
        "the current folder was removed; run setup from a folder that exists, or name one with --cwd <dir>",
    ]);
});

// ---- the command ----

test("setup: a dry run prints what it would do and the block, and changes nothing", () => {
    const dir = tempDir("setup-dry");
    writeFileSync(join(dir, "CLAUDE.md"), OWN);
    const before = tree(dir);
    const ran = cli([], dir);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /^would add the block to CLAUDE\.md$/m);
    assert.match(ran.stdout, /^dry run: nothing was changed; add --write to make these changes/m);
    assert.equal(ran.stdout.includes(blockText()), true);
    assert.deepEqual(tree(dir), before);
    assert.deepEqual(readdirSync(home), []);
});

test("setup --write: creates AGENTS.md when the folder has no agent file", () => {
    const dir = tempDir("setup-create");
    const ran = cli(["--write"], dir);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /^created AGENTS\.md\nchanged: AGENTS\.md$/m);
    assert.equal(read(dir, "AGENTS.md"), `${blockText()}\n`);
    assert.deepEqual(readdirSync(dir), ["AGENTS.md"]);
});

test("setup --write: updates AGENTS.md and CLAUDE.md in place, the rest byte for byte; a rerun changes nothing", () => {
    const dir = tempDir("setup-update");
    const agentsBefore = "# Shop API\r\n\r\nUse pnpm.\r\n", agentsAfter = "\r\n## More\r\nKeep this.";
    writeFileSync(join(dir, "AGENTS.md"), `${agentsBefore}${BEGIN}\r\nold text\r\n${END}${agentsAfter}`);
    writeFileSync(join(dir, "CLAUDE.md"), "Say hello first.");
    const ran = cli(["--write"], dir);
    assert.equal(ran.status, 0, ran.stderr);
    const done = "updated the block in AGENTS.md\nadded the block to CLAUDE.md\nchanged: AGENTS.md, CLAUDE.md\n";
    assert.equal(ran.stdout.endsWith(done), true, ran.stdout);
    assert.equal(read(dir, "AGENTS.md"), `${agentsBefore}${blockText("\r\n")}${agentsAfter}`);
    assert.equal(read(dir, "CLAUDE.md"), `Say hello first.\n\n${blockText()}\n`);
    const after = tree(dir);
    const again = cli(["--write"], dir);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^unchanged: AGENTS\.md\nunchanged: CLAUDE\.md\nchanged: nothing$/m);
    assert.deepEqual(tree(dir), after);
});

test("setup --cwd: works on another folder and leaves the current one alone", () => {
    const here = tempDir("setup-here"), there = tempDir("setup-there");
    const ran = cli(["--write", "--cwd", there], here);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(read(there, "AGENTS.md"), `${blockText()}\n`);
    assert.deepEqual(readdirSync(here), []);
    const missing = cli(["--cwd", join(there, "gone")], here);
    assert.deepEqual([missing.status, missing.stdout], [2, ""]);
    assert.equal(missing.stderr, `dotime-queue: setup: ${join(there, "gone")}: no such folder\n`);
});

const asRoot = { skip: isRoot && "root may write a read-only file" };

test("setup --write: a read-only agent file is named, exit 1, and no other file is written", asRoot, () => {
    const dir = tempDir("setup-readonly");
    writeFileSync(join(dir, "AGENTS.md"), OWN);
    writeFileSync(join(dir, "CLAUDE.md"), OWN);
    chmodSync(join(dir, "CLAUDE.md"), 0o444);
    const ran = cli(["--write"], dir);
    assert.deepEqual([ran.status, ran.stdout], [1, ""]);
    const why = "CLAUDE.md: cannot be written (EACCES); make it writable and run setup again";
    assert.equal(ran.stderr, `dotime-queue: setup: ${why}\n`);
    assert.deepEqual([read(dir, "AGENTS.md"), read(dir, "CLAUDE.md")], [OWN, OWN]);
});

test("setup --write: a read-only project folder with no agent file is named, exit 1", asRoot, () => {
    const dir = tempDir("setup-locked");
    mkdirSync(join(dir, "project"));
    chmodSync(join(dir, "project"), 0o555);
    const ran = cli(["--write", "--cwd", join(dir, "project")], dir);
    chmodSync(join(dir, "project"), 0o755);
    assert.equal(ran.status, 1);
    assert.match(ran.stderr, /cannot create AGENTS\.md in it \(EACCES\)/);
    assert.deepEqual(readdirSync(join(dir, "project")), []);
});

test("setup --mcp: prints the generic entry, the Claude Code command and the form without npm link", () => {
    const dir = tempDir("setup-mcp");
    const ran = cli(["--mcp"], dir);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout.endsWith(`${mcpLines().join("\n")}\n`), true);
    assert.deepEqual(readdirSync(dir), []);
    const lines = mcpLines("/opt/deployontime/mcp/server.mjs");
    const text = lines.join("\n");
    const entry = { mcpServers: { "dotime-queue": { command: "dotime-mcp" } } };
    assert.equal(text.includes(JSON.stringify(entry, null, 2)), true);
    assert.equal(lines.includes("claude mcp add --transport stdio dotime-queue -- dotime-mcp"), true);
    assert.equal(text.includes('"/opt/deployontime/mcp/server.mjs"'), true);
});

test("setup: a misspelled flag, a stray word or a missing value is refused with the usage exit code", () => {
    const dir = tempDir("setup-flags");
    for (const [args, message] of [
        [["--wirte"], "unknown option --wirte"],
        [["--cwd"], "option --cwd needs a value"],
        [["--mcp=yes"], "option --mcp takes no value"],
        [["write"], 'unexpected word "write"'],
    ]) {
        const ran = cli(args, dir);
        assert.deepEqual([ran.status, ran.stdout, ran.stderr], [2, "", `dotime-queue: ${message}\n`], args.join(" "));
    }
    assert.deepEqual(readdirSync(dir), []);
});
