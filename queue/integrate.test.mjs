// integrate, discard and worktrees end to end: the real cli.mjs in real temp git repositories, after real isolated
// runs. Each test checks what matters most: the user's branch only moves when the check passed, and no job's work is
// lost on the way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv, git, isolateProcess, makeRepo, tempDir, track } from "./testkit.mjs";
import { bootId, startTicks } from "./linux.mjs";

isolateProcess("integrate");
const { cmdDiscard, cmdIntegrate, fastForward, worktreeLines } = await import("./integrate.mjs");
const { gitRun, worktreesDir } = await import("./worktree.mjs");

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url)), NODE = process.execPath;
const WIDE_OPEN = { loadPerCore: 1000, minFreeMemPct: 0, minFreeDiskGB: 0, minBatteryPct: 0 };
const LINES = "one\ntwo\nthree\nfour\nfive\n";
const PASS = [NODE, "-e", "process.exit(0)"];

function sandbox({ config = {}, files = {} } = {}) {
    const home = tempDir("int-home");
    writeFileSync(join(home, "config.json"), JSON.stringify({ pollMs: 60, ...config, health: WIDE_OPEN, limits: { killGraceMs: 250 } }));
    const repo = makeRepo(join(tempDir("int-repo"), "shop-api"), { "notes.txt": LINES, ...files });
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

test("discard: a worktree folder that was deleted by hand is forgotten by git, and its branch removed", async () => {
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
    const asked = [];
    worktreeLines([{ ...state, outcome: "running", pid: 99, born: 5, ticks: 91_000, boot: "b", createdAt: 0 }], 0, (...args) => asked.push(args));
    assert.deepEqual(asked, [[99, 5, { ticks: 91_000, boot: "b" }]], "the ticks and boot of the job are passed on");
});

/** A node script that writes each file of files (path to text), making folders, then exits 0. */
const writeFiles = (files) => [NODE, "-e", `const fs = require("node:fs"), path = require("node:path"); `
    + `for (const [f, t] of Object.entries(${JSON.stringify(files)})) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); }`];
const stateOf = (box, id) => join(box.home, "worktrees", `${id}.json`);
const editState = (box, id, change) => writeFileSync(stateOf(box, id), JSON.stringify({ ...JSON.parse(readFileSync(stateOf(box, id), "utf8")), ...change }));
const commonDir = (repo) => git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
const MY_BORN = Math.round(Date.now() - process.uptime() * 1000);
/** The pid of a process that has ended. */
async function deadPid() {
    const child = spawn(NODE, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => child.on("close", resolve));
    return child.pid;
}

test("integrate and discard never forget a user's own worktree whose folder was moved away, nor its staged changes", async () => {
    const box = sandbox();
    const side = join(realpathSync(dirname(box.repo)), "side"), away = join(dirname(box.repo), "side-away");
    git(box.repo, "worktree", "add", "-q", "-b", "side", side);
    writeFileSync(join(side, "staged.txt"), "kept\n");
    git(side, "add", "staged.txt");
    renameSync(side, away);
    const admin = join(commonDir(box.repo), "worktrees", "side");
    const index = readFileSync(join(admin, "index"));
    const a = await isolated(box, "shop-api: edit", editLine(1, "ONE"));
    const b = await isolated(box, "shop-api: other", editLine(2, "TWO"));
    const c = await isolated(box, "shop-api: look", PASS);
    rmSync(c.worktree, { recursive: true, force: true });
    assert.equal((await cli(box, ["integrate", a.id, "--", ...PASS])).code, 0);
    assert.equal((await cli(box, ["discard", b.id, "--force"])).code, 0);
    assert.equal((await cli(box, ["discard", c.id])).code, 0);
    assert.deepEqual([existsSync(admin), readFileSync(join(admin, "index")).equals(index)], [true, true]);
    assert.match(git(box.repo, "worktree", "list", "--porcelain"), new RegExp(`^worktree ${side}$`, "m"));
    assert.equal(worktreeCount(box.repo), 2);
    renameSync(away, side);
    assert.equal(git(side, "status", "--porcelain"), "A  staged.txt\n");
});

test("fastForward: when git reports a failure but HEAD is at the commit after all, it counts as done", () => {
    const box = sandbox();
    const before = head(box.repo);
    git(box.repo, "switch", "-q", "-c", "ahead");
    git(box.repo, "commit", "-q", "--allow-empty", "-m", "ahead");
    const target = head(box.repo);
    git(box.repo, "switch", "-q", "master");
    const failsAfter = (top, args, opts) => ({ ...gitRun(top, args, opts), ok: false, code: 1, stderr: "error: a hook said no" });
    const failsBefore = () => ({ ok: false, code: 1, stdout: "", stderr: "error: a hook said no" });
    assert.deepEqual(fastForward(box.repo, target, { env: box.env, run: failsBefore }), { ok: false, error: "error: a hook said no", now: before });
    assert.deepEqual(fastForward(box.repo, target, { env: box.env, run: failsAfter }), { ok: true });
    assert.equal(head(box.repo), target);
});

test("worktrees, integrate and discard remove a temporary integrate worktree whose process is gone, and keep a live one", async () => {
    const box = sandbox();
    const dir = join(box.home, "worktrees");
    mkdirSync(dir, { recursive: true });
    const plant = (pid, born) => {
        const name = `0a1b2c3d-integrate-${pid}-${born === MY_BORN ? "11111111" : "22222222"}`;
        git(box.repo, "worktree", "add", "-q", "--detach", join(dir, name), "HEAD");
        writeFileSync(join(dir, `${name}.owner.json`), JSON.stringify({ pid, born, top: box.repo, job: "0a1b2c3d" }));
        return join(dir, name);
    };
    const dead = plant(await deadPid(), MY_BORN - 1000);
    const live = plant(process.pid, MY_BORN);
    const reused = join(dir, `0a1b2c3d-integrate-${process.pid}-33333333`);
    git(box.repo, "worktree", "add", "-q", "--detach", reused, "HEAD");
    writeFileSync(`${reused}.owner.json`, JSON.stringify({ pid: process.pid, born: MY_BORN - 3_600_000, top: box.repo, job: "0a1b2c3d" }));
    assert.equal(worktreeCount(box.repo), 4);
    assert.deepEqual(await cli(box, ["worktrees"]), { code: 0, stdout: "worktrees: none\n", stderr: "" });
    assert.deepEqual([existsSync(dead), existsSync(`${dead}.owner.json`), existsSync(reused), existsSync(live)], [false, false, false, true]);
    assert.equal(worktreeCount(box.repo), 2);
    const job = await isolated(box, "shop-api: look", PASS);
    const again = plant(await deadPid(), MY_BORN);
    assert.equal((await cli(box, ["discard", job.id])).code, 0);
    assert.deepEqual([existsSync(again), existsSync(live), worktreeCount(box.repo)], [false, true, 2]);
});

test("a folder named like a temporary integrate worktree stays when it has no owner file or one that names another job", async () => {
    const box = sandbox();
    const dir = join(box.home, "worktrees");
    mkdirSync(dir, { recursive: true });
    const dead = await deadPid();
    const bare = join(dir, `abcdef12-integrate-${dead}-0a1b2c3d`);
    const other = join(dir, `abcdef12-integrate-${dead}-4e5f6a7b`);
    for (const folder of [bare, other]) git(box.repo, "worktree", "add", "-q", "--detach", folder, "HEAD");
    writeFileSync(join(bare, "work.txt"), "not committed\n");
    writeFileSync(`${other}.owner.json`, JSON.stringify({ pid: dead, born: MY_BORN - 1000, top: box.repo, job: "99999999" }));
    assert.equal((await cli(box, ["worktrees"])).code, 0);
    assert.deepEqual([existsSync(join(bare, "work.txt")), existsSync(other), worktreeCount(box.repo)], [true, true, 3]);
});

test("discard: commits that git cannot count are an issue, not 0 commits ahead; --force still removes the job", async () => {
    const box = sandbox();
    const job = await isolated(box, "shop-api: edit", editLine(1, "ONE"));
    editState(box, job.id, { baseBranch: "gone-away", base: "f".repeat(40) });
    const out = await cli(box, ["discard", job.id]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, new RegExp(`^dotime-queue: discard: the commits of branch ${job.branch} not in gone-away could not be counted: `
        + ".+; nothing was removed; add --force to remove them anyway\n$"));
    assert.equal(existsSync(job.worktree), true);
    assert.equal((await cli(box, ["discard", job.id, "--force"])).code, 0);
    assert.deepEqual([existsSync(job.worktree), branches(box.repo)], [false, ["master"]]);
});

test("integrate: ignored files the job made are removed with its folder, and the end line counts them", async () => {
    const box = sandbox({ files: { ".gitignore": ".env\nlogs/\n" } });
    const job = await isolated(box, "shop-api: edit", [...writeFiles({ ".env": "TOKEN=x\n", "logs/a.log": "a\n", "notes.txt": "new\n" })]);
    const out = await cli(box, ["integrate", job.id, "--", ...PASS]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stderr, /; removed the job's worktree and branch; removed 2 ignored files from the job folder\n$/);
    assert.equal(existsSync(job.worktree), false);
});

test("run --isolate: a node_modules folder, also one git does not ignore, and isolateLinks paths are never committed", async () => {
    const box = sandbox({ config: { isolateLinks: ["cache"] } });
    const job = await isolated(box, "shop-api: install", writeFiles({
        "node_modules/pkg/index.js": "x\n", "web/node_modules/b.js": "y\n", "cache/c.bin": "z\n", "notes.txt": "new\n",
    }));
    assert.equal(job.code, 0);
    assert.equal(git(box.repo, "show", "--name-only", "--format=", job.branch), "notes.txt\n");
    assert.equal(git(box.repo, "ls-tree", "-r", "--name-only", job.branch), "notes.txt\n");
    const out = await cli(box, ["integrate", job.id, "--", ...PASS]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stderr, /; removed 3 ignored files from the job folder\n$/);
    assert.deepEqual([readFileSync(join(box.repo, "notes.txt"), "utf8"), status(box.repo), existsSync(job.worktree)], ["new\n", "", false]);
});

test("discard: a job still marked running whose pid now names a process that started later is not running", async () => {
    const box = sandbox();
    const job = await isolated(box, "shop-api: look", PASS);
    // The state names this test process, with its own start in clock ticks and boot on Linux (both null elsewhere).
    const ticks = startTicks(process.pid);
    editState(box, job.id, { outcome: "running", exit: null, pid: process.pid, born: MY_BORN, ticks, boot: bootId() });
    const busy = await cli(box, ["discard", job.id, "--force"]);
    assert.deepEqual([busy.code, busy.stderr], [2, `dotime-queue: discard: job ${job.id} is still running, pid ${process.pid}\n`]);
    editState(box, job.id, { born: MY_BORN - 3_600_000, ticks: ticks === null ? null : ticks - 1 });
    const out = await cli(box, ["discard", job.id]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(existsSync(job.worktree), false);
});

test("integrate: the owner file of its temporary worktree keeps the start marks of the process, ticks and boot", async () => {
    const box = sandbox();
    const job = await isolated(box, "shop-api: edit", editLine(2, "TWO"));
    const marks = { ticks: 41_000, boot: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b" };
    const owners = [];
    const run = async () => {
        const dir = worktreesDir(box.home);
        for (const name of readdirSync(dir).filter((n) => n.endsWith(".owner.json"))) owners.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
        return 0;
    };
    const said = [];
    const code = await cmdIntegrate(["integrate", job.id, "--", ...PASS], { settings: {}, files: { home: box.home }, cwd: box.repo },
        { say: (text) => said.push(text), run, env: box.env, marks });
    assert.equal(code, 0, said.join("\n"));
    assert.equal(owners.length, 1);
    assert.deepEqual([owners[0].pid, owners[0].ticks, owners[0].boot], [process.pid, marks.ticks, marks.boot]);
});

test("discard: the running check is given the ticks and boot the job state keeps", async () => {
    const box = sandbox();
    const job = await isolated(box, "shop-api: look", PASS);
    const kept = { ticks: 63_000, boot: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d" };
    editState(box, job.id, { outcome: "running", exit: null, pid: 4300, born: MY_BORN, ...kept });
    const asked = [], said = [];
    const same = (pid, born, marks) => { asked.push([pid, born, marks]); return true; };
    const code = cmdDiscard(["discard", job.id, "--force"], { files: { home: box.home } }, { say: (text) => said.push(text), env: box.env, same });
    assert.deepEqual([code, said], [2, [`discard: job ${job.id} is still running, pid 4300`]]);
    assert.deepEqual(asked, [[4300, MY_BORN, kept]]);
});

test("integrate and discard never touch what an isolateLinks link points to", async () => {
    const box = sandbox({ config: { isolateLinks: ["node_modules"] }, files: { ".gitignore": "node_modules/\n" } });
    const pkg = join(box.repo, "node_modules", "pkg", "index.js");
    mkdirSync(dirname(pkg), { recursive: true });
    writeFileSync(pkg, "module.exports = 1;\n");
    const useIt = [NODE, "-e", "process.exit(require('./node_modules/pkg/index.js') === 1 ? 0 : 7)"];
    const edit = "require('./node_modules/pkg/index.js'); require('node:fs').writeFileSync('notes.txt', 'a\\n')";
    const a = await isolated(box, "shop-api: edit", [NODE, "-e", edit]);
    const b = await isolated(box, "shop-api: other", editLine(2, "TWO"));
    assert.deepEqual([a.code, b.code], [0, 0]);
    const landed = await cli(box, ["integrate", a.id, "--", ...useIt]);
    assert.equal(landed.code, 0, landed.stderr);
    assert.equal((await cli(box, ["discard", b.id, "--force"])).code, 0);
    assert.deepEqual([existsSync(join(box.repo, "node_modules")), readFileSync(pkg, "utf8")], [true, "module.exports = 1;\n"]);
    assert.deepEqual([status(box.repo), existsSync(a.worktree), existsSync(b.worktree)], ["", false, false]);
});

test("two integrates started at the same time: one lands, the other lands after it or asks to run again; nothing is lost", async () => {
    const box = sandbox();
    const a = await isolated(box, "shop-api: top", editLine(1, "ONE"));
    const b = await isolated(box, "shop-api: bottom", editLine(5, "FIVE"));
    const slow = [NODE, "-e", "setTimeout(() => process.exit(0), 300)"];
    const results = await Promise.all([a, b].map((job) => cli(box, ["integrate", job.id, "--", ...slow])));
    for (const out of results) {
        assert.ok(out.code === 0 || (out.code === 1 && /run integrate again\n$/.test(out.stderr)), out.stderr);
    }
    assert.ok(results.some((out) => out.code === 0), results.map((out) => out.stderr).join(""));
    assert.equal(status(box.repo), "");
    for (const [job, out] of [[a, results[0]], [b, results[1]]]) {
        if (out.code === 0) continue;
        assert.equal(branches(box.repo).includes(job.branch), true);
        const again = await cli(box, ["integrate", job.id, "--", ...PASS]);
        assert.equal(again.code, 0, again.stderr);
    }
    assert.equal(readFileSync(join(box.repo, "notes.txt"), "utf8"), "ONE\ntwo\nthree\nfour\nFIVE\n");
    assert.deepEqual([branches(box.repo), status(box.repo), worktreeCount(box.repo)], [["master"], "", 1]);
});
