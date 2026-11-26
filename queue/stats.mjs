// Statistics shared by the run limits and `history`, so both mean the same thing by a percentile.

/** Nearest-rank percentile, p from 0 to 1; null for an empty list. */
export function pctl(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
