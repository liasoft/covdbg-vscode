import test from "node:test";
import assert from "node:assert/strict";
import { findBestCoverageKey } from "../coverage/coverageKeyMatcher";

test("findBestCoverageKey prefers exact path matches", () => {
    const result = findBestCoverageKey(
        "D:\\Code\\covdbg\\quick-start\\src\\main.cpp",
        [
            "D:\\Code\\covdbg\\quick-start\\src\\main.cpp",
            "D:\\Code\\covdbg\\quick-start-2\\src\\main.cpp",
        ],
        "D:\\Code\\covdbg\\quick-start",
    );

    assert.equal(result, "D:\\Code\\covdbg\\quick-start\\src\\main.cpp");
});

test("findBestCoverageKey rejects ambiguous suffix-only matches", () => {
    const result = findBestCoverageKey(
        "D:\\Code\\covdbg\\workspace\\src\\main.cpp",
        [
            "D:\\Code\\covdbg\\quick-start\\src\\main.cpp",
            "D:\\Code\\covdbg\\quick-start-2\\src\\main.cpp",
        ],
        undefined,
    );

    assert.equal(result, undefined);
});

test("findBestCoverageKey uses workspace-relative uniqueness", () => {
    const result = findBestCoverageKey(
        "D:\\Code\\covdbg\\quick-start\\src\\main.cpp",
        ["src\\main.cpp", "src\\other.cpp"],
        "D:\\Code\\covdbg\\quick-start",
    );

    assert.equal(result, "src\\main.cpp");
});

test("findBestCoverageKey matches workspace-relative keys on POSIX and UNC paths too", () => {
    assert.equal(
        findBestCoverageKey(
            "/home/dev/app/src/main.cpp",
            ["src/main.cpp", "src/util.cpp"],
            "/home/dev/app",
        ),
        "src/main.cpp",
    );
    assert.equal(
        findBestCoverageKey(
            "\\\\server\\share\\app\\src\\main.cpp",
            ["src\\main.cpp", "src\\util.cpp"],
            "\\\\server\\share\\app",
        ),
        "src\\main.cpp",
    );
});

test("findBestCoverageKey falls back to a unique suffix for a file outside the workspace", () => {
    assert.equal(
        findBestCoverageKey(
            "D:\\sdk\\include\\vector.h",
            ["include\\vector.h", "src\\main.cpp"],
            "D:\\app",
        ),
        "include\\vector.h",
    );
    assert.equal(
        findBestCoverageKey("main.cpp", ["D:\\app\\src\\main.cpp", "D:\\app\\src\\util.cpp"]),
        "D:\\app\\src\\main.cpp",
        "a recorded path may also end with the editor's",
    );
});

test("findBestCoverageKey gives up when several keys match the workspace-relative path", () => {
    assert.equal(
        findBestCoverageKey(
            "D:\\app\\src\\main.cpp",
            ["D:\\old\\src\\main.cpp", "E:\\copy\\src\\main.cpp"],
            "D:\\app",
        ),
        undefined,
    );
});
