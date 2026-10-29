import { vscodeStub, stubFolder } from "./vscodeStub";
import type * as vscode from "vscode";
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import type { CovdbFileSummary } from "../coverage/covdbParser";
import {
    MenuActions,
    MenuContext,
    showDatabaseSwitcher,
    showFileBrowser,
    showMenu,
} from "../views/menuPopup";
import { tempFolder, writeFile } from "./fixtures";

const window = vscodeStub.window;
const ROOT = path.resolve("app");
const ACTIVE = path.join(ROOT, ".covdbg", "coverage.covdb");
const OTHER = path.join(ROOT, "build", "other.covdb");
/** The active database, spelled as a file-system event might: the same file, in other case. */
const ACTIVE_FOUND = path.join(ROOT, ".covdbg", "COVERAGE.covdb");

type Item = { label: string; description?: string; detail?: string };

function summary(filePath: string, totalLines: number, coveredLines: number): CovdbFileSummary {
    return {
        filePath,
        totalLines,
        coveredLines,
        coveragePercent: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
    };
}

function context(overrides: Partial<MenuContext> = {}): MenuContext {
    return {
        isLoaded: true,
        isCoverageEnabled: true,
        activeCovdbPath: ACTIVE,
        fileIndex: new Map([
            ["a.cpp", summary("a.cpp", 10, 4)],
            ["b.cpp", summary("b.cpp", 20, 16)],
        ]),
        currentRenderMode: "gutter",
        availableCovdbFiles: [ACTIVE_FOUND, OTHER].map((p) =>
            vscodeStub.Uri.file(p),
        ) as unknown as vscode.Uri[],
        ...overrides,
    };
}

/** Actions that record what the menu asked for, as `name arg`. */
function recorder() {
    const calls: string[] = [];
    const actions: MenuActions = {
        toggle: () => calls.push("toggle"),
        setRenderMode: (mode) => calls.push(`setRenderMode ${mode}`),
        showReport: () => calls.push("showReport"),
        configure: () => calls.push("configure"),
        switchDatabase: (covdbPath) => calls.push(`switchDatabase ${covdbPath}`),
        closeDatabase: () => calls.push("closeDatabase"),
    };
    return { calls, actions };
}

/**
 * Answers quick picks in turn, each with the first item whose label contains the text, a
 * separator for "", or nothing for undefined; returns the items each one offered.
 */
function answer(...choices: (string | undefined)[]): Item[][] {
    const offered: Item[][] = [];
    window.pick = (items) => {
        offered.push(items as Item[]);
        const choice = choices.shift();
        return choice === undefined
            ? undefined
            : items.find((item) => (choice ? item.label.includes(choice) : item.label === ""));
    };
    return offered;
}

test("the menu shows the database, its coverage, the render modes and the actions", async () => {
    const offered = answer(undefined);

    await showMenu(context(), recorder().actions);

    const items = offered[0];
    assert.deepEqual(
        items.map((item) => item.label),
        [
            "Coverage Database",
            "$(database)  coverage.covdb",
            "Rendering",
            "$(blank)  Full Line",
            "$(check)  Gutter",
            "$(blank)  Both",
            "",
            "$(graph)  Coverage Report",
            "$(eye-closed)  Hide Coverage",
        ],
    );
    assert.equal(items[1].description, "2 files — click to switch");
    assert.equal(items[1].detail, "    20 / 30 lines — 66.7%");
});

test("with coverage hidden the menu offers to show it, and no lines read as 0%", async () => {
    const offered = answer(undefined);

    await showMenu(
        context({ isCoverageEnabled: false, fileIndex: new Map(), currentRenderMode: "line" }),
        recorder().actions,
    );

    const labels = offered[0].map((item) => item.label);
    assert.ok(labels.includes("$(eye)  Show Coverage"));
    assert.ok(labels.includes("$(check)  Full Line"));
    assert.equal(offered[0][1].detail, "    0 / 0 lines — 0.0%");
});

test("each menu entry does what it says", async () => {
    const { calls, actions } = recorder();

    for (const choice of ["Hide Coverage", "Both", "Coverage Report"]) {
        answer(choice);
        await showMenu(context(), actions);
    }

    assert.deepEqual(calls, ["toggle", "setRenderMode both", "showReport"]);
});

test("dismissing the menu, or choosing a heading, does nothing", async () => {
    const { calls, actions } = recorder();

    answer(undefined);
    await showMenu(context(), actions);
    answer("Rendering");
    await showMenu(context(), actions);

    assert.deepEqual(calls, []);
});

test("choosing the database opens the switcher", async () => {
    const { calls, actions } = recorder();
    const offered = answer("coverage.covdb", "Browse");

    await showMenu(context(), actions);

    assert.equal(offered.length, 2);
    assert.equal(offered[1][0].label, "$(close)  Close Current Database");
    assert.deepEqual(calls, ["configure"]);
});

test("with nothing loaded the menu is the switcher", async () => {
    for (const ctx of [context({ isLoaded: false }), context({ activeCovdbPath: undefined })]) {
        const offered = answer(undefined);

        await showMenu(ctx, recorder().actions);

        assert.equal(offered.length, 1);
        assert.ok(offered[0].some((item) => item.label.includes("Browse for .covdb File")));
    }
});

test("the switcher lists the workspace's databases and marks the active one", async () => {
    vscodeStub.workspace.workspaceFolders = [stubFolder(ROOT)];
    const offered = answer(undefined);

    await showDatabaseSwitcher(context(), recorder().actions);

    assert.deepEqual(
        offered[0].map((item) => [item.label, item.description]),
        [
            ["$(close)  Close Current Database", "coverage.covdb"],
            ["", undefined],
            ["$(check)  .covdbg/COVERAGE.covdb", "active"],
            ["$(database)  build/other.covdb", ""],
            ["", undefined],
            ["$(folder-opened)  Browse for .covdb File…", undefined],
        ],
    );
    vscodeStub.workspace.workspaceFolders = undefined;
});

test("without a workspace folder or an active database the switcher lists file names only", async () => {
    const offered = answer(undefined);

    await showDatabaseSwitcher(context({ activeCovdbPath: undefined }), recorder().actions);

    assert.deepEqual(
        offered[0].map((item) => item.label),
        [
            "$(database)  COVERAGE.covdb",
            "$(database)  other.covdb",
            "",
            "$(folder-opened)  Browse for .covdb File…",
        ],
    );
});

test("the switcher closes, switches or browses as chosen", async () => {
    const { calls, actions } = recorder();

    for (const choice of ["Close Current", "other.covdb", "Browse", "", undefined]) {
        answer(choice);
        await showDatabaseSwitcher(context(), actions);
    }

    assert.deepEqual(calls, ["closeDatabase", `switchDatabase ${OTHER}`, "configure"]);
});

test("the file browser says so when nothing is indexed", async () => {
    const quickPicks = window.quickPicks.length;

    await showFileBrowser(new Map());

    assert.equal(window.quickPicks.length, quickPicks);
    assert.equal(window.toasts[window.toasts.length - 1], "covdbg: No coverage files indexed.");
});

test("the file browser lists files by name with their coverage, and opens the one chosen", async () => {
    const root = tempFolder();
    const files = ["low.cpp", "good.cpp", "fair.cpp"].map((name) =>
        writeFile(path.join(root, "src", name)),
    );
    const [low, good, fair] = files;
    vscodeStub.workspace.workspaceFolders = [stubFolder(root)];
    const offered = answer("fair.cpp");

    await showFileBrowser(
        new Map([
            [low, summary(low, 1000, 499)],
            [good, summary(good, 10, 8)],
            [fair, summary(fair, 10, 5)],
        ]),
    );

    assert.deepEqual(
        offered[0].map((item) => [item.label, item.description]),
        [
            ["$(warning)  src/fair.cpp", "5/10 — 50.0%"],
            ["$(check)  src/good.cpp", "8/10 — 80.0%"],
            ["$(error)  src/low.cpp", "499/1000 — 49.9%"],
        ],
    );
    assert.equal(window.shown[window.shown.length - 1], fair);
    vscodeStub.workspace.workspaceFolders = undefined;
});

test("the file browser warns about a file that cannot be opened, and does nothing when dismissed", async () => {
    const gone = path.join(tempFolder(), "gone.cpp");
    const index = new Map([[gone, summary(gone, 1, 1)]]);
    const shown = window.shown.length;

    const offered = answer(undefined, "gone.cpp");
    await showFileBrowser(index);
    await showFileBrowser(index);

    assert.equal(offered[0][0].label, "$(check)  gone.cpp");
    assert.equal(window.shown.length, shown);
    assert.equal(window.toasts[window.toasts.length - 1], `Cannot open: ${gone}`);
});
