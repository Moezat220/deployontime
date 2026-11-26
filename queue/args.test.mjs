import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLAGS, flagError } from "./args.mjs";

test("flagError: accepts each subcommand's own flags in both spellings", () => {
    assert.equal(flagError(["run", "--priority", "--label", "docs-site: build", "--max-wait=5", "--max-run", "40", "--kind", "build", "--after-fix", "raised the pool size", "--", "make"]), null);
    assert.equal(flagError(["passed", "--match", "lint", "--cwd=/srv/shop-api"]), null);
    assert.equal(flagError(["history", "--days", "3"]), null);
    assert.equal(flagError(["status"]), null);
});

test("flagError: refuses an unknown or misspelled flag, a stray word and a missing value", () => {
    assert.equal(flagError(["passed", "--mach", "lint"]), "unknown option --mach");
    assert.equal(flagError(["passed", "--match"]), "option --match needs a value");
    assert.equal(flagError(["history", "--day=2040-01-01", "--weeks", "2"]), "unknown option --weeks");
    assert.equal(flagError(["status", "now"]), 'unexpected word "now"');
    assert.equal(flagError(["run", "--max-runn=90", "--", "make"]), "unknown option --max-runn");
    assert.equal(flagError(["run", "-p", "--", "make"]), "unknown option -p");
});

test("flagError: an empty value is refused like a missing one", () => {
    assert.equal(flagError(["passed", "--match", ""]), "option --match needs a value");
    assert.equal(flagError(["passed", "--match="]), "option --match needs a value");
    assert.equal(flagError(["passed", "--cwd="]), "option --cwd needs a value");
    assert.equal(flagError(["run", "--kind=", "--", "make"]), "option --kind needs a value");
    assert.equal(flagError(["run", "--label=", "--", "make"]), "option --label needs a value");
    assert.equal(flagError(["history", "--days", ""]), "option --days needs a value");
});

test("flagError: a word that looks like a flag is never taken as a value", () => {
    assert.equal(flagError(["run", "--label", "--priority", "--", "make"]), "option --label needs a value");
    assert.equal(flagError(["passed", "--match", "--cwd", "/srv/shop-api"]), "option --match needs a value");
    assert.equal(flagError(["run", "--max-wait", "-1", "--", "make"]), null);
});

test("flagError: a flag given twice is refused", () => {
    assert.equal(flagError(["run", "--max-run", "5", "--max-run", "90", "--", "make"]), "option --max-run is given twice");
    assert.equal(flagError(["run", "--label=a", "--label", "b", "--", "make"]), "option --label is given twice");
    assert.equal(flagError(["run", "--priority", "--priority", "--", "make"]), "option --priority is given twice");
    assert.equal(flagError(["history", "--days", "2", "--days=3"]), "option --days is given twice");
});

test("flagError: run ignores everything behind the --, which belongs to the job", () => {
    assert.equal(flagError(["run", "--label", "shop-api: lint", "--", "pnpm", "lint", "--fix", "--max-runn", "1"]), null);
});

test("FLAGS: lists the subcommands the usage text names", () => {
    assert.deepEqual(Object.keys(FLAGS), ["run", "status", "passed", "history"]);
});
