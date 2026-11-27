// Isolated runs end to end: the real cli.mjs in real temp git repositories, and the worktree module on its own for
// the parts a command line cannot steer, such as the id that is picked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv, git, isolateProcess, makeRepo, tempDir, track } from "./testkit.mjs";

isolateProcess("worktree");
const { labelSlug, makeWorktree, prepareIsolate, readState } = await import("./worktree.mjs");
const { takeSlot } = await import("./slots.mjs");

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url)), NODE = process.execPath;
const WIDE_OPEN = { loadPerCore: 1000, minFreeMemPct: 0, minFreeDiskGB: 0, minBatteryPct: 0 };
const LINES = "one\ntwo\nthree\nfour\nfive\n";

function sandbox({ config = {}, files = { "notes.txt": LINES }, env = {} } = {}) {
    const home = tempDir("iso-home");
    writeFileSync(join(home, "config.json"), JSON.stringify({ pollMs: 60, ...config, health: WIDE_OPEN, limits: { killGraceMs: 250 } }));
    const repo = makeRepo(join(tempDir("iso-repo"), "shop-api"), files);
    return { home, repo, env: cleanEnv(home, env) };
}
function start(box, args, { cwd = box.repo, env = box.env } = {}) {
    const child = track(spawn(NODE, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] }));
    const seen = { stdout: "", stderr: "" };
    child.stdout.on("data", (text) => { seen.stdout += text; });
    child.stderr.on("data", (text) => { seen.stderr += text; });
    return new Promise((resolve) => child.on("close", (code) => resolve({ code, ...seen })));
}
const journal = (box) => {
    try {
        return readFileSync(join(box.home, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
};
const worktreeFolders = (box) => { try { return readdirSync(join(box.home, "worktrees")); } catch { return []; } };
const branches = (repo) => git(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
const head = (repo) => git(repo, "rev-parse", "HEAD").trim();
const status = (repo) => git(repo, "status", "--porcelain");
/** A node script that sets line n (from 1) of notes.txt, in the folder it runs in. */
const editLine = (n, text, exit = 0) => [NODE, "-e", `const fs = require("node:fs"); `
    + `const l = fs.readFileSync("notes.txt", "utf8").split("\\n"); l[${n - 1}] = ${JSON.stringify(text)}; `
    + `fs.writeFileSync("notes.txt", l.join("\\n")); process.exit(${exit});`];
const lastIsolate = (box) => journal(box).at(-1).isolate;

test("labelSlug: lowercase letters, digits and dashes, at most 40 characters, job without a label", () => {
    assert.equal(labelSlug("Shop-API: Rename the Price Field!"), "shop-api-rename-the-price-field");
    assert.equal(labelSlug("unnamed"), "job");
    assert.equal(labelSlug(":::"), "job");
    assert.equal(labelSlug(`docs: ${"x".repeat(60)}`).length, 40);
    assert.equal(labelSlug("a: b                                    c"), "a-b-c");
});

test("run without --isolate: the journal line has no isolate field and no worktree is made", async () => {
    const box = sandbox();
    const ran = await start(box, ["run", "--label", "shop-api: build", "--", NODE, "-e", "console.log('built')"]);
    assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, "built\n", ""]);
    assert.equal("isolate" in journal(box)[0], false);
    assert.deepEqual(worktreeFolders(box), []);
});

test("run --isolate: refused with exit 2 outside git, before the first commit and in a dirty tree; nothing is started", async () => {
    const box = sandbox();
    const plain = tempDir("iso-plain");
    const outside = await start(box, ["run", "--isolate", "--", NODE, "-e", ""], { cwd: plain });
    assert.equal(outside.code, 2);
    assert.equal(outside.stderr, `dotime-queue: --isolate needs a git repository; ${realpathSync(plain)} is not in one; `
        + "run it in a git checkout; nothing was started\n");
    const empty = tempDir("iso-empty");
    git(empty, "init", "-q");
    const noCommit = await start(box, ["run", "--isolate", "--", NODE, "-e", ""], { cwd: empty });
    assert.deepEqual([noCommit.code, noCommit.stderr],
        [2, "dotime-queue: --isolate needs a commit to start from; the repository has none yet; nothing was started\n"]);
    writeFileSync(join(box.repo, "notes.txt"), "changed\n");
    writeFileSync(join(box.repo, "draft.txt"), "new\n");
    const dirty = await start(box, ["run", "--isolate", "--label", "shop-api: edit", "--", NODE, "-e", ""]);
    assert.equal(dirty.code, 2);
    assert.equal(dirty.stderr, `dotime-queue: --isolate needs a clean working tree; ${realpathSync(box.repo)} has 2 uncommitted `
        + "changes or untracked files; commit or stash your changes first; nothing was started\n");
    assert.deepEqual([journal(box), worktreeFolders(box), branches(box.repo)], [[], [], ["master"]]);
});

test("run --isolate: the edits land on a new branch in a worktree of their own; the checkout is left as it was", async () => {
    const box = sandbox({ files: { "notes.txt": LINES, "web/page.txt": "page\n" } });
    const before = head(box.repo);
    // From a subfolder: the command starts in the same subfolder of the worktree.
    const ran = await start(box, ["run", "--isolate", "--label", "shop-api: rename field", "--", NODE, "-e",
        "require('node:fs').writeFileSync('page.txt', 'new page\\n'); console.log(process.cwd())"], { cwd: join(box.repo, "web") });
    assert.equal(ran.code, 0, ran.stderr);
    const iso = lastIsolate(box);
    assert.match(iso.id, /^[0-9a-f]{8}$/);
    const folder = join(box.home, "worktrees", `shop-api-${iso.id}`);
    assert.deepEqual(iso, { id: iso.id, branch: `dotime/shop-api-rename-field-${iso.id}`, worktree: folder, base: before, baseBranch: "master" });
    assert.equal(realpathSync(ran.stdout.trim()), realpathSync(join(folder, "web")));
    const commit = git(folder, "rev-parse", "HEAD").trim();
    assert.equal(ran.stderr, `dotime-queue: committed: 1 change on branch ${iso.branch} as ${commit.slice(0, 8)} "dotime: shop-api: rename field"\n`
        + `dotime-queue: isolated in ${folder} on branch ${iso.branch}; integrate with: dotime-queue integrate ${iso.id} -- <check>\n`);
    assert.equal(git(folder, "show", `${iso.branch}:web/page.txt`), "new page\n");
    assert.equal(git(folder, "rev-parse", `${iso.branch}~1`).trim(), before);
    assert.deepEqual([head(box.repo), status(box.repo), git(box.repo, "branch", "--show-current").trim()], [before, "", "master"]);
    assert.equal(readFileSync(join(box.repo, "web/page.txt"), "utf8"), "page\n");
    const row = journal(box)[0];
    assert.deepEqual([row.outcome, row.exit, row.head, row.clean, realpathSync(row.cwd)], ["ran", 0, before, true, realpathSync(join(box.repo, "web"))]);
    assert.equal(readState(box.home, iso.id).outcome, "passed");
});

test("run --isolate: a command that commits its own work leaves nothing more to commit", async () => {
    const box = sandbox();
    const script = "const { execFileSync: x } = require('node:child_process'); require('node:fs').writeFileSync('extra.txt', 'x\\n'); "
        + "x('git', ['add', 'extra.txt']); x('git', ['commit', '-q', '-m', 'add extra']);";
    const ran = await start(box, ["run", "--isolate", "--label", "shop-api: extra", "--", NODE, "-e", script]);
    const iso = lastIsolate(box);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stderr, `dotime-queue: isolated in ${iso.worktree} on branch ${iso.branch}; integrate with: `
        + `dotime-queue integrate ${iso.id} -- <check>\n`);
    assert.equal(git(box.repo, "log", "-1", "--format=%s", iso.branch).trim(), "add extra");
});

test("run --isolate: on a detached HEAD the job starts from the commit, with baseBranch null", async () => {
    const box = sandbox();
    git(box.repo, "checkout", "-q", "--detach");
    const ran = await start(box, ["run", "--isolate", "--label", "shop-api: try", "--", ...editLine(1, "ONE")]);
    assert.equal(ran.code, 0, ran.stderr);
    const iso = lastIsolate(box);
    assert.deepEqual([iso.base, iso.baseBranch], [head(box.repo), null]);
    assert.equal(status(box.repo), "");
});

test("run --isolate: a failed job keeps its worktree with the changes uncommitted, and says how to remove it", async () => {
    const box = sandbox();
    const ran = await start(box, ["run", "--isolate", "--label", "shop-api: edit", "--", ...editLine(2, "TWO", 3)]);
    assert.equal(ran.code, 3);
    const iso = lastIsolate(box);
    assert.equal(ran.stderr, `dotime-queue: kept ${iso.worktree} on branch ${iso.branch} for a look; remove it with: `
        + `dotime-queue discard ${iso.id}\n`);
    assert.equal(status(iso.worktree), " M notes.txt\n");
    assert.equal(git(box.repo, "rev-parse", iso.branch).trim(), head(box.repo));
    assert.deepEqual([readState(box.home, iso.id).outcome, readState(box.home, iso.id).exit], ["failed", 3]);
});

test("run --isolate: a job that gives up waiting leaves no worktree, no branch and no state behind", async () => {
    const box = sandbox({ config: { slots: 1 } });
    takeSlot(process.pid, "shop-api: build", 1, {}, { slots: join(box.home, "slots"), waitingLine: join(box.home, "line") });
    const ran = await start(box, ["run", "--isolate", "--max-wait", "0.005", "--label", "shop-api: edit", "--", ...editLine(1, "x")]);
    assert.equal(ran.code, 75);
    assert.deepEqual([journal(box).map((r) => r.outcome), worktreeFolders(box), branches(box.repo)], [["gave-up"], [], ["master"]]);
    assert.equal("isolate" in journal(box)[0], false);
});

test("run --isolate: fail-stop and the flaky flag count isolated runs as runs of the checkout's own check", async () => {
    const box = sandbox();
    const args = ["run", "--isolate", "--label", "shop-api: price check", "--"];
    const fail = [NODE, "-e", "process.exit(4)"];
    assert.equal((await start(box, [...args, NODE, "-e", "process.exit(0)"])).code, 0);
    const first = await start(box, [...args, ...fail]);
    assert.equal(first.code, 4);
    assert.match(first.stderr, /^dotime-queue: flaky: this check passed and failed on the same commit/m);
    assert.equal((await start(box, [...args, ...fail])).code, 4);
    const kept = worktreeFolders(box).length;
    const refused = await start(box, [...args, ...fail]);
    assert.equal(refused.code, 3);
    assert.match(refused.stderr, /^dotime-queue: refused: exit 3; same check failed twice on unchanged code: "shop-api: price check"/);
    assert.equal(worktreeFolders(box).length, kept, "a refused job makes no worktree");
    // A plain run of the same check in the checkout is refused as well: it is the same check.
    assert.equal((await start(box, ["run", "--label", "shop-api: price check", "--", ...fail])).code, 3);
});

test("run --isolate: a pass in a worktree is no pass stamp for the checkout", async () => {
    const box = sandbox();
    const check = ["--label", "shop-api: unit tests", "--kind", "test", "--", NODE, "-e", "console.log('ran')"];
    assert.equal((await start(box, ["run", "--isolate", ...check])).code, 0);
    const plain = await start(box, ["run", ...check]);
    assert.deepEqual([plain.code, plain.stdout], [0, "ran\n"]);
});

test("run --isolate: isolateLinks links ignored paths of the checkout; the links are never committed", async () => {
    const box = sandbox({
        config: { isolateLinks: ["node_modules", "tracked.txt", "missing"] },
        files: { "notes.txt": LINES, ".gitignore": "node_modules/\n", "tracked.txt": "t\n" },
    });
    mkdirSync(join(box.repo, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(box.repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    const script = "console.log(require('./node_modules/left-pad/index.js')); require('node:fs').writeFileSync('notes.txt', 'x\\n')";
    const ran = await start(box, ["run", "--isolate", "--label", "shop-api: pad", "--", NODE, "-e", script]);
    assert.deepEqual([ran.code, ran.stdout], [0, "1\n"], ran.stderr);
    const iso = lastIsolate(box);
    assert.equal(lstatSync(join(iso.worktree, "node_modules")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(iso.worktree, "tracked.txt")).isSymbolicLink(), false, "a tracked file is never linked");
    assert.equal(existsSync(join(iso.worktree, "missing")), false);
    assert.equal(git(box.repo, "show", "--name-only", "--format=", iso.branch), "notes.txt\n");
    assert.deepEqual(readState(box.home, iso.id).links, ["node_modules"]);
});

test("run --isolate: without a git name and e-mail the changes stay uncommitted, and a line says so", async () => {
    const box = sandbox();
    const env = Object.fromEntries(Object.entries(box.env).filter(([name]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(name) && name !== "EMAIL"));
    const ran = await start(box, ["run", "--isolate", "--label", "shop-api: edit", "--", ...editLine(1, "x")], { env });
    assert.equal(ran.code, 0);
    const iso = lastIsolate(box);
    assert.equal(ran.stderr, `dotime-queue: not committed: git has no user.name and user.email for ${realpathSync(box.repo)}; `
        + `the 1 change stays uncommitted in ${iso.worktree}\n`
        + `dotime-queue: isolated in ${iso.worktree} on branch ${iso.branch}; integrate with: dotime-queue integrate ${iso.id} -- <check>\n`);
    assert.equal(status(iso.worktree), " M notes.txt\n");
});

test("makeWorktree: a branch, folder or state file that is already there makes it pick a new id", () => {
    const home = tempDir("iso-ids"), repo = makeRepo(join(tempDir("iso-ids-repo"), "docs-site"));
    git(repo, "branch", "dotime/docs-site-build-aaaaaaaa");
    mkdirSync(join(home, "worktrees", "docs-site-bbbbbbbb"), { recursive: true });
    writeFileSync(join(home, "worktrees", "cccccccc.json"), "{}");
    const ids = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd"];
    const { checkout } = prepareIsolate(repo);
    const made = makeWorktree({ label: "docs-site: build", checkout, home, links: [], pid: 1, command: "make", now: 0 },
        { id: () => ids.shift() });
    assert.equal(made.state.id, "dddddddd");
    assert.equal(made.state.branch, "dotime/docs-site-build-dddddddd");
    const none = makeWorktree({ label: "docs-site: build", checkout, home, links: [], pid: 1, command: "make", now: 0 },
        { id: () => "aaaaaaaa" });
    assert.deepEqual(none, { error: "no free id for the worktree after 8 tries" });
});
