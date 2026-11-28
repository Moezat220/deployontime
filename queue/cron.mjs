// When a scheduled job is due: the two ways to give its times, `every` (a fixed step from the moment the job was
// added) and `cron` (the standard five fields), and the due times between two moments. Pure: the wall clock a cron
// expression is read in comes in as a function, by default this computer's own time zone.
import { MINUTE } from "./units.mjs";

const UNITS = { m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE };

/** An `every` step such as "15m", "2h" or "1d" in ms, or { error }. A whole number of 1 or more, then m, h or d. */
export function parseEvery(text) {
    const found = /^([1-9]\d{0,5})([mhd])$/.exec(String(text ?? ""));
    if (!found) return { error: `--every: "${text}" is not a step; give a whole number with m, h or d, such as 15m, 2h or 1d, at least 1m` };
    return { ms: Number(found[1]) * UNITS[found[2]] };
}

// The five fields in order: name, lowest and highest value.
const FIELDS = [["minute", 0, 59], ["hour", 0, 23], ["day of month", 1, 31], ["month", 1, 12], ["day of week", 0, 7]];

/** One field as the sorted set of values it allows, or { error }. Parts are joined by commas; each is `*`, a number,
 *  or a range a-b, optionally followed by /n. */
function parseField(text, [name, low, high]) {
    const values = new Set();
    for (const part of text.split(",")) {
        const found = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
        if (!found) return { error: `${name} field "${text}" is not understood; use *, numbers, a-b, a,b or */n` };
        const step = found[4] === undefined ? 1 : Number(found[4]);
        let from = low, to = high;
        if (found[1] !== "*") {
            from = Number(found[2]);
            to = found[3] === undefined ? (found[4] === undefined ? from : high) : Number(found[3]);
        }
        if (from < low || to > high || from > to) return { error: `${name} field "${text}" is out of range; ${name} runs from ${low} to ${high}` };
        if (step < 1) return { error: `${name} field "${text}" has a step of 0; a step is 1 or more` };
        for (let v = from; v <= to; v += step) values.add(v);
    }
    return { values };
}

/** A cron expression as { minute, hour, dom, month, dow } sets plus domAny, dowAny and fixed, or { error }. Day of
 *  week runs from 0 to 7, where both 0 and 7 are Sunday. As in Vixie cron and cronie, a field that starts with `*`,
 *  such as `*\/2`, counts as unrestricted: domAny and dowAny for the day rule, and a minute or hour field that starts
 *  with `*` makes the job not fixed, which matters when the clock shifts (see nextCron). */
export function parseCron(text) {
    const fields = String(text ?? "").trim().split(/\s+/);
    if (fields.length !== 5 || fields[0] === "") {
        return { error: `--cron: "${text}" needs 5 fields, minute hour day-of-month month day-of-week, such as "0 2 * * *"` };
    }
    const sets = [];
    for (let i = 0; i < 5; i++) {
        const field = parseField(fields[i], FIELDS[i]);
        if (field.error) return { error: `--cron: ${field.error}` };
        sets.push(field.values);
    }
    const [minute, hour, dom, month, dow] = sets;
    if (dow.has(7)) dow.add(0);
    dow.delete(7);
    const star = (i) => fields[i].startsWith("*");
    const spec = { minute, hour, dom, month, dow, domAny: star(2), dowAny: star(4), fixed: !star(0) && !star(1) };
    if (!canEverMatch(spec)) return { error: `--cron: "${text}" names a day that never comes, such as the 30th of February` };
    return spec;
}

// The most days each month can have, February in a leap year.
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Only a day of month that no allowed month has can keep an expression from ever matching; with a day of week
// restricted as well, the day of week alone can match.
function canEverMatch(spec) {
    if (!spec.dowAny && !spec.domAny) return true;
    return [...spec.month].some((m) => [...spec.dom].some((d) => d <= MONTH_DAYS[m - 1]));
}

/** The wall clock of this computer's time zone at a moment: { year, minute, hour, dom, month, dow }. */
export function localWall(ms) {
    const d = new Date(ms);
    return { year: d.getFullYear(), minute: d.getMinutes(), hour: d.getHours(), dom: d.getDate(), month: d.getMonth() + 1, dow: d.getDay() };
}

/** The name of this computer's time zone, in which cron expressions are read. */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** The wall clock of a named zone, for tests and for a zone other than the computer's own. */
export function zoneWall(zone) {
    const format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    return (ms) => {
        const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
        return { year: +p.year, minute: +p.minute, hour: +p.hour, dom: +p.day, month: +p.month, dow: DOW[p.weekday] };
    };
}

/** Does the day of a wall clock fit? With both day fields restricted, either one is enough, as in every cron. */
function dayFits(spec, w) {
    if (!spec.month.has(w.month)) return false;
    if (spec.domAny || spec.dowAny) return spec.dom.has(w.dom) && spec.dow.has(w.dow);
    return spec.dom.has(w.dom) || spec.dow.has(w.dow);
}

/** Does a moment's wall minute match the expression? */
export function cronMatches(spec, ms, wall = localWall) {
    return fits(spec, wall(ms));
}

// Far enough for the rarest day that can match, the 29th of February, also across a century year.
const SEARCH_MS = 9 * 366 * UNITS.d;
// Longer than any shift of a clock, so a shift that just happened is seen by looking back this far.
const SHIFT_LOOK_MS = 3 * 60 * MINUTE;

/** A wall clock as a count of minutes, as if it were UTC; one step per minute while the clock does not shift. */
const wallMinute = (w) => Date.UTC(w.year, w.month - 1, w.dom, w.hour, w.minute) / MINUTE;
/** The wall clock of such a count. */
function wallOf(count) {
    const d = new Date(count * MINUTE);
    return { minute: d.getUTCMinutes(), hour: d.getUTCHours(), dom: d.getUTCDate(), month: d.getUTCMonth() + 1, dow: d.getUTCDay() };
}
const fits = (spec, w) => dayFits(spec, w) && spec.hour.has(w.hour) && spec.minute.has(w.minute);
/** How far ahead of UTC the wall clock is at a moment, in minutes. */
const ahead = (t, wall) => wallMinute(wall(t)) - t / MINUTE;

/** Is the wall minute at t one the clock already showed, because it moved back less than SHIFT_LOOK_MS ago? */
function repeated(t, wall) {
    const back = ahead(t - SHIFT_LOOK_MS, wall) - ahead(t, wall);
    return back > 0 && ahead(t - back * MINUTE, wall) === ahead(t - SHIFT_LOOK_MS, wall);
}
/** Did the clock jump ahead just before t, over a wall minute that matches? */
function jumpedOver(spec, t, w, wall) {
    const before = wallMinute(wall(t - MINUTE));
    for (let m = before + 1; m < wallMinute(w); m++) if (fits(spec, wallOf(m))) return true;
    return false;
}

/** The first whole minute strictly after `after` that matches, or null. Minutes are read on the wall clock, and a
 *  shift of the clock is met as cronie meets it: a fixed time (minute and hour fields that do not start with `*`) the
 *  clock skips when it moves ahead is due once, at the first minute after the jump; one it repeats when it moves back
 *  is due once, the first time. A job with `*` in its minute or hour field just follows the wall clock: it is due at
 *  the times the clock shows, also in a repeated hour. A day or hour that does not fit is passed over to the next
 *  whole hour. */
export function nextCron(spec, after, wall = localWall) {
    let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
    const end = after + SEARCH_MS;
    while (t <= end) {
        const w = wall(t);
        // A clock moves ahead on a whole or a half hour, and the minutes it skips lie on the day it lands on.
        if (spec.fixed && (w.minute === 0 || w.minute === 30) && dayFits(spec, w) && jumpedOver(spec, t, w, wall)) return t;
        if (!dayFits(spec, w) || !spec.hour.has(w.hour)) {
            t += (60 - w.minute) * MINUTE;
            continue;
        }
        if (spec.minute.has(w.minute) && !(spec.fixed && repeated(t, wall))) return t;
        t += MINUTE;
    }
    return null;
}

/** The next due time of a job strictly after a moment, or null. job: { every?, cron?, createdAt }; an `every` job is
 *  due at createdAt plus whole steps. */
export function nextDue(job, after, wall = localWall) {
    if (job.every) {
        const step = parseEvery(job.every).ms;
        const anchor = Date.parse(job.createdAt);
        if (after < anchor) return anchor + step;
        return anchor + (Math.floor((after - anchor) / step) + 1) * step;
    }
    const spec = parseCron(job.cron);
    return spec.error ? null : nextCron(spec, after, wall);
}

/** The due times of a job in (from, to]: { count, oldest, newest }, with oldest and newest null when there are none. */
export function dueBetween(job, from, to, wall = localWall) {
    if (!(to > from)) return { count: 0, oldest: null, newest: null };
    if (job.every) {
        const step = parseEvery(job.every).ms;
        const first = nextDue(job, from, wall);
        if (first > to) return { count: 0, oldest: null, newest: null };
        const count = Math.floor((to - first) / step) + 1;
        return { count, oldest: first, newest: first + (count - 1) * step };
    }
    const spec = parseCron(job.cron);
    let count = 0, oldest = null, newest = null;
    for (let t = spec.error ? null : nextCron(spec, from, wall); t !== null && t <= to; t = nextCron(spec, t, wall)) {
        count++;
        oldest ??= t;
        newest = t;
    }
    return { count, oldest, newest };
}

/** How a job's times read in `schedule list`: "every 15m" or "cron 0 2 * * *". */
export const timesText = (job) => (job.every ? `every ${job.every}` : `cron ${job.cron}`);
