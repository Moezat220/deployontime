// Finds large test runs that did not come through the queue, so the reaper can report them. A run belongs to the
// queue when it descends from a process that holds a slot. Small runs outside the queue are left alone.

export const TEST_RE = /jest-worker|\/jest(\.js)?(\s|$)|\bjest\s|\bvitest(\.mjs)?(\s|$)|vitest\/dist|playwright test|@playwright\/test/;
// Reported when the run has at least two test processes using minMB together, or minProcs test processes of any size.
export const STRAY = { minMB: 2048, minProcs: 5 };

// "sh -c jest" matches TEST_RE through its argument; launchers like that are excluded.
const SHELL_RE = /^(\/bin\/|\/usr\/bin\/)?(zsh|bash|sh)(\s|$)/;
const isTestProcess = (row) => TEST_RE.test(row.cmd) && !SHELL_RE.test(row.cmd);
const MAX_DEPTH = 64;

/** rows: [{ pid, ppid, rss (KB), cmd }]; holders: slot entries with pid and pgid.
 *  Returns [{ rootPid, procs, rssMB, cmd }], largest first. */
export function strayRuns(rows, { holders = [], minMB = STRAY.minMB, minProcs = STRAY.minProcs } = {}) {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const children = new Map();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    const queuePids = new Set(holders.flatMap((h) => [h.pid, h.pgid]).filter(Number.isInteger));
    const lineage = (row) => {
        const chain = [];
        for (let at = row, depth = 0; at && depth < MAX_DEPTH; at = byPid.get(at.ppid), depth++) chain.push(at);
        return chain;
    };
    // The same check on ppid covers a holder that is missing from the rows.
    const underQueue = (chain) => chain.some((p) => queuePids.has(p.pid) || queuePids.has(p.ppid));

    const roots = new Map();
    for (const row of rows) {
        if (!isTestProcess(row)) continue;
        const chain = lineage(row);
        if (underQueue(chain)) continue;
        const top = chain.findLast(isTestProcess);
        roots.set(top.pid, top);
    }

    const found = [];
    for (const root of roots.values()) {
        const tree = [], todo = [root];
        while (todo.length) { const p = todo.pop(); tree.push(p); todo.push(...(children.get(p.pid) ?? [])); }
        const tests = tree.filter(isTestProcess), rssMB = Math.round(tests.reduce((sum, p) => sum + (p.rss || 0), 0) / 1024);
        if ((rssMB >= minMB && tests.length >= 2) || tests.length >= minProcs) found.push({ rootPid: root.pid, procs: tests.length, rssMB, cmd: root.cmd });
    }
    return found.sort((a, b) => b.rssMB - a.rssMB);
}
