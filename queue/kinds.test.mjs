import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cmdStem, DEBUG_CMD_RE, DEBUG_LABEL_RE, KINDS, kindOf } from "./kinds.mjs";

const isDebug = (label, command) => kindOf(label, command) === "debug";

test("isDebug: a debug word or a question mark in the label's task part, or a debug word in a command the label leaves open", () => {
    assert.equal(DEBUG_LABEL_RE.test("docs-site: is the sitemap stale?"), true);
    assert.equal(DEBUG_CMD_RE.test("node tools/bisect-flaky.mjs"), true);
    for (const [label, command] of [["shop-api: repro of the timeout", "pnpm test"], ["shop-api: nightly", "node scripts/probe.mjs"], ["mobile-app: why is the bundle big?", "make size"], ["shop-api: Debug run", "pnpm test"]]) {
        assert.equal(isDebug(label, command), true, label);
    }
    for (const [label, command] of [["shop-api: suite", "DEBUG=api pnpm test"], ["docs-site: build", "pnpm run build"], ["mobile-app: debugger bundle", "make bundle"], ["probe-api: suite", "pnpm test"], ["shop-api: suite", "node scripts/probe.mjs"], [undefined, undefined]]) {
        assert.equal(isDebug(label, command), false, String(label));
    }
});

test("kindOf: a given kind wins; the label's task part is read before the command, a debug word before the kind list", () => {
    assert.deepEqual(KINDS.map(([name]) => name), ["deploy", "test", "build", "lint"]);
    const cases = [
        ["mobile-app: publish to the store", "make ship", undefined, "deploy"],
        ["docs-site: compile, then link check", "make all", undefined, "test"],
        ["shop-api: bundle and format", "make all", undefined, "build"],
        ["shop-api: typecheck", "pnpm exec tsc --noEmit", undefined, "lint"],
        ["shop-api: nightly", "npx playwright test", undefined, "test"],
        ["test: nightly", "make nightly", undefined, "other"],
        ["shop-api: nightly", "make nightly", undefined, "other"],
        ["shop-api: nightly", "make nightly", "Deploy", "deploy"],
        ["shop-api: repro of the release failure", "make release", undefined, "debug"],
        ["shop-api: repro of the release failure", "make release", "test", "test"],
        ["shop-api: unit tests", "npm run probe", undefined, "test"],
        ["probe-api: unit tests", "npm test", undefined, "test"],
        ["probe-api: nightly", "make nightly", undefined, "other"],
        ["shop-api: nightly", "node scripts/probe.mjs", undefined, "debug"],
    ];
    for (const [label, command, given, kind] of cases) assert.equal(kindOf(label, command, given), kind, `${label} | ${command}`);
});

test("cmdStem: keeps the program and its task, drops paths, flags and variables", () => {
    const cases = [
        ["pnpm run lint --fix", "pnpm run lint"],
        ["yarn test --coverage", "yarn test"],
        ["pnpm exec tsc --noEmit", "pnpm exec tsc"],
        ["NODE_ENV=test env TZ=UTC /opt/tools/bin/node scripts/migrate.mjs --dry", "node migrate.mjs"],
        ["npx playwright test --project=mobile", "npx playwright test"],
        ["npx tsx scripts/export.ts ./out", "npx tsx export.ts"],
        ["npx eslint ./src", "npx eslint"],
        ["bunx vitest run", "bunx vitest run"],
        ["python3 tools/report.py --week", "python3 report.py"],
        ["make dist ./out", "make dist"],
        ["cargo build --release", "cargo build"],
        ["./scripts/run-all.sh quick", "run-all.sh quick"],
        ["/usr/bin/true", "true"],
    ];
    for (const [command, stem] of cases) assert.equal(cmdStem(command), stem, command);
});

test("cmdStem: joins the stems of the commands inside sh -c", () => {
    assert.equal(cmdStem('bash -c "pnpm run build && pnpm run lint; node scripts/pack.mjs"'), "pnpm run build && pnpm run lint && node pack.mjs");
    assert.equal(cmdStem('sh -c "make docs | tee build.log"'), "make docs && tee build.log");
});

test("cmdStem: null for inline code and for an empty command", () => {
    for (const command of ["CI=1", 'bun --eval "0"', 'bash -c ""', undefined, 'tsx -e "void 0"', 'python3 -c "print(1)"', ""]) assert.equal(cmdStem(command), null, String(command));
});
