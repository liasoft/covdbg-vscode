import { vscodeStub, stubFolder } from "./vscodeStub";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
    CoverageTree,
    CoverageViewInput,
    CoverageRow,
    FolderCoverage,
    describeCoverageView,
    formatAge,
} from "../views/coverageTree";
import type { AuthService, AuthState } from "../auth/authService";
import type { RunNotice } from "../runner/runOutcome";
import type { RuntimeState } from "../runner/runnerTypes";

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const OK: RuntimeState = { kind: "ok", path: "C:/covdbg.exe", version: "1.4.0", source: "path" };

function input(overrides: Partial<CoverageViewInput> = {}): CoverageViewInput {
    return {
        auth: { kind: "signedIn", email: "dev@example.com" },
        runtime: OK,
        targets: ["build/Debug/test_app.exe"],
        coverage: [],
        multiRoot: false,
        now: NOW,
        ...overrides,
    };
}

const LOADED = {
    folderName: "app",
    covdbPath: "C:/app/.covdbg/coverage.covdb",
    mtime: NOW - 2 * 60_000,
    files: [
        {
            filePath: "C:/app/src/parser.cpp",
            totalLines: 100,
            coveredLines: 31,
            coveragePercent: 31,
        },
        { filePath: "C:/app/src/main.cpp", totalLines: 100, coveredLines: 90, coveragePercent: 90 },
        { filePath: "C:/app/src/empty.h", totalLines: 0, coveredLines: 0, coveragePercent: 0 },
    ],
};

const labels = (rows: CoverageRow[]) => rows.map((row) => row.label);

test("covdbg that cannot run here, or is missing or too old, is a welcome state", () => {
    const unavailable = (runtime: Exclude<RuntimeState, { kind: "ok" }>) =>
        describeCoverageView(input({ auth: { kind: "unavailable", runtime } }));

    assert.deepEqual(unavailable({ kind: "unsupported", reason: "untrusted" }), {
        welcome: "untrusted",
        rows: [],
    });
    assert.equal(unavailable({ kind: "unsupported", reason: "remote" }).welcome, "remote");
    assert.equal(unavailable({ kind: "unsupported", reason: "platform" }).welcome, "platform");
    assert.equal(unavailable({ kind: "missing" }).welcome, "runtime");
    assert.equal(
        unavailable({ kind: "tooOld", path: "C:/old.exe", version: "1.2.0", fromSetting: false })
            .welcome,
        "runtime",
    );
    assert.equal(
        unavailable({ kind: "tooOld", path: "C:/old.exe", version: "1.2.0", fromSetting: true })
            .welcome,
        "runtimeSetting",
    );
});

test("signed out comes before no target", () => {
    assert.deepEqual(describeCoverageView(input({ auth: { kind: "signedOut" }, targets: [] })), {
        welcome: "signedOut",
        rows: [],
    });
});

test("signed in, with a token, or unsure, and no target, asks for one", () => {
    for (const auth of [
        { kind: "signedIn" } as const,
        { kind: "token" } as const,
        { kind: "error", message: "whoami failed" } as const,
    ]) {
        assert.equal(describeCoverageView(input({ auth, targets: [] })).welcome, "noTarget");
    }
});

test("while discovery runs, no target is not claimed yet", () => {
    const view = describeCoverageView(input({ targets: undefined }));

    assert.equal(view.welcome, undefined);
    assert.deepEqual(labels(view.rows), ["Signed in as dev@example.com"]);
});

test("ready shows the target to run, and which account and covdbg run it", () => {
    const view = describeCoverageView(input());

    assert.equal(view.welcome, undefined);
    assert.deepEqual(labels(view.rows), [
        "Ready: build/Debug/test_app.exe",
        "Signed in as dev@example.com",
    ]);
    assert.equal(view.rows[0].contextValue, "ready");
    assert.equal(view.rows[1].description, "covdbg 1.4.0 (PATH)");
});

test("several targets are counted", () => {
    const view = describeCoverageView(input({ targets: ["a.exe", "b.exe"] }));
    assert.equal(view.rows[0].label, "Ready: 2 test executables");
});

test("ready says so when covdbg could not name the repository", () => {
    const view = describeCoverageView(input({ repositoryHint: true }));

    assert.deepEqual(labels(view.rows), [
        "Ready: build/Debug/test_app.exe",
        "Add a git remote or make a first commit",
        "Signed in as dev@example.com",
    ]);
});

test("the repository hint waits for something to run", () => {
    const signedOut = describeCoverageView(
        input({ auth: { kind: "signedOut" }, repositoryHint: true }),
    );
    const loaded = describeCoverageView(input({ coverage: [LOADED], repositoryHint: true }));

    assert.equal(signedOut.welcome, "signedOut");
    assert.ok(!labels(loaded.rows).includes("Add a git remote or make a first commit"));
});

test("a project token is named, with no sign-in offered", () => {
    const view = describeCoverageView(input({ auth: { kind: "token" } }));
    const account = view.rows.find((row) => row.id === "account");

    assert.equal(account?.label, "Using project token (COVDBG_PROJECT_TOKEN)");
    assert.equal(account?.command, undefined);
});

test("signing in shows the code with its actions, and nothing to run yet", () => {
    const view = describeCoverageView(
        input({
            auth: { kind: "signingIn", url: "https://app.covdbg.com/device?code=AB", code: "AB" },
        }),
    );

    assert.deepEqual(labels(view.rows), ["Confirm code AB in your browser."]);
    assert.equal(view.rows[0].contextValue, "signingIn");
});

test("still checking shows that, not a welcome", () => {
    const view = describeCoverageView(input({ auth: { kind: "unknown" }, targets: [] }));

    assert.equal(view.welcome, undefined);
    assert.deepEqual(labels(view.rows), ["Checking covdbg…"]);
});

test("results show the summary, the lowest files and the account", () => {
    const view = describeCoverageView(input({ coverage: [LOADED] }));

    assert.deepEqual(labels(view.rows), [
        "60.5% lines · 3 files · 2 min ago",
        "Lowest coverage",
        "Signed in as dev@example.com",
    ]);
    assert.equal(view.rows[0].command, "covdbg.showReport");
    const lowest = view.rows[1].children ?? [];
    assert.deepEqual(labels(lowest), ["parser.cpp", "main.cpp", "Show all"]);
    assert.equal(lowest[0].filePath, "C:/app/src/parser.cpp");
    assert.equal(lowest[2].command, "covdbg.browseFiles");
});

test("results stay on screen when signed out or covdbg is gone", () => {
    const signedOut = describeCoverageView(
        input({ auth: { kind: "signedOut" }, coverage: [LOADED] }),
    );
    const account = signedOut.rows[signedOut.rows.length - 1];
    assert.equal(signedOut.welcome, undefined);
    assert.equal(account.label, "Not signed in");
    assert.equal(account.command, "covdbg.signIn");

    const untrusted = describeCoverageView(
        input({
            auth: { kind: "unavailable", runtime: { kind: "unsupported", reason: "untrusted" } },
            coverage: [LOADED],
        }),
    );
    assert.equal(untrusted.welcome, undefined);
    assert.equal(untrusted.rows[0].label, "60.5% lines · 3 files · 2 min ago");
});

test("folders with the same name, or sharing a header, give each row its own id", () => {
    const header = {
        filePath: "C:/shared/util.h",
        totalLines: 10,
        coveredLines: 1,
        coveragePercent: 10,
    };
    const view = describeCoverageView(
        input({
            multiRoot: true,
            coverage: [
                { ...LOADED, folderName: "src", files: [...LOADED.files, header] },
                { ...LOADED, folderName: "src", files: [header] },
                { folderName: "src", mtime: 0, files: [], problem: "empty" },
                { folderName: "src", mtime: 0, files: [], problem: "empty" },
            ],
        }),
    );
    const ids = view.rows.flatMap((row) => [
        row.id,
        ...(row.children ?? []).map((child) => child.id),
    ]);

    assert.equal(new Set(ids).size, ids.length);
});

test("a multi-root summary names its folder", () => {
    const view = describeCoverageView(
        input({
            multiRoot: true,
            coverage: [LOADED, { ...LOADED, folderName: "lib", mtime: NOW - 3 * 3_600_000 }],
        }),
    );

    assert.deepEqual(labels(view.rows).slice(0, 2), [
        "app: 60.5% lines · 3 files · 2 min ago",
        "lib: 60.5% lines · 3 files · 3 h ago",
    ]);
});

test("a .covdb that showed nothing is a problem row, not a welcome", () => {
    const view = describeCoverageView(
        input({
            auth: { kind: "signedOut" },
            coverage: [
                { folderName: "app", mtime: 0, files: [], problem: "coverage.covdb is empty" },
            ],
        }),
    );

    assert.equal(view.welcome, undefined);
    assert.equal(view.rows[0].label, "coverage.covdb is empty");
    assert.equal(view.rows[0].icon, "warning");
});

test("the last run's notice is a row with its action", () => {
    const withNotice = (notice: CoverageViewInput["notice"]) =>
        describeCoverageView(input({ coverage: [LOADED], notice })).rows.find(
            (row) => row.id === "notice",
        );

    assert.equal(withNotice({ kind: "gated", message: "gated" })?.command, undefined);
    assert.equal(
        withNotice({ kind: "lockSet", message: "now locked to x", action: "openProfile" })?.url,
        "https://app.covdbg.com/profile",
    );
    assert.equal(
        withNotice({ kind: "sessionInvalid", message: "ended", action: "signIn" })?.command,
        "covdbg.signIn",
    );
});

test("row ids stay the same from one refresh to the next, so expanded rows stay expanded", () => {
    const ids = (view: ReturnType<typeof describeCoverageView>) =>
        view.rows.flatMap((row) => [row.id, ...(row.children ?? []).map((child) => child.id)]);

    const before = describeCoverageView(input({ coverage: [LOADED] }));
    const after = describeCoverageView(input({ coverage: [LOADED], now: NOW + 3_600_000 }));

    assert.deepEqual(ids(after), ids(before));
});

test("ages read naturally", () => {
    assert.equal(formatAge(10_000), "just now");
    assert.equal(formatAge(5 * 60_000), "5 min ago");
    assert.equal(formatAge(2 * 3_600_000), "2 h ago");
    assert.equal(formatAge(24 * 3_600_000), "1 day ago");
    assert.equal(formatAge(3 * 24 * 3_600_000), "3 days ago");
});

test("the account row names the team the sign-in is for", () => {
    const view = describeCoverageView(
        input({ auth: { kind: "signedIn", email: "a@acme.com", teamName: "Acme" } }),
    );
    assert.equal(view.rows[view.rows.length - 1].label, "Signed in as a@acme.com for Acme");
});

test("a sign-in that could not be checked says why, and still lets runs start", () => {
    const view = describeCoverageView(input({ auth: { kind: "error", message: "whoami failed" } }));

    assert.deepEqual(labels(view.rows), [
        "Ready: build/Debug/test_app.exe",
        "Could not check the sign-in: whoami failed",
    ]);
    assert.equal(view.rows[1].icon, "warning");
});

test("a .covdb whose files have no executable lines reads 0%, with nothing listed as lowest", () => {
    const headersOnly = { ...LOADED, files: [LOADED.files[2]] };

    const view = describeCoverageView(input({ coverage: [headersOnly] }));

    assert.equal(view.rows[0].label, "0.0% lines · 1 file · 2 min ago");
    assert.deepEqual(labels(view.rows[1].children ?? []), ["Show all"]);
});

test("a notice that leads to the app links to it", () => {
    const view = describeCoverageView(
        input({
            coverage: [LOADED],
            notice: { kind: "refused", message: "Not licensed.", action: "openApp" },
        }),
    );

    assert.equal(view.rows.find((row) => row.id === "notice")?.url, "https://app.covdbg.com");
});

/** The parts of the sign-in the view reads, with a way to change them as covdbg would. */
class FakeAuth {
    runtime: RuntimeState | undefined = OK;
    lastRunNotice: RunNotice | undefined;
    refreshes = 0;
    readonly changed = new vscodeStub.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    constructor(public state: AuthState) {}
    async refresh(): Promise<void> {
        this.refreshes++;
    }
}

/** A Coverage view over `coverage`; `redraws` counts how often it worked the view out. */
function coverageTree(auth: FakeAuth, coverage: FolderCoverage[] = [LOADED]) {
    const counter = { redraws: 0 };
    const tree = new CoverageTree(auth as unknown as AuthService, {
        getCoverage: () => {
            counter.redraws++;
            return coverage;
        },
        getTargets: () => ["build/Debug/test_app.exe"],
        needsRepositoryHint: () => false,
    });
    const view = vscodeStub.window.treeViews.get("covdbg.homeView")!;
    return { tree, view, counter };
}

const context = (key: string) => vscodeStub.commands.context.get(key);
const lastLabel = (rows: CoverageRow[]) => rows[rows.length - 1].label;

test("the view shows the rows for its state and sets the context keys the menus use", () => {
    const auth = new FakeAuth({ kind: "signedIn", email: "dev@example.com" });
    auth.lastRunNotice = { kind: "gated", message: "Reporting is gated." };
    const { tree, view } = coverageTree(auth);

    const rows = tree.getChildren();
    assert.match(rows[0].label, /^60\.5% lines · 3 files · /);
    assert.deepEqual(labels(rows).slice(1), [
        "Reporting is gated.",
        "Lowest coverage",
        "Signed in as dev@example.com",
    ]);
    assert.deepEqual(labels(tree.getChildren(rows[2])), ["parser.cpp", "main.cpp", "Show all"]);
    assert.deepEqual(tree.getChildren(rows[0]), []);
    assert.equal(context("covdbg.welcome"), "");
    assert.equal(context("covdbg.hasCoverage"), true);
    assert.equal(context("covdbg.hasNotice"), true);
    assert.equal(view.badge, undefined);
    tree.dispose();
});

test("signed out with nothing loaded is a welcome, with a badge asking for the sign-in", () => {
    const { tree, view } = coverageTree(new FakeAuth({ kind: "signedOut" }), []);

    assert.deepEqual(tree.getChildren(), []);
    assert.equal(context("covdbg.welcome"), "signedOut");
    assert.equal(context("covdbg.hasCoverage"), false);
    assert.equal(context("covdbg.hasNotice"), false);
    assert.deepEqual(view.badge, { value: 1, tooltip: "Sign in to covdbg" });
    tree.dispose();
});

test("covdbg missing gets a badge; covdbg that cannot run here at all does not", () => {
    const auth = new FakeAuth({ kind: "unavailable", runtime: { kind: "missing" } });
    const { tree, view } = coverageTree(auth, []);

    assert.equal((view.badge as { value: number }).value, 1);
    assert.equal(context("covdbg.welcome"), "runtime");

    auth.state = { kind: "unavailable", runtime: { kind: "unsupported", reason: "remote" } };
    auth.changed.fire();
    assert.equal(view.badge, undefined);
    assert.equal(context("covdbg.welcome"), "remote");
    tree.dispose();
});

test("with several workspace folders each summary names its folder", () => {
    vscodeStub.workspace.workspaceFolders = [stubFolder("C:/app"), stubFolder("C:/lib", 1)];
    const { tree } = coverageTree(new FakeAuth({ kind: "token" }));

    assert.match(tree.getChildren()[0].label, /^app: 60\.5% lines/);
    tree.dispose();
    vscodeStub.workspace.workspaceFolders = undefined;
});

test("a sign-in change redraws the view and tells the tree", () => {
    const auth = new FakeAuth({ kind: "signedIn", email: "dev@example.com" });
    const { tree } = coverageTree(auth);
    let fired = 0;
    tree.onDidChangeTreeData(() => fired++);

    auth.state = { kind: "signedOut" };
    auth.changed.fire();

    assert.equal(fired, 1);
    assert.equal(lastLabel(tree.getChildren()), "Not signed in");
    tree.dispose();
});

test("opening the view redraws it and asks covdbg about the sign-in again", () => {
    const auth = new FakeAuth({ kind: "signedOut" });
    const { tree, view, counter } = coverageTree(auth);
    const redraws = counter.redraws;

    view.setVisible(true);
    assert.equal(counter.redraws, redraws + 1);
    assert.equal(auth.refreshes, 1);

    view.setVisible(false);
    assert.equal(counter.redraws, redraws + 1);
    assert.equal(auth.refreshes, 1);
    tree.dispose();
});

test("each minute the view redraws while it is visible, so the age stays true", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
        const { tree, view, counter } = coverageTree(new FakeAuth({ kind: "token" }));
        const redraws = counter.redraws;

        mock.timers.tick(60_000);
        assert.equal(counter.redraws, redraws, "a hidden view waits");

        view.visible = true;
        mock.timers.tick(60_000);
        assert.equal(counter.redraws, redraws + 1);

        tree.dispose();
        mock.timers.tick(60_000);
        assert.equal(counter.redraws, redraws + 1, "a disposed view stops");
    } finally {
        mock.timers.reset();
    }
});

test("a disposed view no longer follows the sign-in", () => {
    const auth = new FakeAuth({ kind: "token" });
    const { tree, counter } = coverageTree(auth);
    const redraws = counter.redraws;

    tree.dispose();
    auth.changed.fire();

    assert.equal(counter.redraws, redraws);
});

test("rows become tree items that open their file, page or command", () => {
    const { tree } = coverageTree(new FakeAuth({ kind: "token" }));
    const item = (row: CoverageRow) =>
        tree.getTreeItem(row) as unknown as {
            id: string;
            collapsibleState: number;
            description?: string;
            tooltip?: string;
            contextValue?: string;
            iconPath?: { id: string };
            resourceUri?: { fsPath: string };
            command?: { command: string; title: string; arguments?: unknown[] };
        };

    const file = item({
        id: "f",
        label: "main.cpp",
        description: "90.0%",
        filePath: "C:/app/main.cpp",
    });
    assert.equal(file.resourceUri?.fsPath, "C:/app/main.cpp");
    assert.equal(file.command?.command, "vscode.open");
    assert.equal(String(file.command?.arguments?.[0]), "C:/app/main.cpp");
    assert.equal(file.description, "90.0%");
    assert.equal(file.iconPath, undefined);

    const page = item({ id: "n", label: "Locked", icon: "warning", url: "https://app.covdbg.com" });
    assert.equal(page.command?.command, "vscode.open");
    assert.equal(String(page.command?.arguments?.[0]), "https://app.covdbg.com");
    assert.equal(page.iconPath?.id, "warning");

    const command = item({
        id: "ready",
        label: "Ready",
        tooltip: "app.exe",
        contextValue: "ready",
        command: "covdbg.run",
    });
    assert.deepEqual(command.command, { command: "covdbg.run", title: "Ready" });
    assert.equal(command.contextValue, "ready");
    assert.equal(command.tooltip, "app.exe");
    assert.equal(command.id, "ready");
    assert.equal(command.collapsibleState, vscodeStub.TreeItemCollapsibleState.None);

    const parent = item({ id: "lowest", label: "Lowest coverage", children: [] });
    assert.equal(parent.collapsibleState, vscodeStub.TreeItemCollapsibleState.Expanded);
    assert.equal(parent.command, undefined);
    tree.dispose();
});
