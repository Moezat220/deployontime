import { test } from "node:test";
import assert from "node:assert/strict";
import { isolateProcess } from "./testkit.mjs";

isolateProcess("ps");
const { parseElapsed, parseGroupId, parseProcessTable, psRows, psSeconds } = await import("./ps.mjs");

const MINUTE = 60_000;
const SERVER = "node /srv/shop-api/node_modules/.bin/next dev -p 4100";

test("psSeconds: converts every `ps` time layout", () => {
    assert.equal(psSeconds("0:07.25"), 7.25);
    assert.equal(psSeconds("41:30"), 2490);
    assert.equal(psSeconds("03:00:10"), 10_810);
    assert.equal(psSeconds("5-00:00:30"), 5 * 86_400 + 30);
    assert.equal(psSeconds(" 1:00 "), 60);
});

test("parseElapsed: reads ps elapsed times in seconds, with and without days and hours", () => {
    const ages = parseElapsed("  701    01:05\n 702 02:00:09\n703 3-04:05:06\nnot a row\n");
    assert.deepEqual([...ages], [[701, 65], [702, 7209], [703, ((3 * 24 + 4) * 60 + 5) * 60 + 6]]);
});

test("parseProcessTable: turns `ps` rows into numbers and a command, skipping other lines", () => {
    const text = `  2400     1  2400    01:35:00   0:41.50  0.2 262144 ${SERVER}\n  2401  2400  2400       58:10   0:00.75 12.5   4096 node child.js --flag\n  PID  PPID  PGID ELAPSED TIME %CPU RSS COMMAND\n\n`;
    assert.deepEqual(parseProcessTable(text), [
        { pid: 2400, ppid: 1, pgid: 2400, age: 95 * MINUTE, cpu: 41.5, pcpu: 0.2, rss: 262144, cmd: SERVER },
        { pid: 2401, ppid: 2400, pgid: 2400, age: 3_490_000, cpu: 0.75, pcpu: 12.5, rss: 4096, cmd: "node child.js --flag" },
    ]);
    assert.deepEqual(parseProcessTable(""), []);
});

test("psRows: one row per process line, with CPU time in seconds", () => {
    assert.deepEqual(psRows("  4100     1  4100   0:03.75\n  4101  4100  4100  12:00.00\n  PID  PPID  PGID      TIME\n\n  4102  4101  4102\n"), [
        { pid: 4100, ppid: 1, pgid: 4100, cpu: 3.75 }, { pid: 4101, ppid: 4100, pgid: 4100, cpu: 720 }, { pid: 4102, ppid: 4101, pgid: 4102, cpu: 0 },
    ]);
    assert.deepEqual(psRows(undefined), []);
});

test("parseGroupId: the group id ps prints, or null for empty or unusable text", () => {
    assert.equal(parseGroupId("  4100\n"), 4100);
    assert.deepEqual([parseGroupId(""), parseGroupId(null), parseGroupId("0"), parseGroupId("PGID\n4100")], [null, null, null, null]);
});
