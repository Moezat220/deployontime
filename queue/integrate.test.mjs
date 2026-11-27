// integrate, discard and worktrees end to end: the real cli.mjs in real temp git repositories, after real isolated
// runs. Each test checks what matters most: the user's branch only moves when the check passed, and no job's work is
// lost on the way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv, git, isolateProcess, makeRepo, tempDir, track } from "./testkit.mjs";

isolateProcess("integrate");
const { worktreeLines } = await import("./integrate.mjs");

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url)), NODE = process.execPath;
const WIDE_OPEN = { loadPerCore: 1000, minFreeMemPct: 0, minFreeDiskGB: 0, minBatteryPct: 0 };
const LINES = "one\ntwo\nthree\nfour\nfive\n";
const PASS = [NODE, "-e", "process.exit(0)"];

function sandbox({ config = {} } = {}) {
    const home = tempDir("int-home");
    writeFileSync(join(home, "config.json"), JSON.stringify({ pollMs: 60, ...config, health: WIDE_OPEN, limits: { killGraceMs: 250 } }));
    const repo = makeRepo(join(tempDir("int-repo"), "shop-api"), { "notes.txt": LINES });
    return { home, repo, env: cleanEnv(home) };
}
function cli(box, args, { cwd = box.repo } = {}) {
    const child = track(spawn(NODE, [CLI, ...args], { cwd, env: box.env, stdio: ["ignore", "pipe", "pipe"] }));
    const seen = { stdout: "", stderr: "" };
    child.stdout.on("data", (text) => { seen.stdout += text; });
    child.stderr.on("data", (text) => { seen.stderr += text; });
    return new Promise((resolve) => child.on("close", (code) => resolve({ code, ...seen })));
}
const journal = (box) => readFileSync(join(box.home, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const branches = (repo) => git(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
const head = (repo) => git(repo, "rev-parse", "HEAD").trim();
const status = (repo) => git(repo, "status", "--porcelain");
const worktreeCount = (repo) => git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
/** A node script that sets line n (from 1) of notes.txt, then exits with exit. */
const editLine = (n, text, exit = 0) => [NODE, "-e", `const fs = require("node:fs"); `
    + `const l = fs.readFileSync("notes.txt", "utf8").split("\\n"); l[${n - 1}] = ${JSON.stringify(text)}; `
    + `fs.writeFileSync("notes.txt", l.join("\\n")); process.exit(${exit});`];
/** Runs an isolated job and gives its isolate facts from the journal. */
async function isolated(box, label, command) {
    const ran = await cli(box, ["run", "--isolate", "--label", label, "--", ...command]);
    return { ...journal(box).at(-1).isolate, code: ran.code };
}

test("ACCEPTANCE: two isolated jobs started side by side edit one file; both integrate, and the branch has both edits", async () => {
    const box = sandbox();
    const base = head(box.repo);
    // Each job edits its line, then waits until the other has started too, so the two surely ran at the same time.
    const sideBySide = (n, text) => [NODE, "-e", `const fs = require("node:fs"); `
        + `const l = fs.readFileSync("notes.txt", "utf8").split("\\n"); l[${n - 1}] = ${JSON.stringify(text)}; `
        + `fs.writeFileSync("notes.txt", l.join("\\n")); fs.writeFileSync(${JSON.stringify(join(box.home, "started-"))} + ${n}, "");`
        + `const end = Date.now() + 15000; const t = setInterval(() => { `
        + `const both = [1, 5].every((k) => fs.existsSync(${JSON.stringify(join(box.home, "started-"))} + k)); `
        + `if (both || Date.now() > end) { clearInterval(t); process.exit(both ? 0 : 9); } }, 20);`];
    const [a, b] = await Promise.all([
        cli(box, ["run", "--isolate", "--label", "shop-api: top line", "--", ...sideBySide(1, "ONE")]),
        cli(box, ["run", "--isolate", "--label", "shop-api: bottom line", "--", ...sideBySide(5, "FIVE")]),
    ]);
    assert.deepEqual([a.code, b.code], [0, 0], a.stderr + b.stderr);
    const jobs = journal(box).map((row) => row.isolate);
    const idOf = (label) => journal(box).find((row) => row.label === label).isolate.id;
    assert.equal(jobs.every((job) => job.base === base), true);
    const listed = await cli(box, ["worktrees"]);
    assert.equal(listed.stdout.split("\n").filter(Boolean).length, 2);
    const first = await cli(box, ["integrate", idOf("shop-api: top line"), "--", ...PASS]);
    assert.equal(first.code, 0, first.stderr);
    const second = await cli(box, ["integrate", idOf("shop-api: bottom line"), "--", ...PASS]);
    assert.equal(second.code, 0, second.stderr);
    const landed = new RegExp('^dotime-queue: integrated: dotime/shop-api-bottom-line-[0-9a-f]{8} into master, now at [0-9a-f]{8} '
        + '"dotime: integrate shop-api: bottom line"; removed the job\'s worktree and branch\n$', "m");
    assert.match(second.stderr, landed);
    assert.equal(readFileSync(join(box.repo, "notes.txt"), "utf8"), "ONE\ntwo\nthree\nfour\nFIVE\n");
    assert.deepEqual([branches(box.repo), status(box.repo), worktreeCount(box.repo)], [["master"], "", 1]);
    for (const job of jobs) assert.equal(existsSync(job.worktree), false);
    assert.equal((await cli(box, ["worktrees"])).stdout, "worktrees: none\n");
    assert.equal(git(box.repo, "merge-base", "--is-ancestor", base, "HEAD"), "");
    const labels = journal(box).map((row) => row.label);
    assert.deepEqual(labels.slice(2), ["shop-api: top line: integrate", "shop-api: bottom line: integrate"]);
});

test("integrate: a missing check, an unknown id, a job that did not pass and a word too many are refused with exit 2", async () => {
    const box = sandbox();
    const failed = await isolated(box, "shop-api: edit", editLine(1, "x", 1));
    const cases = [
        [["integrate", failed.id], "integrate: needs the check command after --, such as: dotime-queue integrate <id> -- npm test"],
        [["integrate", "zz", "--", ...PASS], 'integrate: "zz" is not a job id; dotime-queue worktrees lists them'],
        [["integrate", "0badc0de", "--", ...PASS], "integrate: no kept isolated job 0badc0de; dotime-queue worktrees lists them"],
        [["integrate", failed.id, "--", ...PASS], `integrate: job ${failed.id} ended as failed, exit 1; only a job that ended with `
            + `exit 0 is integrated; the job is kept in ${failed.worktree} on branch ${failed.branch}`],
        [["integrate", failed.id, "--now", "--", ...PASS], "integrate: unknown option --now"],
    ];
    for (const [args, text] of cases) {
        const out = await cli(box, args);
        assert.deepEqual([out.code, out.stderr], [2, `dotime-queue: ${text}\n`], args.join(" "));
    }
});

test("integrate: a dirty checkout and the wrong branch are refused, and nothing changes", async () => {
    const box = sandbox();
    const job = await isolated(box, "shop-api: edit", editLine(1, "ONE"));
    const before = head(box.repo);
    writeFileSync(join(box.repo, "scratch.txt"), "draft\n");
    const dirty = await cli(box, ["integrate", job.id, "--", ...PASS]);
    assert.equal(dirty.code, 2);
    assert.match(dirty.stderr, /has 1 uncommitted change; commit or stash your changes first; nothing was changed\n$/);
    rmSync(join(box.repo, "scratch.txt"));
    git(box.repo, "switch", "-q", "-c", "other");
    const wrong = await cli(box, ["integrate", job.id, "--", ...PASS]);
    assert.deepEqual([wrong.code, wrong.stderr], [2, "dotime-queue: integrate: the checkout is on other; the job started on master; "
        + "switch to it with: git switch master\n"]);
    git(box.repo, "switch", "-q", "master");
    assert.deepEqual([head(box.repo), status(box.repo), existsSync(job.worktree), branches(box.repo).includes(job.branch)],
        [before, "", true, true]);
});

test("integrate: a job worktree with uncommitted changes is refused, so they are never left out", async () => {
    const box = sandbox();
    const job = await isolated(box, "shop-api: edit", editLine(1, "ONE"));
    writeFileSync(join(job.worktree, "later.txt"), "x\n");
    const out = await cli(box, ["integrate", job.id, "--", ...PASS]);
    assert.deepEqual([out.code, out.stderr], [2, `dotime-queue: integrate: ${job.worktree} has 1 uncommitted change; commit them on `
        + `${job.branch} there first, or discard the job; nothing was changed\n`]);
});

test("integrate: a conflict aborts the merge; the branch is untouched and the job is kept", async () => {
    const box = sandbox();
    const a = await isolated(box, "shop-api: first", editLine(1, "A"));
    const b = await isolated(box, "shop-api: second", editLine(1, "B"));
    assert.equal((await cli(box, ["integrate", a.id, "--", ...PASS])).code, 0);
    const after = head(box.repo);
    const out = await cli(box, ["integrate", b.id, "--", ...PASS]);
    assert.equal(out.code, 1);
    assert.equal(out.stderr, `dotime-queue: conflict: merging ${b.branch} onto master at ${after.slice(0, 8)} conflicts in notes.txt; `
        + `nothing was changed; the job is kept in ${b.worktree} on branch ${b.branch}\n`);
    assert.deepEqual([head(box.repo), status(box.repo), worktreeCount(box.repo)], [after, "", 2]);
    assert.equal(git(box.repo, "show", `${b.branch}:notes.txt`).split("\n")[0], "B");
    assert.equal(existsSync(b.worktree), true);
});

test("integrate: a failing check passes its exit code on; the branch is untouched and the job is kept", async () => {
    const box = sandbox();
    const job = await isolated(box, "shop-api: edit", editLine(2, "TWO"));
    const before = head(box.repo);
    const out = await cli(box, ["integrate", job.id, "--", NODE, "-e", "console.log('checking'); process.exit(5)"]);
    assert.equal(out.code, 5);
    assert.equal(out.stdout, "checking\n");
    assert.equal(out.stderr, `dotime-queue: integrate: the check ended with exit 5; master was not changed; the job is kept in `
        + `${job.worktree} on branch ${job.branch}\n`);
    assert.deepEqual([head(box.repo), status(box.repo), worktreeCount(box.repo), branches(box.repo).includes(job.branch)],
        [before, "", 2, true]);
    assert.equal(journal(box).at(-1).label, "shop-api: edit: integrate");
});

test("integrate: when the branch moves while the check runs, nothing is changed and it asks to run again", async () => {
    const box = sandbox();
    const job = await isolated(box, "shop-api: edit", editLine(3, "THREE"));
    const moving = [NODE, "-e", `require("node:child_process").execFileSync("git", `
        + `["-C", ${JSON.stringify(box.repo)}, "commit", "-q", "--allow-empty", "-m", "meanwhile"])`];
    const out = await cli(box, ["integrate", job.id, "--", ...moving]);
    assert.equal(out.code, 1, out.stderr);
    assert.match(out.stderr, /^dotime-queue: integrate: master moved from [0-9a-f]{8} while the check ran; nothing was changed; .*run integrate again\n$/);
    assert.equal(git(box.repo, "log", "-1", "--format=%s").trim(), "meanwhile");
    assert.equal(readFileSync(join(box.repo, "notes.txt"), "utf8"), LINES);
    assert.deepEqual([existsSync(job.worktree), branches(box.repo).includes(job.branch), worktreeCount(box.repo)], [true, true, 2]);
    const again = await cli(box, ["integrate", job.id, "--", ...PASS]);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(readFileSync(join(box.repo, "notes.txt"), "utf8").split("\n")[2], "THREE");
});

test("integrate: a job that changed nothing is just removed", async () => {
    const box = sandbox();
    const job = await isolated(box, "shop-api: look", PASS);
    const before = head(box.repo);
    const out = await cli(box, ["integrate", job.id, "--", ...PASS]);
    assert.deepEqual([out.code, out.stderr], [0, `dotime-queue: integrated: ${job.branch} was already in master at `
        + `${before.slice(0, 8)}; removed the job's worktree and branch\n`]);
    assert.deepEqual([head(box.repo), branches(box.repo), existsSync(job.worktree)], [before, ["master"], false]);
});

test("discard: refuses unmerged commits and uncommitted changes without --force, and removes them with it", async () => {
    const box = sandbox();
    const passed = await isolated(box, "shop-api: edit", editLine(1, "ONE"));
    const refused = await cli(box, ["discard", passed.id]);
    assert.deepEqual([refused.code, refused.stderr], [2, `dotime-queue: discard: branch ${passed.branch} has 1 commit not in master; `
        + "nothing was removed; add --force to remove them anyway\n"]);
    assert.equal(existsSync(passed.worktree), true);
    const failed = await isolated(box, "shop-api: other", editLine(2, "TWO", 1));
    const dirty = await cli(box, ["discard", failed.id]);
    assert.deepEqual([dirty.code, dirty.stderr], [2, `dotime-queue: discard: ${failed.worktree} has 1 uncommitted change; `
        + "nothing was removed; add --force to remove them anyway\n"]);
    for (const job of [passed, failed]) {
        const out = await cli(box, ["discard", job.id, "--force"]);
        assert.deepEqual([out.code, out.stderr], [0, `dotime-queue: discarded: job ${job.id}; removed ${job.worktree} and branch ${job.branch}\n`]);
        assert.equal(existsSync(job.worktree), false);
    }
    assert.deepEqual([branches(box.repo), worktreeCount(box.repo), status(box.repo)], [["master"], 1, ""]);
    assert.equal((await cli(box, ["discard", "--force"])).code, 2);
});

test("discard: a worktree folder that was deleted by hand is pruned, and its branch removed", async () => {
    const box = sandbox();
    const job = await isolated(box, "shop-api: look", PASS);
    rmSync(job.worktree, { recursive: true, force: true });
    const out = await cli(box, ["discard", job.id]);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual([branches(box.repo), worktreeCount(box.repo)], [["master"], 1]);
});

test("worktrees: one line per kept job with its outcome and age, or none", async () => {
    const box = sandbox();
    assert.deepEqual(await cli(box, ["worktrees"]), { code: 0, stdout: "worktrees: none\n", stderr: "" });
    const job = await isolated(box, "shop-api: edit", editLine(1, "x", 3));
    const out = await cli(box, ["worktrees"]);
    assert.equal(out.stdout, `worktree ${job.id}: "shop-api: edit", branch ${job.branch}, folder ${job.worktree}, failed, exit 3, 0 min old\n`);
    assert.equal((await cli(box, ["worktrees", "--all"])).code, 2);
});

test("worktreeLines: a job still marked running whose process is gone ended without a result", () => {
    const state = { id: "0a1b2c3d", label: "docs: build", branch: "dotime/docs-build-0a1b2c3d", worktree: "/nowhere/docs-0a1b2c3d" };
    const lines = worktreeLines([{ ...state, outcome: "running", pid: 99, createdAt: 0, exit: null }], 12 * 60_000, () => false);
    assert.deepEqual(lines, ['worktree 0a1b2c3d: "docs: build", branch dotime/docs-build-0a1b2c3d, folder /nowhere/docs-0a1b2c3d, '
        + "folder missing, ended without a result, 12 min old"]);
});
