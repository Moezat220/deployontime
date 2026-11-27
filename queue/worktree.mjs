// Isolated runs: a job that runs in a linked git worktree of its own, on a new branch, so that jobs started side by
// side never edit the same files. This module holds the git calls that make, look at and remove those worktrees,
// the state file kept per job in $DOTIME_HOME/worktrees, the links named in isolateLinks, and the two steps `run
// --isolate` takes around its job: prepareIsolate before the job joins the line, and the start and finish of the
// returned job once it holds its slot. It never changes the user's own checkout: the one step that does is
// `integrate`, in integrate.mjs.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "./files.mjs";
import { porcelainClean, readOnlyGit, repoName } from "./git.mjs";
import { UNLABELLED } from "./kinds.mjs";

/** How many new ids a job tries when its branch or folder is already there. */
export const ID_TRIES = 8;
export const ID_RE = /^[0-9a-f]{8}$/;

/** Runs `git -C <cwd> <args>` and returns { ok, code, stdout, stderr }; unlike git() in git.mjs it may change the
 *  repository and it keeps git's own error text. No watcher program named in the repository's settings is started. */
export function gitRun(cwd, args, { env = process.env, timeout = 120_000 } = {}) {
    try {
        const ran = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, env: readOnlyGit(env) });
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

/** The entries of `git status --porcelain` in a folder, without the links the queue made there; null when git has
 *  no answer. */
export function changesIn(folder, links = [], env) {
    const ran = gitRun(folder, ["status", "--porcelain"], { env, timeout: 30_000 });
    if (!ran.ok) return null;
    const own = new Set(links.map((link) => link.replace(/\/+$/, "")));
    return ran.stdout.split("\n").filter(Boolean)
        .filter((entry) => !own.has(entry.slice(3).replace(/\/+$/, "")) && !porcelainClean(entry));
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
    for (const path of links) if (isLink(join(folder, path))) rmSync(join(folder, path));
}

/** Removes a worktree the queue made, links first; force: also with changes in it. Returns the git result. */
export function removeWorktree(top, folder, links, { force = false, env } = {}) {
    unlinkAll(folder, links);
    return gitRun(top, ["worktree", "remove", ...(force ? ["--force"] : []), folder], { env });
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
        const added = gitRun(checkout.top, ["worktree", "add", "-q", "-b", branch, folder, checkout.head], { env });
        if (!added.ok) {
            gitRun(checkout.top, ["worktree", "prune"], { env });
            if (branchExists(checkout.top, branch, env)) gitRun(checkout.top, ["branch", "-D", branch], { env });
            return { error: `the worktree could not be made: ${gitError(added)}` };
        }
        const links = linkIgnored(checkout.top, folder, job.links ?? [], env);
        const state = {
            v: 1, id, label: job.label, command: job.command, branch, worktree: folder, base: checkout.head,
            baseBranch: checkout.branch, top: checkout.top, common: checkout.common, prefix: checkout.prefix, links,
            pid: job.pid, createdAt: job.now, outcome: "running", exit: null, endedAt: null,
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
        const left = changesIn(state.worktree, state.links, env);
        if (left === null) lines.push(`could not read git status in ${state.worktree}; changes there stay uncommitted`);
        else if (left.length && !hasIdentity(state.worktree, env)) {
            lines.push(`not committed: git has no user.name and user.email for ${state.top}; the ${left.length} `
                + `${left.length === 1 ? "change stays" : "changes stay"} uncommitted in ${state.worktree}`);
        } else if (left.length) {
            const excludes = (state.links ?? []).map((link) => `:(top,exclude,literal)${link}`);
            const added = gitRun(state.worktree, ["add", "-A", "--", ":/", ...excludes], { env });
            const made = added.ok
                ? gitRun(state.worktree, ["-c", "user.useConfigOnly=true", "commit", "-q", "-m", `dotime: ${state.label}`], { env })
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
