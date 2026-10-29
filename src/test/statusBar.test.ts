import { vscodeStub } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import { StatusBar } from "../views/statusBar";
import type { RunNotice } from "../runner/runOutcome";
import type { RuntimeState } from "../runner/runnerTypes";

const OK: RuntimeState = { kind: "ok", path: "C:/covdbg.exe", version: "1.4.0", source: "path" };
const SESSION_ENDED: RunNotice = {
    kind: "sessionInvalid",
    message: "Your sign-in has ended.",
    action: "signIn",
};
const LOCKED: RunNotice = { kind: "lockSet", message: "Runs are locked.", action: "openProfile" };

/** A new status bar and the item it draws on. */
function statusBar() {
    const bar = new StatusBar();
    const items = vscodeStub.window.statusBarItems;
    return { bar, item: items[items.length - 1] };
}

test("the item is named covdbg and hidden until coverage loads", () => {
    const { bar, item } = statusBar();

    bar.setIdle();

    assert.equal(item.name, "covdbg");
    assert.equal(item.visible, false);
    assert.equal(item.command, "covdbg.showMenu");
});

test("loaded coverage shows its percentage, whether it is shown, and how", () => {
    const { bar, item } = statusBar();

    bar.setLoaded(72.345);

    assert.equal(item.visible, true);
    assert.equal(item.text, "$(beaker) 72.3%");
    assert.equal(item.tooltip, "covdbg - Coverage ON (Gutter)");
    assert.equal(item.command, "covdbg.showMenu");

    bar.setRenderMode("line");
    assert.equal(item.tooltip, "covdbg - Coverage ON (Line)");
    bar.setRenderMode("both");
    assert.equal(item.tooltip, "covdbg - Coverage ON (Both)");
});

test("toggling coverage flips it and says so", () => {
    const { bar, item } = statusBar();
    bar.setLoaded(50);

    assert.equal(bar.isCoverageEnabled(), true);
    assert.equal(bar.toggleCoverage(), false);
    assert.equal(bar.isCoverageEnabled(), false);
    assert.equal(item.tooltip, "covdbg - Coverage OFF (Gutter)");
    assert.equal(bar.toggleCoverage(), true);
});

test("the tooltip names the covdbg that runs and what it said about the last run", () => {
    const { bar, item } = statusBar();
    bar.setLoaded(50);

    bar.setAuth({ kind: "signedIn", email: "dev@example.com" }, LOCKED, OK);

    assert.equal(
        item.tooltip,
        "covdbg - Coverage ON (Gutter)\ncovdbg 1.4.0 (PATH)\nRuns are locked.",
    );

    bar.setAuth({ kind: "signedIn", email: "dev@example.com" }, undefined, { kind: "missing" });
    assert.equal(item.tooltip, "covdbg - Coverage ON (Gutter)");
});

test("a run in progress spins, and ending it shows the coverage again", () => {
    const { bar, item } = statusBar();
    bar.setLoaded(40);

    bar.setRunning();
    assert.equal(item.visible, true);
    assert.equal(item.text, "$(sync~spin) covdbg");
    assert.equal(item.tooltip, "covdbg - Coverage run in progress");

    bar.setRunFinished();
    assert.equal(item.text, "$(beaker) 40.0%");
});

test("a sign-in in progress shows the code to confirm, even with nothing loaded", () => {
    const { bar, item } = statusBar();

    bar.setAuth(
        { kind: "signingIn", url: "https://app.covdbg.com/device", code: "ABCD-1234" },
        undefined,
        OK,
    );

    assert.equal(item.visible, true);
    assert.equal(item.text, "$(account) Sign in to covdbg");
    assert.equal(item.tooltip, "covdbg - Confirm the code ABCD-1234 in your browser");
    assert.equal(item.command, "covdbg.signIn");
});

test("a run that needs a sign-in asks for one; being signed out alone does not", () => {
    const { bar, item } = statusBar();
    bar.setLoaded(60);

    bar.setAuth({ kind: "signedOut" }, SESSION_ENDED, OK);
    assert.equal(item.text, "$(account) Sign in to covdbg");
    assert.equal(item.tooltip, "covdbg - Your sign-in has ended.");
    assert.equal(item.command, "covdbg.signIn");

    bar.setAuth({ kind: "signedOut" }, LOCKED, OK);
    assert.equal(item.text, "$(beaker) 60.0%");
    assert.equal(item.command, "covdbg.showMenu");

    bar.setAuth({ kind: "signedOut" }, undefined, OK);
    assert.equal(item.text, "$(beaker) 60.0%");
});

test("disposing frees the item", () => {
    const { bar, item } = statusBar();

    bar.dispose();

    assert.equal(item.disposed, true);
});
