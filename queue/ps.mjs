// Parsers for `ps` output. Each takes the text a probe in probes.mjs returned and never runs anything itself, so it
// can be tested on sample output. A line that does not fit the layout, such as a header, is skipped.

/** A `ps` time value, "[[days-]hours:]minutes:seconds" with optional fractions of a second, in seconds. Both the
 *  elapsed time (etime) and the CPU time (time) use this layout. */
export function psSeconds(value) {
    const text = String(value).trim();
    const dash = text.indexOf("-");
    const days = dash < 0 ? 0 : Number(text.slice(0, dash));
    return text.slice(dash + 1).split(":").map(Number).reduce((total, part) => total * 60 + part, 0) + days * 86_400;
}

/** Seconds each listed process has run, from `ps -o pid=,etime=`. A pid ps does not list is left out. */
export function parseElapsed(text) {
    const ages = new Map();
    for (const line of String(text ?? "").split("\n")) {
        const found = line.trim().match(/^(\d+)\s+((?:\d+-)?(?:\d+:)?\d+:\d+)$/);
        if (found) ages.set(Number(found[1]), psSeconds(found[2]));
    }
    return ages;
}

/** Parses `ps -o pid=,ppid=,pgid=[,time=]` text into [{ pid, ppid, pgid, cpu }]; cpu is 0 without a time column. */
export function psRows(text) {
    const rows = [];
    for (const line of String(text ?? "").split("\n")) {
        const [pid, ppid, pgid, time] = line.trim().split(/\s+/);
        if (![pid, ppid, pgid].every((x) => /^\d+$/.test(x ?? ""))) continue;
        rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), cpu: time ? psSeconds(time) : 0 });
    }
    return rows;
}

const TABLE_LINE = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;
/** Parses `ps -Ao pid=,ppid=,pgid=,etime=,time=,pcpu=,rss=,command=` text into rows; age in ms, cpu in seconds,
 *  rss in KB. */
export function parseProcessTable(text) {
    const rows = [];
    for (const line of String(text ?? "").split("\n")) {
        const m = line.trim().match(TABLE_LINE);
        if (!m) continue;
        rows.push({
            pid: +m[1], ppid: +m[2], pgid: +m[3], age: psSeconds(m[4]) * 1000, cpu: psSeconds(m[5]), pcpu: +m[6],
            rss: +m[7], cmd: m[8],
        });
    }
    return rows;
}
