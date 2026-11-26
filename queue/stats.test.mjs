import { test } from "node:test";
import assert from "node:assert/strict";
import { pctl } from "./stats.mjs";

test("pctl: nearest rank on a sorted copy", () => {
    const values = [40, 10, 30, 20, 50];
    assert.deepEqual([0, 0.2, 0.5, 0.75, 0.9, 1].map((p) => pctl(values, p)), [10, 10, 30, 40, 50, 50]);
    assert.deepEqual(values, [40, 10, 30, 20, 50]);
    assert.equal(pctl([], 0.5), null);
    assert.equal(pctl([7], 0.9), 7);
});
