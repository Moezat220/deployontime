// The times of scheduled jobs: `every` steps, the five cron fields, the next due time across the ends of hours, days,
// months and years, the shifts of a time zone's clock, and the due times between two moments. A named zone is handed
// in as the wall clock; one test starts node with TZ set, to check the computer's own zone the same way.
import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cronMatches, dueBetween, nextCron, nextDue, parseCron, parseEvery, timesText, zoneWall } from "./cron.mjs";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const UTC = zoneWall("UTC");
const NEW_YORK = zoneWall("America/New_York");
const VANCOUVER = zoneWall("America/Vancouver");
const at = (text) => Date.parse(text);
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
const sorted = (set) => [...set].sort((a, b) => a - b);
const next = (expr, from, wall = UTC) => iso(nextCron(parseCron(expr), at(from), wall));

test("parseEvery: a whole number of minutes, hours or days, at least 1m", () => {
    assert.deepEqual(parseEvery("15m"), { ms: 15 * MINUTE });
    assert.deepEqual(parseEvery("2h"), { ms: 2 * HOUR });
    assert.deepEqual(parseEvery("1d"), { ms: 24 * HOUR });
    assert.deepEqual(parseEvery("1m"), { ms: MINUTE });
    for (const bad of ["0m", "30s", "1.5h", "m", "", "-1m", "01m", "1w", "1 m", "1M", undefined]) {
        assert.match(parseEvery(bad).error, /^--every: .* is not a step; give a whole number with m, h or d, such as 15m, 2h or 1d, at least 1m$/, String(bad));
    }
});

test("parseCron: stars, numbers, ranges, lists and steps", () => {
    const spec = parseCron("*/15 9-17 1,15 */3 1-5");
    assert.deepEqual(sorted(spec.minute), [0, 15, 30, 45]);
    assert.deepEqual(sorted(spec.hour), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
    assert.deepEqual(sorted(spec.dom), [1, 15]);
    assert.deepEqual(sorted(spec.month), [1, 4, 7, 10]);
    assert.deepEqual(sorted(spec.dow), [1, 2, 3, 4, 5]);
    assert.deepEqual([spec.domAny, spec.dowAny], [false, false]);
    assert.deepEqual(sorted(parseCron("10-50/20 * * * *").minute), [10, 30, 50]);
    assert.deepEqual(sorted(parseCron("0,5-7,58 * * * *").minute), [0, 5, 6, 7, 58]);
    assert.equal(parseCron("* * * * *").minute.size, 60);
    assert.deepEqual([parseCron("0 2 * * *").domAny, parseCron("0 2 * * *").dowAny], [true, true]);
    assert.deepEqual(sorted(parseCron("  0   2 * *  * ").hour), [2], "extra spaces between fields are fine");
});

test("parseCron: day of week 7 is Sunday, the same as 0", () => {
    assert.deepEqual(sorted(parseCron("0 0 * * 7").dow), [0]);
    assert.deepEqual(sorted(parseCron("0 0 * * 5-7").dow), [0, 5, 6]);
    assert.deepEqual(sorted(parseCron("0 0 * * 0,7").dow), [0]);
    assert.equal(next("0 0 * * 7", "2031-01-13T12:00:00Z"), "2031-01-19T00:00:00.000Z");
});

test("parseCron: refuses what it does not understand, with the field and the reason", () => {
    const cases = [
        ["0 2 * *", /needs 5 fields/], ["0 2 * * * *", /needs 5 fields/], ["", /needs 5 fields/],
        ["60 * * * *", /minute field "60" is out of range; minute runs from 0 to 59/],
        ["* 24 * * *", /hour field "24" is out of range/], ["* * 0 * *", /day of month field "0" is out of range/],
        ["* * * 13 *", /month field "13" is out of range/], ["* * * * 8", /day of week field "8" is out of range/],
        ["5-1 * * * *", /minute field "5-1" is out of range/], ["*/0 * * * *", /has a step of 0/],
        ["a * * * *", /minute field "a" is not understood/], ["1-2-3 * * * *", /not understood/],
        ["* * * JAN *", /month field "JAN" is not understood/], ["1,,2 * * * *", /not understood/],
        ["0 0 30 2 *", /names a day that never comes/], ["0 0 31 4,6,9,11 *", /names a day that never comes/],
    ];
    for (const [expr, why] of cases) {
        const parsed = parseCron(expr);
        assert.match(parsed.error ?? "", /^--cron: /, expr);
        assert.match(parsed.error, why, expr);
    }
    assert.equal(parseCron("0 0 31 2 1").error, undefined, "with a day of week as well, Mondays still come");
    assert.equal(parseCron("0 0 29 2 *").error, undefined, "the 29th of February comes in leap years");
});

test("cronMatches: with both day fields restricted either one is enough; with one a star, only the other counts", () => {
    const either = parseCron("0 0 13 * 5");
    assert.equal(cronMatches(either, at("2031-01-13T00:00:00Z"), UTC), true, "the 13th, a Monday");
    assert.equal(cronMatches(either, at("2031-01-17T00:00:00Z"), UTC), true, "a Friday, the 17th");
    assert.equal(cronMatches(either, at("2031-01-14T00:00:00Z"), UTC), false);
    assert.equal(cronMatches(parseCron("0 0 13 * *"), at("2031-01-17T00:00:00Z"), UTC), false);
    assert.equal(cronMatches(parseCron("0 0 * * 5"), at("2031-01-13T00:00:00Z"), UTC), false);
    assert.equal(cronMatches(parseCron("0 0 * * 5"), at("2031-01-17T00:00:00Z"), UTC), true);
    assert.equal(cronMatches(parseCron("0 0 13 * 5"), at("2031-01-13T00:01:00Z"), UTC), false, "the minute counts too");
    assert.equal(next("0 0 13 * 5", "2031-01-13T00:00:00Z"), "2031-01-17T00:00:00.000Z");
    assert.equal(next("0 0 13 * *", "2031-01-13T00:00:00Z"), "2031-02-13T00:00:00.000Z");
});

test("nextCron: strictly after the moment, across the ends of an hour, a day, a month and a year", () => {
    assert.equal(next("*/15 * * * *", "2031-05-06T10:50:00Z"), "2031-05-06T11:00:00.000Z");
    assert.equal(next("*/15 * * * *", "2031-05-06T11:00:00Z"), "2031-05-06T11:15:00.000Z", "not the moment itself");
    assert.equal(next("*/15 * * * *", "2031-05-06T11:00:30Z"), "2031-05-06T11:15:00.000Z");
    assert.equal(next("30 0 * * *", "2031-05-31T23:00:00Z"), "2031-06-01T00:30:00.000Z");
    assert.equal(next("0 12 1 * *", "2031-04-30T13:00:00Z"), "2031-05-01T12:00:00.000Z");
    assert.equal(next("0 0 1 1 *", "2031-12-31T23:59:00Z"), "2032-01-01T00:00:00.000Z");
    assert.equal(next("59 23 31 12 *", "2031-01-01T00:00:00Z"), "2031-12-31T23:59:00.000Z");
    assert.equal(next("0 0 29 2 *", "2031-03-01T00:00:00Z"), "2032-02-29T00:00:00.000Z");
    assert.equal(next("0 0 31 * *", "2031-04-01T00:00:00Z"), "2031-05-31T00:00:00.000Z", "April has no 31st");
    assert.equal(next("0 9 * * 1-5", "2031-01-17T09:00:00Z"), "2031-01-20T09:00:00.000Z", "Friday to Monday");
});

test("nextCron: read on the zone's wall clock, across the shifts of the clock", () => {
    // Before the spring shift 09:00 in New York is 14:00 UTC, after it 13:00 UTC.
    assert.equal(next("0 9 * * *", "2031-03-08T15:00:00Z", NEW_YORK), "2031-03-09T13:00:00.000Z");
    assert.equal(next("0 9 * * *", "2031-03-07T15:00:00Z", NEW_YORK), "2031-03-08T14:00:00.000Z");
    assert.equal(next("0 9 * * *", "2031-03-08T15:00:00Z", zoneWall("Asia/Kolkata")), "2031-03-09T03:30:00.000Z", "a half-hour offset");
});

test("nextCron: a fixed time the clock skips in spring is due once, right after the jump, as in cronie", () => {
    // In Vancouver the clock jumps from 02:00 to 03:00 at 10:00 UTC on the day of the spring shift.
    assert.equal(next("30 2 * * *", "2031-03-08T20:00:00Z", VANCOUVER), "2031-03-09T10:00:00.000Z", "at 03:00, once");
    assert.equal(next("30 2 * * *", "2031-03-09T10:00:00Z", VANCOUVER), "2031-03-10T09:30:00.000Z", "then 02:30 as usual");
    assert.equal(next("0,30 2 * * *", "2031-03-09T09:00:00Z", VANCOUVER), "2031-03-09T10:00:00.000Z");
    assert.deepEqual(dueBetween({ cron: "0,30 2 * * *" }, at("2031-03-09T08:00:00Z"), at("2031-03-09T12:00:00Z"), VANCOUVER),
        { count: 1, oldest: at("2031-03-09T10:00:00Z"), newest: at("2031-03-09T10:00:00Z") }, "two skipped times, one run");
    assert.equal(next("0 3 * * *", "2031-03-09T09:00:00Z", VANCOUVER), "2031-03-09T10:00:00.000Z", "03:00 itself, once");
    assert.equal(next("0 3 * * *", "2031-03-09T10:00:00Z", VANCOUVER), "2031-03-10T10:00:00.000Z");
    // A star in the minute or hour field follows the wall clock: the skipped 02:xx times do not come that day.
    assert.equal(next("*/30 2 * * *", "2031-03-09T08:00:00Z", VANCOUVER), "2031-03-10T09:00:00.000Z");
    assert.equal(next("30 * * * *", "2031-03-09T09:00:00Z", VANCOUVER), "2031-03-09T09:30:00.000Z");
    assert.equal(next("30 * * * *", "2031-03-09T09:30:00Z", VANCOUVER), "2031-03-09T10:30:00.000Z", "03:30, no catch-up");
    assert.equal(next("30 2 * * *", "2031-03-08T17:00:00Z", NEW_YORK), "2031-03-09T07:00:00.000Z", "New York, 03:00 after the jump");
});

test("nextCron: a fixed time the clock repeats in autumn is due once, the first time, as in cronie", () => {
    // In Vancouver the clock goes back from 02:00 to 01:00 at 09:00 UTC on the day of the autumn shift.
    const once = parseCron("30 1 * * *");
    const first = nextCron(once, at("2031-11-01T20:00:00Z"), VANCOUVER);
    assert.equal(iso(first), "2031-11-02T08:30:00.000Z");
    assert.equal(iso(nextCron(once, first, VANCOUVER)), "2031-11-03T09:30:00.000Z", "not again at 09:30 UTC");
    const window = [at("2031-11-02T07:00:00Z"), at("2031-11-02T11:00:00Z")];
    assert.equal(dueBetween({ cron: "0,30 1 * * *" }, ...window, VANCOUVER).count, 2);
    assert.equal(dueBetween({ cron: "0 2 * * *" }, ...window, VANCOUVER).count, 1, "02:00 comes once in any case");
    // A star in the minute or hour field follows the wall clock, so it is due in both passes of the hour.
    assert.deepEqual(dueBetween({ cron: "*/30 1 * * *" }, ...window, VANCOUVER),
        { count: 4, oldest: at("2031-11-02T08:00:00Z"), newest: at("2031-11-02T09:30:00Z") });
    const twice = parseCron("30 1 * * *");
    assert.equal(iso(nextCron(twice, at("2031-11-01T12:00:00Z"), NEW_YORK)), "2031-11-02T05:30:00.000Z", "New York");
    assert.equal(iso(nextCron(twice, at("2031-11-02T05:30:00Z"), NEW_YORK)), "2031-11-03T06:30:00.000Z");
});

test("parseCron: a day field that starts with a star is unrestricted, as in Vixie cron and cronie", () => {
    const weekdays = parseCron("0 9 */1 * 1-5");
    assert.deepEqual([weekdays.domAny, weekdays.dowAny], [true, false]);
    assert.equal(cronMatches(weekdays, at("2031-01-18T09:00:00Z"), UTC), false, "a Saturday");
    assert.equal(cronMatches(weekdays, at("2031-01-20T09:00:00Z"), UTC), true, "a Monday");
    assert.equal(next("0 9 */1 * 1-5", "2031-01-17T09:00:00Z"), "2031-01-20T09:00:00.000Z", "Friday to Monday, weekdays only");
    const odd = parseCron("0 9 */2 * 1");
    assert.equal(cronMatches(odd, at("2031-01-13T09:00:00Z"), UTC), true, "the 13th, a Monday");
    assert.equal(cronMatches(odd, at("2031-01-20T09:00:00Z"), UTC), false, "a Monday, but the 20th");
    assert.equal(cronMatches(odd, at("2031-01-15T09:00:00Z"), UTC), false, "the 15th, but a Wednesday");
    assert.equal(parseCron("0 9 1 * */2").dowAny, true);
    assert.deepEqual([parseCron("0 2 * * *").fixed, parseCron("*/5 2 * * *").fixed, parseCron("0 */2 * * *").fixed], [true, false, false]);
});

test("nextCron: by default reads this computer's own time zone, as TZ sets it", () => {
    const script = [
        'const { nextCron, parseCron } = await import(process.argv[1]);',
        'const t = nextCron(parseCron("30 2 * * *"), Date.parse("2031-03-08T17:00:00Z"));',
        "console.log(new Date(t).toISOString());",
    ].join(" ");
    const cron = new URL("./cron.mjs", import.meta.url).href;
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script, cron], {
        env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8",
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), "2031-03-09T07:00:00.000Z", "02:30 is skipped that day, so 03:00 right after the jump");
});

test("nextDue and dueBetween: an every job is due at its creation plus whole steps", () => {
    const job = { every: "15m", createdAt: "2031-05-06T10:07:00.000Z" };
    assert.equal(iso(nextDue(job, at("2031-05-06T10:07:00Z"))), "2031-05-06T10:22:00.000Z");
    assert.equal(iso(nextDue(job, at("2031-05-06T10:00:00Z"))), "2031-05-06T10:22:00.000Z", "before it was made");
    assert.equal(iso(nextDue(job, at("2031-05-06T10:22:00Z"))), "2031-05-06T10:37:00.000Z");
    assert.deepEqual(dueBetween(job, at("2031-05-06T10:07:00Z"), at("2031-05-06T10:21:59Z")), { count: 0, oldest: null, newest: null });
    const due = dueBetween(job, at("2031-05-06T10:07:00Z"), at("2031-05-06T11:22:00Z"));
    assert.deepEqual([due.count, iso(due.oldest), iso(due.newest)], [5, "2031-05-06T10:22:00.000Z", "2031-05-06T11:22:00.000Z"]);
    assert.equal(dueBetween(job, at("2031-05-06T11:00:00Z"), at("2031-05-06T10:00:00Z")).count, 0, "a clock that went back");
    const daily = dueBetween({ every: "1d", createdAt: "2031-05-06T10:07:00.000Z" }, at("2031-05-06T10:07:00Z"), at("2031-05-16T10:07:00Z"));
    assert.equal(daily.count, 10);
});

test("dueBetween: a cron job's due times in the range, counted with the oldest and the newest", () => {
    const job = { cron: "0 * * * *", createdAt: "2031-05-06T10:07:00.000Z" };
    const due = dueBetween(job, at("2031-05-06T10:07:00Z"), at("2031-05-07T10:00:00Z"), UTC);
    assert.deepEqual([due.count, iso(due.oldest), iso(due.newest)], [24, "2031-05-06T11:00:00.000Z", "2031-05-07T10:00:00.000Z"]);
    assert.equal(dueBetween(job, at("2031-05-06T10:07:00Z"), at("2031-05-06T10:59:00Z"), UTC).count, 0);
    assert.equal(iso(nextDue({ cron: "0 2 * * *" }, at("2031-05-06T10:07:00Z"), UTC)), "2031-05-07T02:00:00.000Z");
    assert.equal(dueBetween({ cron: "* * * * *" }, at("2031-05-06T00:00:00Z"), at("2031-06-05T00:00:00Z"), UTC).count, 30 * 24 * 60);
});

test("timesText: how list shows the times of a job", () => {
    assert.equal(timesText({ every: "2h" }), "every 2h");
    assert.equal(timesText({ cron: "0 2 * * *" }), "cron 0 2 * * *");
});
