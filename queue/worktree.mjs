// Isolated runs: a job that runs in a linked git worktree of its own, on a new branch, so that jobs started side by
// side never edit the same files. This module holds the git calls that make, look at and remove those worktrees,
// the state file kept per job in $DOTIME_HOME/worktrees, the links named in isolateLinks, and the two steps `run
// --isolate` takes around its job: prepareIsolate before the job joins the line, and the start and finish of the
// returned job once it holds its slot. It never changes the user's own checkout: the one step that does is
// `integrate`, in integrate.mjs.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "./files.mjs";
import { porcelainClean, readOnlyGit, repoName } from "./git.mjs";
import { UNLABELLED } from "./kinds.mjs";
import { sameProcess } from "./proctree.mjs";

/** How many new ids a job tries when its branch or folder is already there. */
export const ID_TRIES = 8;
export const ID_RE = /^[0-9a-f]{8}$/;
/** The timeout of a git step that runs the repository's hooks or changes files: none, as a step stopped halfway
 *  could leave a half-made commit, merge or worktree behind. */
export const NO_LIMIT = 0;
// When this process started (wall clock, ms), kept with a job so a later process given the same pid is told apart.
export const BORN = Math.round(Date.now() - process.uptime() * 1000);

/** Runs `git -C <cwd> <args>` and returns { ok, code, stdout, stderr }; unlike git() in git.mjs it may change the
 *  repository and it keeps git's own error text. No watcher program named in the repository's settings is started. */
export function gitRun(cwd, args, { env = process.env, timeout = 120_000 } = {}) {
    try {
        const limit = timeout > 0 ? { timeout } : {};
        const ran = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...limit, env: readOnlyGit(env) });
        const stderr = (ran.stderr ?? "").trim() || (ran.error ? ran.error.message : "");
        return { ok: ran.status === 0, code: ran.status, stdout: ran.stdout ?? "", stderr };
    } catch (e) {
        return { ok: false, code: null, stdout: "", stderr: e.message };
    }
}

/** The first line of git's error text, for a message. */
export const gitError = (ran) => ran.stderr.split("\n").find((line) => line.trim()) ?? `git exit ${ran.code}`;

/** A label as part of a branch name: lowercase letters, digits and single dashes, at most 40 characters; "job" for
 *  an unlabelled job or a label with none of those. */
export function labelSlug(label) {
    if (!label || label === UNLABELLED) return "job";
    const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
    return slug || "job";
}

/** A repository folder name as part of a folder name. */
const folderSafe = (name) => String(name).replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";

/** A fresh id: 8 hex digits. */
export const newId = (bytes = randomBytes) => bytes(4).toString("hex");

/** The folder that holds the worktrees and their state files. */
export const worktreesDir = (home) => join(home, "worktrees");
export const stateFile = (home, id) => join(worktreesDir(home), `${id}.json`);

/** The state of an isolated job, or null. */
export function readState(home, id) {
    if (!ID_RE.test(id)) return null;
    const state = readJson(stateFile(home, id));
    return state && state.id === id ? state : null;
}
export const writeState = (home, state) => writeJsonAtomic(stateFile(home, state.id), state, 2);
export const dropState = (home, id) => rmSync(stateFile(home, id), { force: true });

/** Every kept isolated job, oldest first. */
export function listStates(home) {
    let names = [];
    try { names = readdirSync(worktreesDir(home)); } catch { return []; }
    return names.filter((name) => /^[0-9a-f]{8}\.json$/.test(name))
        .map((name) => readState(home, name.slice(0, 8))).filter(Boolean)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** The facts about the checkout a folder is in: { top, prefix (the folder below top, "" or ending in "/"), common
 *  (the shared git folder), head, branch (null on a detached HEAD), repo }, or { error } outside git or before the
 *  first commit. */
export function checkoutOf(cwd, env) {
    const top = gitRun(cwd, ["rev-parse", "--show-toplevel"], { env, timeout: 10_000 });
    if (!top.ok) return { error: "outside git" };
    const head = gitRun(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { env, timeout: 10_000 });
    if (!head.ok) return { error: "no commits" };
    const prefix = gitRun(cwd, ["rev-parse", "--show-prefix"], { env, timeout: 10_000 }).stdout.trim();
    const common = gitRun(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { env, timeout: 10_000 });
    const branch = gitRun(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], { env, timeout: 10_000 });
    return {
        top: top.stdout.trim(), prefix, common: common.stdout.trim(), head: head.stdout.trim(),
        branch: branch.ok ? branch.stdout.trim() || null : null, repo: repoName(cwd) || "repo",
    };
}

/** The pathspecs of what the queue never commits for a job: every node_modules folder, also one git does not ignore,
 *  and the given paths (the links it made and the paths of isolateLinks). */
export const leftOutSpecs = (paths = []) => [
    ":/", ...[...new Set(paths.map((p) => String(p).replace(/\/+$/, "")))].map((p) => `:(top,exclude,literal)${p}`),
    ":(top,exclude,glob)**/node_modules", ":(top,exclude,glob)**/node_modules/**",
];

/** The entries of `git status --porcelain` in a folder, without the untracked paths the queue leaves out of a commit
 *  (see leftOutSpecs; paths: the links it made and the paths of isolateLinks); null when git has no answer. A change
 *  to a tracked file is always listed, also one inside node_modules. */
export function changesIn(folder, paths = [], env) {
    const all = gitRun(folder, ["status", "--porcelain", "--", ...leftOutSpecs(paths)], { env, timeout: 30_000 });
    const tracked = gitRun(folder, ["status", "--porcelain", "--untracked-files=no"], { env, timeout: 30_000 });
    if (!all.ok || !tracked.ok) return null;
    const entries = new Set([...all.stdout.split("\n"), ...tracked.stdout.split("\n")]);
    return [...entries].filter((entry) => entry && !porcelainClean(entry));
}

/** The files in a folder git does not track, ignored ones included, without the links in it; null when git has no
 *  answer. Links are files to git, so what they point to is never listed. */
export function untrackedFiles(folder, links = [], env) {
    const ran = gitRun(folder, ["ls-files", "-z", "--others"], { env, timeout: 60_000 });
    if (!ran.ok) return null;
    const own = new Set(links.map((link) => String(link).replace(/\/+$/, "")));
    return ran.stdout.split("\0").filter((path) => path && !own.has(path));
}

/** Does git hold a name and an e-mail for commits in this folder, from the repository's settings or from the
 *  GIT_AUTHOR_ and GIT_COMMITTER_ variables? The queue never lets git make one up from the computer's name. */
export function hasIdentity(folder, env = process.env) {
    const config = (key) => gitRun(folder, ["config", "--get", key], { env, timeout: 10_000 }).stdout.trim();
    const name = config("user.name"), email = config("user.email");
    const author = (env.GIT_AUTHOR_NAME || name) && (env.GIT_AUTHOR_EMAIL || env.EMAIL || email);
    const committer = (env.GIT_COMMITTER_NAME || name) && (env.GIT_COMMITTER_EMAIL || env.EMAIL || email);
    return !!(author && committer);
}

/** Does the branch exist? */
export const branchExists = (top, branch, env) =>
    gitRun(top, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { env, timeout: 10_000 }).ok;

/** The folders git knows as worktrees of the repository, as real paths. */
export function knownWorktrees(top, env) {
    const ran = gitRun(top, ["worktree", "list", "--porcelain"], { env, timeout: 10_000 });
    return ran.stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
}

/** Links each path of isolateLinks from the checkout at top into folder, when it exists there, git ignores it, and
 *  the folder has nothing at that path yet. Returns the paths it linked. */
export function linkIgnored(top, folder, paths, env) {
    const linked = [];
    for (const path of paths) {
        const source = join(top, path), target = join(folder, path);
        if (!existsSync(source) || existsSync(target) || isLink(target)) continue;
        if (!gitRun(top, ["check-ignore", "-q", "--", path], { env, timeout: 10_000 }).ok) continue;
        try {
            mkdirSync(dirname(target), { recursive: true });
            symlinkSync(source, target);
            linked.push(path);
        } catch { /* a link that cannot be made is left out */ }
    }
    return linked;
}
const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };

/** Removes the links linkIgnored made, only the links themselves: what they point to is never touched. */
export function unlinkAll(folder, links = []) {
    // unlinkSync removes the link itself; rmSync refuses a link that points to a folder.
    for (const path of links) if (isLink(join(folder, path))) unlinkSync(join(folder, path));
}

/** Removes a worktree the queue made, links first; force: also with changes in it. Returns the git result. */
export function removeWorktree(top, folder, links, { force = false, env } = {}) {
    unlinkAll(folder, links);
    return gitRun(top, ["worktree", "remove", ...(force ? ["--force"] : []), folder], { env, timeout: NO_LIMIT });
}

/** Makes git forget the one worktree at folder, a folder the queue made, also when the folder is gone already: by
 *  `git worktree remove --force`, and when git refuses that for a folder that is gone, by deleting only the entry under
 *  <git common dir>/worktrees whose gitdir file points into that folder. No other worktree is ever touched: unlike
 *  `git worktree prune`, which forgets every worktree whose folder is missing at that moment, also a user's own on a
 *  drive that is not mounted. Returns true when git no longer knows the folder. */
export function forgetWorktree(top, folder, env) {
    const removed = gitRun(top, ["worktree", "remove", "--force", folder], { env, timeout: NO_LIMIT });
    if (removed.ok) return true;
    if (existsSync(folder)) return false;
    const common = gitRun(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { env, timeout: 10_000 });
    if (!common.ok) return false;
    const admin = join(common.stdout.trim(), "worktrees");
    const ours = new Set([join(folder, ".git"), join(real(dirname(folder)), basename(folder), ".git")]);
    let names = [];
    try { names = readdirSync(admin); } catch { return true; }
    for (const name of names) {
        let points;
        try { points = readFileSync(join(admin, name, "gitdir"), "utf8").trim(); } catch { continue; }
        if (ours.has(points)) rmSync(join(admin, name), { recursive: true, force: true });
    }
    return true;
}
const real = (path) => { try { return realpathSync(path); } catch { return path; } };

// A temporary worktree of integrate: <job id>-integrate-<pid of the integrate process>-<random>.
const TEMP_RE = /^([0-9a-f]{8})-integrate-(\d+)-([0-9a-f]{8})$/;
/** The name of a temporary integrate worktree, and the file next to it that names its owner. */
export const tempName = (id, pid = process.pid, bytes = randomBytes) => `${id}-integrate-${pid}-${newId(bytes)}`;
export const ownerFile = (home, name) => join(worktreesDir(home), `${name}.owner.json`);

/** Removes the temporary integrate worktrees whose integrate process is gone, as after a kill during the merge step:
 *  the process is gone when its pid is not alive or now names a process that started at another time than the owner
 *  file says. Each is removed from git with forgetWorktree, never with prune. Returns the folders removed. same:
 *  sameProcess(pid, born). */
export function dropLeftovers(home, env, { same = sameProcess } = {}) {
    const dir = worktreesDir(home);
    let names = [];
    try { names = readdirSync(dir); } catch { return []; }
    const temps = new Set(names.map((name) => name.replace(/\.owner\.json$/, "")).filter((name) => TEMP_RE.test(name)));
    const dropped = [];
    for (const name of temps) {
        const owner = readJson(ownerFile(home, name));
        const pid = Number(TEMP_RE.exec(name)[2]);
        if (same(pid, owner?.born)) continue;
        const folder = join(dir, name);
        const top = [owner?.top, gitDirOf(folder)].find((path) => path && existsSync(path));
        if (top) forgetWorktree(top, folder, env);
        if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
        rmSync(ownerFile(home, name), { force: true });
        dropped.push(folder);
    }
    return dropped;
}
// The common git folder a worktree folder belongs to, from its .git file, or null.
function gitDirOf(folder) {
    try {
        const line = readFileSync(join(folder, ".git"), "utf8").trim();
        return line.startsWith("gitdir: ") ? dirname(dirname(line.slice(8))) : null;
    } catch { return null; }
}

const REFUSED = "nothing was started";
/** The first step of `run --isolate`, before the job joins the line: checks that the folder is in a git repository
 *  with a commit and a clean working tree, by the rule the journal uses, and returns { checkout } or { error }. A
 *  detached HEAD is fine: the job starts from the commit. */
export function prepareIsolate(cwd, env) {
    const checkout = checkoutOf(cwd, env);
    if (checkout.error === "outside git") {
        return { error: `--isolate needs a git repository; ${cwd} is not in one; run it in a git checkout; ${REFUSED}` };
    }
    if (checkout.error) return { error: `--isolate needs a commit to start from; the repository has none yet; ${REFUSED}` };
    const status = gitRun(cwd, ["status", "--porcelain"], { env, timeout: 30_000 });
    if (!status.ok) return { error: `--isolate could not read git status in ${checkout.top}; ${REFUSED}` };
    if (!porcelainClean(status.stdout)) {
        const count = status.stdout.split("\n").filter(Boolean).length;
        return {
            error: `--isolate needs a clean working tree; ${checkout.top} has ${count} uncommitted `
                + `${count === 1 ? "change" : "changes"} or untracked files; commit or stash your changes first; ${REFUSED}`,
        };
    }
    return { checkout };
}

/** Makes the job's worktree once it holds its slot: a new id, branch dotime/<label-slug>-<id> and folder
 *  <repo>-<id> under $DOTIME_HOME/worktrees, picking a new id while the branch, the folder or the state file is
 *  already there, then `git worktree add` at the commit the job was queued on, the links, and the state file.
 *  job: { label, checkout, home, links (isolateLinks), pid, command, now }. Returns { state, cwd (the folder to run
 *  in, the same one below the top as the job's own) } or { error }. Nothing is left behind on an error. */
export function makeWorktree(job, { env, id: pickId = newId } = {}) {
    const { checkout, home } = job;
    mkdirSync(worktreesDir(home), { recursive: true });
    for (let attempt = 0; attempt < ID_TRIES; attempt++) {
        const id = pickId();
        const branch = `dotime/${labelSlug(job.label)}-${id}`;
        const folder = join(worktreesDir(home), `${folderSafe(checkout.repo)}-${id}`);
        if (existsSync(folder) || existsSync(stateFile(home, id)) || branchExists(checkout.top, branch, env)) continue;
        const added = gitRun(checkout.top, ["worktree", "add", "-q", "-b", branch, folder, checkout.head], { env, timeout: NO_LIMIT });
        if (!added.ok) {
            forgetWorktree(checkout.top, folder, env);
            if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
            if (branchExists(checkout.top, branch, env)) gitRun(checkout.top, ["branch", "-D", branch], { env });
            return { error: `the worktree could not be made: ${gitError(added)}` };
        }
        const links = linkIgnored(checkout.top, folder, job.links ?? [], env);
        const state = {
            v: 1, id, label: job.label, command: job.command, branch, worktree: folder, base: checkout.head,
            baseBranch: checkout.branch, top: checkout.top, common: checkout.common, prefix: checkout.prefix, links,
            linkPaths: job.links ?? [], pid: job.pid, born: job.born ?? BORN, createdAt: job.now, outcome: "running", exit: null, endedAt: null,
        };
        try {
            writeState(home, state);
        } catch (e) {
            removeWorktree(checkout.top, folder, links, { force: true, env });
            gitRun(checkout.top, ["branch", "-D", branch], { env });
            return { error: `the state file of the worktree could not be written: ${e.message}` };
        }
        return { state, cwd: join(folder, checkout.prefix) };
    }
    return { error: `no free id for the worktree after ${ID_TRIES} tries` };
}

/** The isolate field of the job's journal line. */
export const journalFacts = (s) => ({ id: s.id, branch: s.branch, worktree: s.worktree, base: s.base, baseBranch: s.baseBranch });

/** The outcome kept in the state file for a journal line. */
export function outcomeOf(row) {
    if (!row) return "ended";
    if (row.outcome === "ran") return row.exit === 0 ? "passed" : "failed";
    return row.outcome;
}

/** The last step of `run --isolate`, once the job has ended. After exit 0 the changes the command left uncommitted
 *  are committed on the job's branch as "dotime: <label>" (not when git holds no name and e-mail, or a hook refuses;
 *  they stay uncommitted then, and a line says so), and a line names the folder, the branch and the integrate
 *  command. After anything else the worktree is kept as it is, and a line says how to remove it. The state file gets
 *  the outcome. Returns the lines to print. */
export function finishIsolate(state, row, exit, { home, env, now }) {
    const lines = [];
    const outcome = exit === 0 ? "passed" : outcomeOf(row);
    let committed = null;
    if (exit === 0) {
        const out = [...(state.links ?? []), ...(state.linkPaths ?? [])];
        const left = changesIn(state.worktree, out, env);
        if (left === null) lines.push(`could not read git status in ${state.worktree}; changes there stay uncommitted`);
        else if (left.length && !hasIdentity(state.worktree, env)) {
            lines.push(`not committed: git has no user.name and user.email for ${state.top}; the ${left.length} `
                + `${left.length === 1 ? "change stays" : "changes stay"} uncommitted in ${state.worktree}`);
        } else if (left.length) {
            const added = gitRun(state.worktree, ["add", "-A", "--", ...leftOutSpecs(out)], { env, timeout: NO_LIMIT });
            const made = added.ok
                ? gitRun(state.worktree, ["-c", "user.useConfigOnly=true", "commit", "-q", "-m", `dotime: ${state.label}`], { env, timeout: NO_LIMIT })
                : added;
            if (made.ok) {
                committed = gitRun(state.worktree, ["rev-parse", "HEAD"], { env }).stdout.trim();
                lines.push(`committed: ${left.length} ${left.length === 1 ? "change" : "changes"} on branch `
                    + `${state.branch} as ${committed.slice(0, 8)} "dotime: ${state.label}"`);
            } else {
                lines.push(`not committed: ${gitError(made)}; the changes stay uncommitted in ${state.worktree}`);
            }
        }
        lines.push(`isolated in ${state.worktree} on branch ${state.branch}; integrate with: `
            + `dotime-queue integrate ${state.id} -- <check>`);
    } else {
        lines.push(`kept ${state.worktree} on branch ${state.branch} for a look; remove it with: `
            + `dotime-queue discard ${state.id}`);
    }
    try {
        writeState(home, { ...state, outcome, exit, endedAt: now, ...(committed ? { committed } : {}) });
    } catch (e) {
        lines.push(`the state file ${stateFile(home, state.id)} could not be written: ${e.message}`);
    }
    return lines;
}
