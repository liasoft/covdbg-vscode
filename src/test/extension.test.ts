import { vscodeStub, stubEditor, type StubEditor } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
    ExtensionUnderTest,
    startExtension,
    statusBarText,
    testItems,
    waitFor,
} from "./extensionHarness";
import { tempFolder, writeCovdb, writeFile } from "./fixtures";
import manifest from "../../package.json";

const SOURCE = "int main() {\n    int x = 0;\n    return x;\n}\n";

let ext: ExtensionUnderTest;
let mainCpp: string;
let covdb: string;
let editor: StubEditor;

/** The ranges each decoration shows on the editor, as `line numbers` per non-empty type. */
function decorated(on: StubEditor = editor): number[][] {
    return [...on.decorations.values()]
        .filter((ranges) => ranges.length > 0)
        .map((ranges) => ranges.map((range) => range.range.start.line + 1));
}

function lastRun() {
    const { runs } = vscodeStub.tests.controllers[0];
    return runs[runs.length - 1];
}

function pickLabel(label: string) {
    vscodeStub.window.pick = (items) => items.find((item) => item.label.includes(label));
}

test.before(async () => {
    ext = await startExtension({
        account: { email: "dev@example.com" },
        files: async (root) => {
            mainCpp = writeFile(path.join(root, "src", "main.cpp"), SOURCE);
            writeFile(path.join(root, "build", "Debug", "app_test.exe"));
            writeFile(path.join(root, ".covdbg.yaml"), "version: 1\n");
            covdb = await writeCovdb(path.join(root, ".covdbg", "coverage.covdb"), {
                lines: {
                    [path.join(root, "src", "main.cpp")]: { 1: 3, 2: 1, 3: 0 },
                    [path.join(tempFolder(), "sdk.h")]: { 1: 1 },
                },
            });
        },
    });
    ext.coverage = { lines: { [mainCpp]: { 1: 1, 2: 1, 3: 1 } } };
});

test.after(() => ext.dispose());

test("every command the manifest contributes is registered", () => {
    for (const { command } of manifest.contributes.commands) {
        assert.ok(vscodeStub.commands.registered.has(command), command);
    }
});

test("activation loads the folder's .covdb without the files outside it", async () => {
    await waitFor(() => statusBarText() === "$(beaker) 66.7%", "the coverage to load");
    await waitFor(() => vscodeStub.commands.context.get("covdbg.auth") === "signedIn", "whoami");
    await waitFor(() => testItems().length === 1, "discovery");
    assert.deepEqual(testItems(), ["app_test.exe"]);
    assert.equal(vscodeStub.commands.context.get("covdbg.hasCoverage"), true);
    assert.ok(vscodeStub.window.log.some((line) => line.includes("(1 external files hidden)")));
});

test("an editor on a covered file shows its lines in the gutter", async () => {
    editor = stubEditor(mainCpp, SOURCE);
    vscodeStub.window.visibleTextEditors = [editor];
    vscodeStub.window.activeTextEditor = editor;
    vscodeStub.window.activeEditorChanged.fire(editor);
    await waitFor(() => decorated().length === 2, "the decorations");
    assert.deepEqual(decorated(), [[1, 2], [3]]);
});

test("a render mode chosen in the menu applies to the open editors and is kept", async () => {
    pickLabel("Both");
    await ext.command("covdbg.showMenu");
    await waitFor(() => decorated().length === 4, "line and gutter decorations");
    assert.equal(ext.workspaceState.get("covdbg.renderMode"), "both");

    vscodeStub.workspace.settings.renderMode = "gutter";
    vscodeStub.workspace.configurationChanged.fire({
        affectsConfiguration: (key) => key === "covdbg.renderMode",
    });
    await waitFor(() => decorated().length === 2, "gutter decorations only");
    assert.equal(ext.workspaceState.get("covdbg.renderMode"), "gutter");
});

test("hiding coverage clears the editors, and showing it again decorates them", async () => {
    pickLabel("Hide Coverage");
    await ext.command("covdbg.showMenu");
    assert.deepEqual(decorated(), []);
    assert.match(vscodeStub.window.statusBarItems[0].tooltip, /Coverage OFF/);

    await ext.command("covdbg.toggleCoverage");
    await waitFor(() => decorated().length === 2, "the decorations again");
});

test("an edited file loses its coverage until the .covdb is newer than it", async () => {
    vscodeStub.workspace.documentChanged.fire({ document: editor.document, contentChanges: [] });
    assert.equal(decorated().length, 2);

    vscodeStub.workspace.documentChanged.fire({ document: editor.document, contentChanges: [{}] });
    assert.deepEqual(decorated(), []);
    vscodeStub.window.activeEditorChanged.fire(editor);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(decorated(), []);
});

test("the report opens beside the editor and opens the file a row names", async () => {
    await ext.command("covdbg.showReport");
    const [panel] = vscodeStub.window.panels;
    assert.match(panel.webview.html, /main\.cpp/);
    assert.doesNotMatch(panel.webview.html, /sdk\.h/);

    panel.received.fire({ command: "openFile", filePath: mainCpp, line: 2 });
    await waitFor(() => vscodeStub.window.shown.includes(mainCpp), "the file to open");
});

test("Browse Covered Files opens the file chosen", async () => {
    vscodeStub.window.shown = [];
    pickLabel("main.cpp");
    await ext.command("covdbg.browseFiles");
    assert.deepEqual(vscodeStub.window.shown, [mainCpp]);
});

test("▶ runs the only test executable with the folder's config and loads what it wrote", async () => {
    await ext.command("covdbg.runCoverage");
    const run = lastRun();
    assert.deepEqual(run.events, ["started app_test.exe", "passed app_test.exe"]);
    assert.ok(run.ended);

    const covdbgRun = ext.started[ext.started.length - 1];
    assert.deepEqual(covdbgRun.args, [
        "--config",
        path.join(ext.root, ".covdbg.yaml"),
        "--output",
        covdb,
        path.join(ext.root, "build", "Debug", "app_test.exe"),
    ]);
    await waitFor(() => statusBarText() === "$(beaker) 100.0%", "the new coverage");
});

test("a refused run says why in Test Results and offers the fix", async () => {
    vscodeStub.window.toasts = [];
    ext.onRun = (process) => {
        process.stderr.emit(
            "data",
            Buffer.from("covdbg: This run is not licensed: Your personal use is locked to x.\n"),
        );
        process.exit(3);
    };
    let answered = false;
    vscodeStub.window.answer = (message, items) => {
        answered = true;
        return items[0];
    };
    await ext.command("covdbg.runCoverage");
    const run = lastRun();
    assert.deepEqual(run.events, ["started app_test.exe", "errored app_test.exe"]);
    assert.deepEqual(run.messages, ["This run is not licensed: Your personal use is locked to x."]);
    await waitFor(() => answered, "the refusal toast");
    assert.deepEqual(vscodeStub.window.toasts, [
        "covdbg: This run is not licensed: Your personal use is locked to x.",
    ]);
    await waitFor(() => vscodeStub.env.opened.length === 1, "the profile page");
    assert.equal(vscodeStub.commands.context.get("covdbg.hasNotice"), true);
    vscodeStub.window.answer = undefined;
});

test("a run that finds nothing to measure says so from the palette", async () => {
    vscodeStub.window.toasts = [];
    ext.onRun = (process) => process.exit(2);
    await ext.command("covdbg.runCoverage");
    const run = lastRun();
    assert.deepEqual(run.events, ["started app_test.exe", "errored app_test.exe"]);
    await waitFor(() => vscodeStub.window.toasts.length === 1, "the error toast");

    ext.onRun = (process) => process.exit(1);
    await ext.command("covdbg.runCoverage");
    assert.deepEqual(lastRun().events, ["started app_test.exe", "failed app_test.exe"]);
});

test("Clear Last Run deletes what the last run wrote and unloads it", async () => {
    ext.onRun = (process, outputPath) => {
        void writeCovdb(outputPath, ext.coverage).then(() => process.exit(0));
    };
    await ext.command("covdbg.runCoverage");
    await waitFor(() => statusBarText() !== "", "the coverage");
    await ext.command("covdbg.clearLastRunResult");
    assert.equal(fs.existsSync(covdb), false);
    assert.equal(statusBarText(), "");
    assert.deepEqual(decorated(), []);
    assert.equal(vscodeStub.commands.context.get("covdbg.hasNotice"), false);
});

test("Clear Last Run says when it cannot delete what the last run wrote", async () => {
    ext.onRun = (process, outputPath) => {
        fs.mkdirSync(path.join(outputPath, "in-the-way"), { recursive: true });
        process.exit(1);
    };
    await ext.command("covdbg.runCoverage");
    vscodeStub.window.toasts = [];
    await ext.command("covdbg.clearLastRunResult");
    assert.equal(vscodeStub.window.toasts.length, 1);
    assert.match(vscodeStub.window.toasts[0], /^covdbg: Failed to delete last \.covdb: /);
    fs.rmSync(covdb, { recursive: true });

    await ext.command("covdbg.clearLastRunResult");
    assert.ok(vscodeStub.window.log[vscodeStub.window.log.length - 1].includes("Cleared UI state"));
});

test("the menu's Coverage Report shows the report again", async () => {
    ext.onRun = (process, outputPath) => {
        void writeCovdb(outputPath, ext.coverage).then(() => process.exit(0));
    };
    await ext.command("covdbg.runCoverage");
    await waitFor(() => statusBarText() === "$(beaker) 100.0%", "the coverage");
    const [panel] = vscodeStub.window.panels;
    const revealed = panel.revealed;
    pickLabel("Coverage Report");
    await ext.command("covdbg.showMenu");
    await waitFor(() => panel.revealed === revealed + 1, "the report");
});

test("the MCP server runs the covdbg the extension found, in the folder", async () => {
    const provider = vscodeStub.lm.mcpProviders.get("covdbg.mcp") as {
        provideMcpServerDefinitions(): { command: string; args: string[] }[];
        resolveMcpServerDefinition(server: unknown): Promise<{ command: string } | undefined>;
    };
    const [server] = provider.provideMcpServerDefinitions();
    assert.deepEqual(server.args, ["mcp", "--workspace", ext.root]);
    const resolved = await provider.resolveMcpServerDefinition(server);
    assert.equal(resolved?.command, path.join(ext.root, "covdbg.exe"));
});
