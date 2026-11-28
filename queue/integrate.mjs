// The commands that follow an isolated run (see worktree.mjs): `integrate` brings a job's branch into the user's
// branch once a check passed on the merged result, `discard` removes a job's worktree and branch, and `worktrees`
// lists the kept jobs. Only integrate ever changes the user's checkout, and only by a fast-forward to a commit the
// check passed on: the merge itself and the check happen in a temporary worktree of their own.
import { existsSync, realpathSync, rmSync } from "node:fs";
import { writeJsonAtomic } from "./files.mjs";
import { join } from "node:path";
import { flagError } from "./args.mjs";
import { minutesSince } from "./clock.mjs";
import { sameProcess } from "./proctree.mjs";
import {
    BORN, MARKS, marksOf, branchExists, changesIn, checkoutOf, dropLeftovers, dropState, forgetWorktree, gitError, gitRun, hasIdentity, ID_RE,
    knownWorktrees, linkIgnored, listStates, NO_LIMIT, ownerFile, readState, removeWorktree, tempName, untrackedFiles, worktreesDir,
} from "./worktree.mjs";

const USAGE_EXIT = 2;
const short = (commit) => String(commit).slice(0, 8);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const real = (path) => { try { return realpathSync(path); } catch { return path; } };

/** Moves the checkout at top to commit with `git merge --ff-only`, with no time limit, as it runs the repository's
 *  hooks. When git reports a failure, HEAD is read again: when it is at commit after all, that counts as done. Returns
 *  { ok: true } or { ok: false, error, now (HEAD as it is now) }. run: gitRun. */
export function fastForward(top, commit, { env, run = gitRun } = {}) {
    const forward = run(top, ["merge", "--ff-only", "-q", commit], { env, timeout: NO_LIMIT });
    if (forward.ok) return { ok: true };
    const now = gitRun(top, ["rev-parse", "-q", "--verify", "HEAD"], { env, timeout: 10_000 }).stdout.trim();
    return now === commit ? { ok: true } : { ok: false, error: gitError(forward), now };
}

/** The job an id names, or { error } for a word that is no id or names no kept job. */
function findJob(id, home) {
    if (!ID_RE.test(id ?? "")) return { error: `"${id ?? ""}" is not a job id; dotime-queue worktrees lists them` };
    const state = readState(home, id);
    return state ? { state } : { error: `no kept isolated job ${id}; dotime-queue worktrees lists them` };
}

/** `integrate <id> -- <check>`: refuses with exit 2, changing nothing, when the job did not pass, its worktree
 *  still has uncommitted changes, the current folder is not in the job's repository, the checkout there has
 *  uncommitted changes or is not on the job's base branch, or git holds no name and e-mail for the merge commit.
 *  Otherwise merges the job's branch with --no-ff in a temporary worktree at the checkout's HEAD; a conflict aborts
 *  the merge, removes the temporary worktree and exits 1. The check then runs there through the queue (deps.run,
 *  the `run` command with its ctx and deps), labelled "<job label>: integrate"; when it fails, its exit code is
 *  passed on. When it passes, the checkout is fast-forwarded to the checked commit, or, when its HEAD moved in the
 *  meantime, left alone with exit 1. Only then are the temporary worktree, the job's worktree and its branch removed,
 *  the branch with `git branch -d`. A job whose branch is already in the checkout's HEAD is just removed. Every
 *  failure keeps the job. ctx: { settings, files, cwd }. deps: { say, run, env, now }. */
export async function cmdIntegrate(args, ctx, deps) {
    const { say } = deps;
    const env = deps.env ?? process.env;
    const cut = args.indexOf("--");
    const words = cut < 0 ? args : args.slice(0, cut);
    const check = cut < 0 ? [] : args.slice(cut + 1);
    const usage = (text) => { say(`integrate: ${text}`); return USAGE_EXIT; };
    const bad = flagError(["integrate", ...words.slice(2), ...(cut < 0 ? [] : args.slice(cut))]);
    if (bad) return usage(bad);
    if (!check.length) return usage("needs the check command after --, such as: dotime-queue integrate <id> -- npm test");
    const found = findJob(words[1], ctx.files.home);
    if (found.error) return usage(found.error);
    const job = found.state;
    dropLeftovers(ctx.files.home, env);
    const keep = `the job is kept in ${job.worktree} on branch ${job.branch}`;
    if (job.outcome !== "passed") {
        const how = job.outcome === "running" ? "has not ended" : `ended as ${job.outcome}${job.exit == null ? "" : `, exit ${job.exit}`}`;
        return usage(`job ${job.id} ${how}; only a job that ended with exit 0 is integrated; ${keep}`);
    }
    const here = checkoutOf(ctx.cwd, env);
    if (here.error || here.common !== job.common) {
        return usage(`run integrate in a folder of the repository at ${job.top}; nothing was changed`);
    }
    if (real(here.top) === real(job.worktree)) return usage(`run integrate in your own checkout, not in the job's worktree`);
    if (!branchExists(here.top, job.branch, env)) return usage(`branch ${job.branch} is gone; dotime-queue discard ${job.id} removes the rest`);
    const leftOutPaths = [...(job.links ?? []), ...(job.linkPaths ?? [])];
    if (existsSync(job.worktree)) {
        const left = changesIn(job.worktree, leftOutPaths, env);
        if (left === null || left.length) {
            const what = left === null ? "changes git could not read" : plural(left.length, "uncommitted change", "uncommitted changes");
            return usage(`${job.worktree} has ${what}; commit them on ${job.branch} there first, or discard the job; nothing was changed`);
        }
    }
    if (job.baseBranch && here.branch !== job.baseBranch) {
        const now = here.branch ? `is on ${here.branch}` : "has a detached HEAD";
        return usage(`the checkout ${now}; the job started on ${job.baseBranch}; switch to it with: git switch ${job.baseBranch}`);
    }
    if (!job.baseBranch && here.branch) {
        return usage(`the job started on a detached HEAD at ${short(job.base)} and the checkout is on ${here.branch}; `
            + `merge ${job.branch} yourself, or check out a detached HEAD first`);
    }
    const target = here.branch ?? "the detached HEAD";
    const status = changesIn(here.top, [], env);
    if (status === null || status.length) {
        return usage(`${here.top} has ${status === null ? "a status git could not read" : plural(status.length, "uncommitted change", "uncommitted changes")}; `
            + "commit or stash your changes first; nothing was changed");
    }
    // Removes the job's worktree and branch once its work is in the checkout. The worktree is looked at once more
    // first: a change made there while the check ran keeps it. Files git does not track, such as an .env the job
    // made, go with the folder; { lines, gone } says how many.
    const removeJob = () => {
        const out = [];
        let gone = 0;
        if (existsSync(job.worktree)) {
            const left = changesIn(job.worktree, leftOutPaths, env);
            if (left === null || left.length) {
                const what = left === null ? "changes git could not read" : plural(left.length, "uncommitted change", "uncommitted changes");
                out.push(`${job.worktree} was kept: it has ${what} made after the job ended`);
            } else {
                const files = untrackedFiles(job.worktree, job.links, env) ?? [];
                const removed = removeWorktree(here.top, job.worktree, job.links, { force: true, env });
                if (!removed.ok) out.push(`${job.worktree} could not be removed: ${gitError(removed)}`);
                else gone = files.length;
            }
        } else if (!forgetWorktree(here.top, job.worktree, env)) out.push(`git could not forget the worktree ${job.worktree}`);
        if (!out.length) {
            const deleted = gitRun(here.top, ["branch", "-d", job.branch], { env });
            if (!deleted.ok) out.push(`branch ${job.branch} could not be removed: ${gitError(deleted)}`);
        }
        if (!out.length) dropState(ctx.files.home, job.id);
        else out.push(`dotime-queue discard ${job.id} removes the rest`);
        const extra = gone ? `; removed ${plural(gone, "ignored file", "ignored files")} from the job folder` : "";
        const removedWhat = out.length ? "" : `; removed the job's worktree and branch${extra}`;
        return { lines: out, removedWhat };
    };
    const head = here.head;
    if (gitRun(here.top, ["merge-base", "--is-ancestor", job.branch, head], { env }).ok) {
        const removed = removeJob();
        for (const line of removed.lines) say(line);
        say(`integrated: ${job.branch} was already in ${target} at ${short(head)}${removed.removedWhat}`);
        return 0;
    }
    if (!hasIdentity(here.top, env)) {
        return usage(`git has no user.name and user.email for ${here.top}, needed for the merge commit; set them, `
            + "then run integrate again; nothing was changed");
    }
    // The temporary worktree is named after this process, and the owner file next to it says when the process
    // started, so a later integrate, discard or worktrees can tell a leftover of a process that was killed.
    const name = tempName(job.id);
    const temp = join(worktreesDir(ctx.files.home), name);
    let links = [];
    const dropTemp = () => {
        removeWorktree(here.top, temp, links, { force: true, env });
        if (existsSync(temp)) {
            forgetWorktree(here.top, temp, env);
            rmSync(temp, { recursive: true, force: true });
        } else forgetWorktree(here.top, temp, env);
        rmSync(ownerFile(ctx.files.home, name), { force: true });
    };
    try {
        writeJsonAtomic(ownerFile(ctx.files.home, name), { pid: process.pid, born: BORN, ...MARKS, top: here.top, job: job.id });
    } catch (e) {
        say(`integrate: the owner file of the temporary worktree could not be written: ${e.message}; nothing was changed`);
        return 1;
    }
    const made = gitRun(here.top, ["worktree", "add", "-q", "--detach", temp, head], { env, timeout: NO_LIMIT });
    if (!made.ok) {
        dropTemp();
        say(`integrate: the temporary worktree could not be made: ${gitError(made)}; nothing was changed`);
        return 1;
    }
    try {
        const message = `dotime: integrate ${job.label}`;
        const merged = gitRun(temp, ["-c", "user.useConfigOnly=true", "merge", "--no-ff", "--no-edit", "-m", message, job.branch],
            { env, timeout: NO_LIMIT });
        if (!merged.ok) {
            const files = gitRun(temp, ["diff", "--name-only", "--diff-filter=U"], { env }).stdout.split("\n").filter(Boolean);
            gitRun(temp, ["merge", "--abort"], { env });
            const why = files.length ? `conflicts in ${files.join(", ")}` : `failed: ${gitError(merged)}`;
            say(`conflict: merging ${job.branch} onto ${target} at ${short(head)} ${why}; nothing was changed; ${keep}`);
            return 1;
        }
        const commit = gitRun(temp, ["rev-parse", "HEAD"], { env }).stdout.trim();
        links = linkIgnored(here.top, temp, ctx.settings.isolateLinks ?? [], env);
        const label = `${job.label}: integrate`;
        const exit = await deps.run(["run", `--label=${label}`, "--", ...check], { cwd: join(temp, here.prefix) });
        if (exit !== 0) {
            say(`integrate: the check ended with exit ${exit}; ${target} was not changed; ${keep}`);
            return exit;
        }
        const now = checkoutOf(here.top, env);
        if (now.head !== head || now.branch !== here.branch) {
            say(`integrate: ${target} moved from ${short(head)} while the check ran; nothing was changed; ${keep}; `
                + "run integrate again");
            return 1;
        }
        const forward = fastForward(here.top, commit, { env });
        if (!forward.ok) {
            // "nothing was changed" only when HEAD is where it was: git may fail after moving it.
            const where = forward.now === head ? "nothing was changed" : `${target} is now at ${short(forward.now || "nothing")}; look at it with: git status`;
            say(`integrate: ${target} could not be moved to ${short(commit)}: ${forward.error}; ${where}; ${keep}; run integrate again`);
            return 1;
        }
        dropTemp();
        const removed = removeJob();
        for (const line of removed.lines) say(line);
        say(`integrated: ${job.branch} into ${target}, now at ${short(commit)} "${message}"${removed.removedWhat}`);
        return 0;
    } finally {
        if (existsSync(temp) || existsSync(ownerFile(ctx.files.home, name))) dropTemp();
    }
}

/** `discard <id> [--force]`: removes the job's worktree and branch. Without --force it refuses, with exit 2 and
 *  nothing removed, while the branch has commits that are not in the job's base branch (or base commit), or the
 *  worktree has uncommitted changes, or the folder is there but git no longer knows it as a worktree. A folder git
 *  still lists but that is gone is forgotten (that one folder only). ctx: { files }. deps: { say, env }. */
export function cmdDiscard(args, ctx, deps) {
    const { say } = deps;
    const env = deps.env ?? process.env;
    const usage = (text) => { say(`discard: ${text}`); return USAGE_EXIT; };
    const bad = flagError(["discard", ...args.slice(2)]);
    if (bad) return usage(bad);
    const force = args.slice(2).includes("--force");
    const found = findJob(args[1], ctx.files.home);
    if (found.error) return usage(found.error);
    const job = found.state;
    // A pid that now names a process that started at another time, as after a restart, is not the job's.
    const running = job.outcome === "running" && (deps.same ?? sameProcess)(job.pid, job.born, marksOf(job));
    if (running) return usage(`job ${job.id} is still running, pid ${job.pid}`);
    dropLeftovers(ctx.files.home, env);
    const top = existsSync(job.top) ? job.top : job.common;
    const there = existsSync(job.worktree);
    const known = there && knownWorktrees(top, env).includes(real(job.worktree));
    const hasBranch = branchExists(top, job.branch, env);
    const base = job.baseBranch && branchExists(top, job.baseBranch, env) ? job.baseBranch : job.base;
    const counted = hasBranch ? gitRun(top, ["rev-list", "--count", `${base}..${job.branch}`], { env }) : null;
    const ahead = counted?.ok ? Number(counted.stdout.trim()) || 0 : 0;
    const left = known ? changesIn(job.worktree, [...(job.links ?? []), ...(job.linkPaths ?? [])], env) : [];
    const issues = [];
    if (counted && !counted.ok) {
        issues.push(`the commits of branch ${job.branch} not in ${job.baseBranch ?? short(job.base)} could not be counted: ${gitError(counted)}`);
    }
    if (ahead) issues.push(`branch ${job.branch} has ${plural(ahead, "commit", "commits")} not in ${job.baseBranch ?? short(job.base)}`);
    if (left === null) issues.push(`${job.worktree} has a status git could not read`);
    else if (left.length) issues.push(`${job.worktree} has ${plural(left.length, "uncommitted change", "uncommitted changes")}`);
    if (there && !known) issues.push(`${job.worktree} is no longer a worktree git knows`);
    if (issues.length && !force) return usage(`${issues.join(", and ")}; nothing was removed; add --force to remove them anyway`);
    const problems = [];
    if (known) {
        const removed = removeWorktree(top, job.worktree, job.links, { force: force || false, env });
        if (!removed.ok) problems.push(`${job.worktree} could not be removed: ${gitError(removed)}`);
    } else if (there && real(job.worktree).startsWith(real(worktreesDir(ctx.files.home)))) {
        rmSync(job.worktree, { recursive: true, force: true });
    } else if (!there && !forgetWorktree(top, job.worktree, env)) {
        problems.push(`git could not forget the worktree ${job.worktree}`);
    }
    if (hasBranch && !problems.length) {
        // -D only once the commits are known to be in the base, or --force was given.
        const deleted = gitRun(top, ["branch", "-D", job.branch], { env });
        if (!deleted.ok) problems.push(`branch ${job.branch} could not be removed: ${gitError(deleted)}`);
    }
    if (problems.length) {
        say(`discard: ${problems.join("; ")}`);
        return 1;
    }
    dropState(ctx.files.home, job.id);
    say(`discarded: job ${job.id}; removed ${job.worktree} and branch ${job.branch}`);
    return 0;
}

/** The lines of `worktrees`: one per kept isolated job, oldest first, or "worktrees: none". */
export function worktreeLines(states, now, isAlive = sameProcess) {
    if (!states.length) return ["worktrees: none"];
    return states.map((s) => {
        const ended = s.outcome === "running" && !isAlive(s.pid, s.born, marksOf(s)) ? "ended without a result" : s.outcome;
        const exit = s.exit != null && s.outcome !== "passed" ? `, exit ${s.exit}` : "";
        const missing = existsSync(s.worktree) ? "" : ", folder missing";
        return `worktree ${s.id}: "${s.label}", branch ${s.branch}, folder ${s.worktree}${missing}, ${ended}${exit}, `
            + `${minutesSince(s.createdAt, now)} min old`;
    });
}

/** `worktrees`: prints worktreeLines and returns 0. */
export function cmdWorktrees(ctx, { print = console.log, now = Date.now(), env = process.env } = {}) {
    dropLeftovers(ctx.files.home, env);
    for (const line of worktreeLines(listStates(ctx.files.home), now)) print(line);
    return 0;
}
