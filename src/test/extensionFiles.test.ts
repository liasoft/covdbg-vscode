import { vscodeStub, stubEditor, type StubWatcher } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { ExtensionUnderTest, startExtension, statusBarText, waitFor } from "./extensionHarness";
import { tempFolder, writeCovdb, writeFile } from "./fixtures";

let ext: ExtensionUnderTest;
let source: string;
let external: string;

/** Long enough for the extension's 750 ms wait for a .covdb's writes to stop. */
const DEBOUNCE = () => new Promise((resolve) => setTimeout(resolve, 900));

const covdbAt = (name: string, lines: Record<number, number>) =>
    writeCovdb(path.join(ext.root, name), { lines: { [source]: lines, [external]: { 1: 1 } } });

function pickLabel(label: string) {
    vscodeStub.window.pick = (items) => items.find((item) => item.label.includes(label));
}

function viewText(): string {
    const view = vscodeStub.window.treeViews.get("covdbg.homeView")!;
    return JSON.stringify((view.treeDataProvider as { getChildren(): unknown[] }).getChildren());
}

/** The watcher the extension keeps over a glob or a file name. */
function watcher(pattern: string): StubWatcher {
    const found = vscodeStub.workspace.watchers.filter(
        (watcher) =>
            !watcher.disposed &&
            (typeof watcher.pattern === "string" ? watcher.pattern : watcher.pattern.pattern) ===
                pattern,
    );
    return found[found.length - 1];
}

function changeSettings(...keys: string[]) {
    vscodeStub.workspace.configurationChanged.fire({
        affectsConfiguration: (key) => keys.includes(key),
    });
}

test.before(async () => {
    ext = await startExtension({
        account: { email: "dev@example.com" },
        files: (root) => {
            source = writeFile(path.join(root, "src", "a.cpp"), "int a;\nint b;\nint c;\n");
            writeFile(path.join(root, "build", "Debug", "app_test.exe"));
        },
    });
    external = path.join(tempFolder(), "sdk.h");
    await waitFor(() => vscodeStub.commands.context.get("covdbg.auth") === "signedIn", "whoami");
});

test.after(() => ext.dispose());

test("with nothing loaded the report has nothing to show", async () => {
    assert.equal(statusBarText(), "");
    vscodeStub.window.toasts = [];
    await ext.command("covdbg.showReport");
    assert.deepEqual(vscodeStub.window.toasts, ["covdbg: No coverage data loaded."]);
    await ext.command("covdbg.browseFiles");
    assert.deepEqual(vscodeStub.window.toasts.slice(1), ["covdbg: No coverage files indexed."]);
});

test("a .covdb that appears in the folder is loaded once its writes stop", async () => {
    const first = await covdbAt("out/first.covdb", { 1: 1, 2: 0 });
    watcher("**/*.covdb").created.fire(vscodeStub.Uri.file(first));
    watcher("**/*.covdb").changed.fire(vscodeStub.Uri.file(first));
    assert.equal(statusBarText(), "");
    await DEBOUNCE();
    await waitFor(() => statusBarText() === "$(beaker) 50.0%", "the new .covdb");

    // Once a .covdb is loaded, its own watcher takes over.
    watcher("**/*.covdb").created.fire(vscodeStub.Uri.file(first));
    assert.ok(watcher("first.covdb"));
});

test("a loaded .covdb that is written again is read again", async () => {
    const first = path.join(ext.root, "out", "first.covdb");
    await covdbAt("out/first.covdb", { 1: 1, 2: 1 });
    fs.utimesSync(first, new Date(), new Date(Date.now() + 5000));
    watcher("first.covdb").changed.fire(vscodeStub.Uri.file(first));
    await DEBOUNCE();
    await waitFor(() => statusBarText() === "$(beaker) 100.0%", "the reload");

    watcher("first.covdb").deleted.fire(vscodeStub.Uri.file(first));
    assert.ok(vscodeStub.window.log.some((line) => line.includes("noticed deletion")));
});

test("a .covdb written during a run is read once the run ends", async () => {
    const first = path.join(ext.root, "out", "first.covdb");
    writeFile(path.join(ext.root, ".covdbg.yaml"), "version: 1\n");
    ext.onRun = (process) => {
        void covdbAt("out/first.covdb", { 1: 0, 2: 1 }).then(() => {
            fs.utimesSync(first, new Date(), new Date(Date.now() + 10_000));
            watcher("first.covdb").changed.fire(vscodeStub.Uri.file(first));
            process.exit(1);
        });
    };
    await ext.command("covdbg.runCoverage");
    assert.ok(vscodeStub.window.log.some((line) => line.includes("Queued .covdb reload")));
    await waitFor(() => statusBarText() === "$(beaker) 50.0%", "the deferred reload");
});

test("an editor shows no coverage for a source changed since the .covdb was written", async () => {
    const editor = stubEditor(source, "int a;\nint b;\nint c;\n");
    vscodeStub.window.visibleTextEditors = [editor];
    vscodeStub.window.activeEditorChanged.fire(editor);
    await waitFor(() => editor.decorations.size > 0, "the decorations");
    assert.ok([...editor.decorations.values()].some((ranges) => ranges.length > 0));

    fs.utimesSync(source, new Date(), new Date(Date.now() + 60_000));
    vscodeStub.window.activeEditorChanged.fire(editor);
    await waitFor(
        () => [...editor.decorations.values()].every((ranges) => ranges.length === 0),
        "the stale coverage to go",
    );
    fs.utimesSync(source, new Date(), new Date(0));

    vscodeStub.workspace.textDocuments = [editor.document];
    editor.document.isDirty = true;
    vscodeStub.window.activeEditorChanged.fire(editor);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok([...editor.decorations.values()].every((ranges) => ranges.length === 0));
    vscodeStub.workspace.textDocuments = [];
    vscodeStub.window.visibleTextEditors = [];
    vscodeStub.window.activeEditorChanged.fire(undefined);
});

test("files outside the folder show once the setting asks for them", async () => {
    vscodeStub.workspace.settings.showExternalFiles = true;
    changeSettings("covdbg.showExternalFiles");
    await waitFor(() => statusBarText() === "$(beaker) 66.7%", "the external file");
    vscodeStub.workspace.settings.showExternalFiles = false;
    changeSettings("covdbg.showExternalFiles");
    await waitFor(() => statusBarText() === "$(beaker) 50.0%", "the external file to go");
});

test("Load .covdb… switches between the discovered databases and closes them", async () => {
    await covdbAt("other.covdb", { 1: 0, 2: 0, 3: 1 });
    pickLabel("other.covdb");
    await ext.command("covdbg.configurePath");
    await waitFor(() => statusBarText() === "$(beaker) 33.3%", "the switch");

    pickLabel("Close Current Database");
    await ext.command("covdbg.configurePath");
    assert.equal(statusBarText(), "");
    assert.equal(vscodeStub.commands.context.get("covdbg.hasCoverage"), false);
});

test("the menu offers the databases when nothing is loaded, and Browse… loads any file", async () => {
    const picked = await writeCovdb(path.join(tempFolder(), "picked.covdb"), {
        lines: { [source]: { 1: 1, 2: 1, 3: 1, 4: 0 } },
    });
    pickLabel("Browse");
    vscodeStub.window.openDialogAnswer = [picked];
    await ext.command("covdbg.showMenu");
    await waitFor(() => statusBarText() === "$(beaker) 75.0%", "the picked file");
    assert.ok(vscodeStub.workspace.updates.includes(`covdbPath=${picked}@2`));
    vscodeStub.window.openDialogAnswer = undefined;
});

test("a file that is no .covdb says so when it was picked, and keeps the last good one", async () => {
    vscodeStub.window.toasts = [];
    const bad = writeFile(path.join(ext.root, "bad.covdb"), "not sqlite");
    pickLabel("bad.covdb");
    await ext.command("covdbg.configurePath");
    await waitFor(() => vscodeStub.window.toasts.length === 1, "the toast");
    assert.match(viewText(), /still showing the last good load of picked\.covdb/);
    assert.equal(statusBarText(), "$(beaker) 75.0%");
    fs.unlinkSync(bad);

    const empty = await writeCovdb(path.join(ext.root, "empty.covdb"), {});
    pickLabel("empty.covdb");
    await ext.command("covdbg.configurePath");
    await waitFor(() => viewText().includes("No coverage data in .covdb"), "the empty .covdb");
    fs.unlinkSync(empty);
});

test("covdbg.covdbPath names the .covdb to load, relative to the folder", async () => {
    vscodeStub.workspace.settings.covdbPath = "other.covdb";
    changeSettings("covdbg.covdbPath");
    await waitFor(() => statusBarText() === "$(beaker) 33.3%", "the configured .covdb");

    vscodeStub.workspace.settings.covdbPath = "missing.covdb";
    changeSettings("covdbg.covdbPath");
    await waitFor(
        () => vscodeStub.window.log.some((line) => line.includes("covdbg.covdbPath not found")),
        "the missing file to be logged",
    );
    vscodeStub.workspace.settings.covdbPath = "";
});

test("Open .covdbg.yaml opens the folder's config, and asks which when there are several", async () => {
    const rootConfig = path.join(ext.root, ".covdbg.yaml");
    vscodeStub.window.shown = [];
    await ext.command("covdbg.openConfig");
    assert.deepEqual(vscodeStub.window.shown, [rootConfig]);

    const nested = writeFile(path.join(ext.root, "sub", ".covdbg.yaml"), "version: 1\n");
    vscodeStub.window.pick = (items) => items[1];
    await ext.command("covdbg.openConfig");
    assert.deepEqual(vscodeStub.window.shown, [rootConfig, nested]);
    fs.unlinkSync(nested);

    fs.unlinkSync(rootConfig);
    await ext.command("covdbg.openConfig");
    assert.match(fs.readFileSync(rootConfig, "utf8"), /^version: 1/m);
    await ext.command("covdbg.createConfig");
    assert.deepEqual(vscodeStub.window.shown.slice(2), [rootConfig, rootConfig]);
});

test("a deleted .covdbg.yaml is taken out of covdbg.runner.configPath where it was set", async () => {
    const config = path.join(ext.root, ".covdbg.yaml");
    vscodeStub.workspace.updates = [];
    vscodeStub.workspace.inspected["runner.configPath"] = {
        workspaceFolderValue: ".covdbg.yaml",
        workspaceValue: config,
        globalValue: "  ",
    };
    watcher("**/.covdbg.yaml").deleted.fire(vscodeStub.Uri.file(config));
    await waitFor(() => vscodeStub.workspace.updates.length === 2, "the settings to clear");
    assert.deepEqual(vscodeStub.workspace.updates, [
        "runner.configPath=undefined@3",
        "runner.configPath=undefined@2",
    ]);

    vscodeStub.workspace.inspected["runner.configPath"] = { globalValue: config };
    watcher("**/.covdbg.yaml").deleted.fire(vscodeStub.Uri.file(config));
    await waitFor(() => vscodeStub.workspace.updates.length === 3, "the global setting");
    delete vscodeStub.workspace.inspected["runner.configPath"];
    watcher("**/.covdbg.yaml").deleted.fire(vscodeStub.Uri.file(config));
    watcher("**/.covdbg.yaml").deleted.fire(vscodeStub.Uri.file(path.join(tempFolder(), "x")));
});

test("Open covdbg.log opens covdbg's log from the folder's last run", async () => {
    vscodeStub.window.toasts = [];
    await ext.command("covdbg.openLog");
    assert.deepEqual(vscodeStub.window.toasts, [
        "covdbg: No covdbg.log found for this workspace yet.",
    ]);
    const log = writeFile(path.join(ext.root, ".covdbg", "Logs", "covdbg.log"), "log\n");
    await ext.command("covdbg.openLog");
    assert.equal(vscodeStub.window.shown[vscodeStub.window.shown.length - 1], log);
});

test("the remaining commands reach the settings, the log and the sign-in", async () => {
    await ext.command("covdbg.openSettings");
    assert.deepEqual(vscodeStub.commands.executed, ["workbench.action.openSettings covdbg"]);
    await ext.command("covdbg.showOutput");
    assert.equal(vscodeStub.window.log[vscodeStub.window.log.length - 1], "<shown>");
    await ext.command("covdbg.setRenderMode", "line");
    assert.equal(ext.workspaceState.get("covdbg.renderMode"), "line");

    await ext.command("covdbg.copySignInCode");
    await ext.command("covdbg.openSignInPage");
    await ext.command("covdbg.cancelSignIn");
    vscodeStub.window.warningAnswer = undefined;
    await ext.command("covdbg.signOut");

    ext.onLogin = (process) => {
        process.print("Signed in as dev@example.com for Acme.\n");
        process.exit(0);
    };
    assert.equal(await ext.command("covdbg.signIn"), true);
});

test("covdbg, discovery and folder changes are picked up", async () => {
    const before = ext.started.length;
    changeSettings("covdbg.executablePath");
    await waitFor(() => ext.started.length > before, "whoami");

    writeFile(path.join(ext.root, "tests", "unit_test.exe"));
    vscodeStub.workspace.settings["runner.binaryDiscoveryPattern"] = "tests/*.exe";
    changeSettings("covdbg.runner.binaryDiscoveryPattern");
    await waitFor(
        () => vscodeStub.window.log.some((line) => line.includes("discovered 1 binaries")),
        "discovery",
    );

    const second = path.join(tempFolder(), "second");
    fs.mkdirSync(second);
    vscodeStub.workspace.workspaceFolders = [
        ...vscodeStub.workspace.workspaceFolders!,
        { uri: vscodeStub.Uri.file(second), name: "second", index: 1 },
    ];
    vscodeStub.workspace.foldersChanged.fire();
    await waitFor(() => watcher("**/*.covdb") !== undefined, "the new folder's watcher");
    vscodeStub.workspace.workspaceFolders = vscodeStub.workspace.workspaceFolders.slice(1);
    vscodeStub.workspace.foldersChanged.fire();
    await waitFor(
        () => vscodeStub.workspace.watchers.filter((w) => w.disposed).length > 0,
        "the old folder's watcher to go",
    );
});
