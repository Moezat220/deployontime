// Clock helpers. Times shown to people use a 24-hour clock in the configured zone, and calendar days are counted in
// that zone too.

const MINUTE = 60_000;

function wallParts(ms, zone) {
    const format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23", timeZoneName: "short",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    return Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
}

/** Hours and minutes with the zone name: "HH:MM UTC". */
export function clockTime(ms, zone = "UTC") {
    const p = wallParts(ms, zone);
    return `${p.hour}:${p.minute} ${p.timeZoneName}`;
}
/** Day, hours and minutes with the zone name: "YYYY-MM-DD HH:MM UTC". */
export function dateTime(ms, zone = "UTC") {
    const p = wallParts(ms, zone);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}
/** The calendar day as "YYYY-MM-DD". */
export function dayOf(ms, zone = "UTC") {
    const p = wallParts(ms, zone);
    return `${p.year}-${p.month}-${p.day}`;
}

/** A "YYYY-MM-DD" day moved by a number of days. */
export function shiftDay(day, by) {
    const [year, month, date] = day.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, date + by)).toISOString().slice(0, 10);
}

/** Milliseconds the zone's wall clock is ahead of UTC at a moment. */
export function zoneOffset(ms, zone = "UTC") {
    const p = wallParts(ms, zone);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** The moment a "YYYY-MM-DD" day begins in the zone. */
export function dayStart(day, zone = "UTC") {
    const [year, month, date] = day.split("-").map(Number), asUtc = Date.UTC(year, month - 1, date);
    // The offset is looked up twice because it can differ between the first guess and the real midnight.
    const guess = asUtc - zoneOffset(asUtc, zone);
    return asUtc - zoneOffset(guess, zone);
}

export const minutesSince = (then, now = Date.now()) => Math.max(0, Math.round((now - then) / MINUTE));
