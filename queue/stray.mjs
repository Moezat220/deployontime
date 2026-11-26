// Finds large test runs that did not come through the queue, so the reaper can report them. A run belongs to the
// queue when it descends from a process that holds a slot. Small runs outside the queue are left alone.
import { ancestors, descendants, treeIndex } from "./proctree.mjs";
import { SHELL_PROGRAM_RE, STRAY_TEST_RE } from "./commands.mjs";

// Reported when the run has at least two test processes using minMB together, or minProcs test processes of any size.
export const STRAY = { minMB: 2048, minProcs: 5 };

// "sh -c jest" matches through its argument; a shell is only the launcher of the run.
const isTestProcess = (row) => STRAY_TEST_RE.test(row.cmd) && !SHELL_PROGRAM_RE.test(row.cmd);

/** rows: [{ pid, ppid, rss (KB), cmd }]; holders: slot entries with pid and pgid.
 *  Returns [{ rootPid, procs, rssMB, cmd }], largest first. */
export function strayRuns(rows, { holders = [], minMB = STRAY.minMB, minProcs = STRAY.minProcs } = {}) {
    const index = treeIndex(rows);
    const queuePids = new Set(holders.flatMap((h) => [h.pid, h.pgid]).filter(Number.isInteger));
    // The same check on ppid covers a holder that is missing from the rows.
    const underQueue = (chain) => chain.some((p) => queuePids.has(p.pid) || queuePids.has(p.ppid));

    const roots = new Map();
    for (const row of rows) {
        if (!isTestProcess(row)) continue;
        const chain = ancestors(index, row.pid);
        if (underQueue(chain)) continue;
        const top = chain.findLast(isTestProcess);
        roots.set(top.pid, top);
    }

    const found = [];
    for (const root of roots.values()) {
        const tree = [...descendants(index, [root.pid])].map((pid) => index.byPid.get(pid));
        const tests = tree.filter(isTestProcess);
        const rssMB = Math.round(tests.reduce((sum, p) => sum + (p.rss || 0), 0) / 1024);
        const large = (rssMB >= minMB && tests.length >= 2) || tests.length >= minProcs;
        if (large) found.push({ rootPid: root.pid, procs: tests.length, rssMB, cmd: root.cmd });
    }
    return found.sort((a, b) => b.rssMB - a.rssMB);
}
