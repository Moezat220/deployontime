// Time units and rounding that several modules use, written once.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A number rounded to one decimal place. */
export const oneDecimal = (x) => Math.round(x * 10) / 10;
