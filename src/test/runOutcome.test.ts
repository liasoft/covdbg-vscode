import test from "node:test";
import assert from "node:assert/strict";
import { LineBuffer } from "../runner/lineBuffer";
import {
    RunNotice,
    classifyRunLine,
    endsSignIn,
    pickBatchToast,
    summarizeNotices,
} from "../runner/runOutcome";

// The messages below are the real ones: the license service's (EntitlementService.cs), covdbg's
// local refusal and offline fallback (EntitlementCheck.cpp), and what FinalizeEntitlement prints.

test("the line buffer hands out whole lines however the pipe splits them", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));
    buffer.push("covdbg: This run is not ");
    buffer.push("licensed: Sign in with `covdbg login`.\r");
    buffer.push("\nsecond line\nthird");
    assert.deepEqual(lines, [
        "covdbg: This run is not licensed: Sign in with `covdbg login`.",
        "second line",
    ]);
    buffer.flush();
    assert.deepEqual(lines.slice(2), ["third"]);
});

test("refusals are read from stderr and routed to their fix", () => {
    const refusals: [string, RunNotice["action"]][] = [
        ["Sign in with `covdbg login`, or set COVDBG_PROJECT_TOKEN in CI.", "signIn"],
        ["This session no longer belongs to anybody. Run `covdbg login` again.", "signIn"],
        ["Not signed in. Run `covdbg login`, or set COVDBG_PROJECT_TOKEN in CI.", "signIn"],
        [
            "covdbg could not identify this repository: it has no remote and no commits yet. " +
                "Add a remote or make a first commit, then run again.",
            undefined,
        ],
        [
            "Your personal use of covdbg is locked to github.com/acme/app. Release the lock on your " +
                "profile page, or ask a team for a seat.",
            "openProfile",
        ],
        ["Something the editor does not know yet.", "openApp"],
    ];
    for (const [message, action] of refusals) {
        assert.deepEqual(
            classifyRunLine("stderr", `covdbg: This run is not licensed: ${message}`),
            {
                kind: "refused",
                message,
                action,
            },
        );
    }
    // A refusal is only ever logged as an error.
    assert.equal(classifyRunLine("stdout", "This run is not licensed: nope"), undefined);
    assert.equal(classifyRunLine("stderr", "covdbg: program: File does not exist"), undefined);
});

test("an offline fallback that names covdbg login means the sign-in has ended", () => {
    const problem = "Sign in with `covdbg login`, or set COVDBG_PROJECT_TOKEN in CI.";
    for (const line of [
        `covdbg: The license service could not be reached (${problem}); proceeding on your credential.`,
        `covdbg: The license service could not be reached (${problem}); using the last decision, ` +
            "which is good offline until 2026-10-01 12:00 UTC.",
    ]) {
        assert.deepEqual(classifyRunLine("stdout", line), {
            kind: "sessionInvalid",
            message: "Your sign-in has ended.",
            action: "signIn",
        });
    }
});

test("with a project token, a rejected credential is the token's, not an ended sign-in", () => {
    const problem = "Sign in with `covdbg login`, or set COVDBG_PROJECT_TOKEN in CI.";
    assert.deepEqual(
        classifyRunLine(
            "stdout",
            `covdbg: The license service could not be reached (${problem}); proceeding on your credential.`,
            true,
        ),
        {
            kind: "message",
            message: "The license service did not accept COVDBG_PROJECT_TOKEN.",
            action: "openApp",
        },
    );
    assert.deepEqual(
        classifyRunLine("stderr", `covdbg: This run is not licensed: ${problem}`, true),
        { kind: "refused", message: problem, action: "openApp" },
    );
});

test("a plain offline fallback is passed on as it stands", () => {
    for (const message of [
        "The license service could not be reached (Could not resolve host); proceeding on your credential.",
        "The license service could not be reached (timed out); using the last decision, which is good " +
            "offline until 2026-10-01 12:00 UTC.",
    ]) {
        assert.deepEqual(classifyRunLine("stdout", `covdbg: ${message}\r`), {
            kind: "message",
            message,
        });
    }
});

test("a new personal lock offers the profile page", () => {
    for (const repository of [
        "the repository with root commit 0123456789ab",
        "github.com/acme/app",
    ]) {
        const message =
            `Personal use of covdbg is now locked to ${repository}. Public repositories stay free ` +
            "everywhere; for more private repositories, ask a team for a seat.";
        assert.deepEqual(classifyRunLine("stdout", `covdbg: ${message}`), {
            kind: "lockSet",
            message,
            action: "openProfile",
        });
    }
});

test("gated reporting is a notice without an action", () => {
    const message =
        "coverage reporting is gated for this account. The analysis runs, and the database keeps only " +
        "the ten most-hit files.";
    assert.deepEqual(classifyRunLine("stdout", `covdbg: ${message}`), { kind: "gated", message });
});

test("covdbg's progress lines and the target's own output are not notices", () => {
    for (const line of [
        "covdbg: collecting coverage for C:/quick-start/build/Debug/test_app.exe",
        "covdbg: coverage written to C:/quick-start/.covdbg/coverage.covdb",
        "covdbg: no coverage database was written to C:/quick-start/.covdbg/coverage.covdb",
        "covdbg: 1 of 1 basic blocks hit (100.0%), analysis 82 ms, run 30 ms",
        // covdbg 1.5.1's summary below the program's output (PrintRunSummary in covdbg's main.cpp)
        "covdbg: test_app.exe exited with code 0",
        "covdbg: test_app.exe exited with code 1; covdbg's own exit code does not carry it (see --propagate-exit-code)",
        "covdbg: test_app.exe exited with 0xc0000005; covdbg's own exit code does not carry it (see --propagate-exit-code)",
        "covdbg: continued past 2 breakpoint(s) the program did not handle (__debugbreak, DebugBreak); without a debugger it would have ended at the first",
        "covdbg: nothing was measured: no function of test_app.exe passes the coverage filter of .covdbg.yaml",
        "covdbg: an empty coverage database was written to C:/quick-start/.covdbg/coverage.covdb",
        "[  PASSED  ] 3 tests.",
        "",
    ]) {
        assert.equal(classifyRunLine("stdout", line), undefined, line);
    }
});

test("a batch shows at most one toast, and only for a refusal", () => {
    const gated: RunNotice = { kind: "gated", message: "gated" };
    const lock: RunNotice = { kind: "lockSet", message: "lock", action: "openProfile" };
    const first: RunNotice = { kind: "refused", message: "first", action: "signIn" };
    const second: RunNotice = { kind: "refused", message: "second", action: "openApp" };

    assert.equal(pickBatchToast([gated, lock]), undefined);
    assert.equal(pickBatchToast([gated, first, second]), first);
    assert.equal(summarizeNotices([first, gated, second, lock]), second);
    assert.equal(summarizeNotices([gated, lock]), lock);
    assert.equal(summarizeNotices([]), undefined);
});

test("a sign-in refusal or an ended session signs the editor out; other refusals do not", () => {
    assert.equal(endsSignIn([{ kind: "sessionInvalid", message: "", action: "signIn" }]), true);
    assert.equal(endsSignIn([{ kind: "refused", message: "", action: "signIn" }]), true);
    assert.equal(endsSignIn([{ kind: "refused", message: "", action: "openProfile" }]), false);
    assert.equal(endsSignIn([{ kind: "gated", message: "" }]), false);
});
