import { test } from "node:test";
import assert from "node:assert/strict";
import { clockTime, dateTime, dayOf, dayStart, minutesSince, shiftDay, zoneOffset } from "./clock.mjs";

const HOUR = 3_600_000;
const MOMENT = Date.UTC(2031, 6, 20, 9, 40);

test("clockTime: 24-hour time with the zone name", () => {
    assert.equal(clockTime(MOMENT, "UTC"), "09:40 UTC");
    assert.equal(clockTime(MOMENT, "Asia/Kolkata"), "15:10 GMT+5:30");
    assert.equal(clockTime(Date.UTC(2031, 6, 20, 0, 0), "UTC"), "00:00 UTC");
});

test("dateTime: day, time and zone name", () => {
    assert.equal(dateTime(MOMENT, "UTC"), "2031-07-20 09:40 UTC");
    assert.equal(dateTime(Date.UTC(2031, 6, 20, 21, 5), "Asia/Kolkata"), "2031-07-21 02:35 GMT+5:30");
});

test("dayOf: the calendar day in the zone", () => {
    assert.equal(dayOf(MOMENT, "UTC"), "2031-07-20");
    assert.equal(dayOf(MOMENT, "Asia/Tokyo"), "2031-07-20");
    assert.equal(dayOf(Date.UTC(2031, 6, 20, 16), "Asia/Tokyo"), "2031-07-21");
});

test("shiftDay: moves across month, year and leap-day borders", () => {
    assert.equal(shiftDay("2032-03-01", -1), "2032-02-29");
    assert.equal(shiftDay("2031-01-01", -1), "2030-12-31");
    assert.equal(shiftDay("2031-01-31", 31), "2031-03-03");
    assert.equal(shiftDay("2031-07-20", 0), "2031-07-20");
});

test("zoneOffset: how far the zone is ahead of UTC", () => {
    assert.equal(zoneOffset(MOMENT, "UTC"), 0);
    assert.equal(zoneOffset(MOMENT, "Asia/Kolkata"), 5.5 * HOUR);
    assert.equal(zoneOffset(MOMENT, "Asia/Tokyo"), 9 * HOUR);
});

test("dayStart: local midnight, also on a day when the clocks change", () => {
    assert.equal(dayStart("2031-07-20", "UTC"), Date.UTC(2031, 6, 20));
    assert.equal(dayStart("2031-07-20", "Asia/Kolkata"), Date.UTC(2031, 6, 19, 18, 30));
    // Berlin moves its clocks forward on this day: it starts 1 hour ahead of UTC and the next day starts 2 ahead.
    assert.equal(dayStart("2031-03-30", "Europe/Berlin"), Date.UTC(2031, 2, 29, 23));
    assert.equal(dayStart("2031-03-31", "Europe/Berlin"), Date.UTC(2031, 2, 30, 22));
});

test("minutesSince: rounds to whole minutes and is never negative", () => {
    assert.equal(minutesSince(MOMENT, MOMENT + 150_000), 3);
    assert.equal(minutesSince(MOMENT, MOMENT + 20_000), 0);
    assert.equal(minutesSince(MOMENT + 5 * 60_000, MOMENT), 0);
});
