import test from "node:test";
import assert from "node:assert/strict";
import { buildCovdbgArguments, ensureArrayOfStrings } from "../runner/runnerArgs";
import * as path from "path";
import { dedupeNormalizedPaths, deriveCoverageBatchOutputPath } from "../runner/outputPaths";

test("buildCovdbgArguments builds expected covdbg CLI shape", () => {
    const args = buildCovdbgArguments(
        {
            workspaceRoot: "C:\\repo",
            configPath: "C:\\repo\\.covdbg.yaml",
            configuredOutputPath: "C:\\repo\\.covdbg\\coverage.covdb",
            outputPath: "C:\\repo\\.covdbg\\coverage.covdb",
            appDataPath: "C:\\repo\\.covdbg",
            workingDirectory: "C:\\repo",
        },
        "C:\\repo\\build\\tests.exe",
        ["--gtest_filter=Suite.*"],
    );

    assert.deepEqual(args, [
        "--config",
        "C:\\repo\\.covdbg.yaml",
        "--output",
        "C:\\repo\\.covdbg\\coverage.covdb",
        "C:\\repo\\build\\tests.exe",
        "--gtest_filter=Suite.*",
    ]);
});

test("buildCovdbgArguments omits --config when no config file was resolved", () => {
    const args = buildCovdbgArguments(
        {
            workspaceRoot: "C:\\repo",
            configPath: undefined,
            configuredOutputPath: "C:\\repo\\.covdbg\\coverage.covdb",
            outputPath: "C:\\repo\\.covdbg\\coverage.covdb",
            appDataPath: "C:\\repo\\.covdbg",
            workingDirectory: "C:\\repo",
        },
        "C:\\repo\\build\\tests.exe",
        ["--gtest_filter=Suite.*"],
    );

    assert.deepEqual(args, [
        "--output",
        "C:\\repo\\.covdbg\\coverage.covdb",
        "C:\\repo\\build\\tests.exe",
        "--gtest_filter=Suite.*",
    ]);
});

test("ensureArrayOfStrings filters non-strings and empty values", () => {
    const input: unknown = ["foo", " ", 1, null, "bar"];
    assert.deepEqual(ensureArrayOfStrings(input), ["foo", "bar"]);
});

test("deriveCoverageBatchOutputPath uses executable basename in the configured output directory", () => {
    assert.equal(
        deriveCoverageBatchOutputPath(
            "C:\\repo\\.covdbg\\coverage.covdb",
            "C:\\repo\\build\\suite.tests.exe",
        ),
        "C:\\repo\\.covdbg\\suite.tests.covdb",
    );
});

test("deriveCoverageBatchOutputPath ignores the configured output basename for intermediates", () => {
    assert.equal(
        deriveCoverageBatchOutputPath(
            "C:\\repo\\.covdbg\\nightly.covdb",
            "C:\\repo\\build\\suite.tests.exe",
        ),
        "C:\\repo\\.covdbg\\suite.tests.covdb",
    );
});

test("ensureArrayOfStrings gives nothing for a value that is not a list", () => {
    assert.deepEqual(ensureArrayOfStrings("--gtest_filter=A.*"), []);
    assert.deepEqual(ensureArrayOfStrings(undefined), []);
});

test("deriveCoverageBatchOutputPath keeps POSIX paths POSIX and names a nameless target coverage", () => {
    assert.equal(
        deriveCoverageBatchOutputPath("/repo/.covdbg/coverage.covdb", "/repo/build/suite tests"),
        "/repo/.covdbg/suite-tests.covdb",
    );
    assert.equal(
        deriveCoverageBatchOutputPath("C:/repo/.covdbg/coverage.covdb", "C:\\repo\\build\\--.exe"),
        "C:\\repo\\.covdbg\\coverage.covdb",
    );
});

test("dedupeNormalizedPaths keeps the first spelling of each path, whatever its case", () => {
    const first = path.join("repo", "out", "a.covdb");
    assert.deepEqual(
        dedupeNormalizedPaths([
            first,
            path.join("repo", "out", ".", "a.covdb"),
            path.join("REPO", "OUT", "A.covdb"),
            path.join("repo", "out", "b.covdb"),
        ]),
        [first, path.join("repo", "out", "b.covdb")],
    );
});
