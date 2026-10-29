import { vscodeStub, stubEditor } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { ExtensionUnderTest, startExtension, statusBarText, waitFor } from "./extensionHarness";
import { writeCovdb, writeFile } from "./fixtures";

let ext: ExtensionUnderTest;
const sources: Record<string, string> = {};

/** Makes an editor on the folder's source the active one. */
function focus(folder: string) {
    const editor = stubEditor(sources[folder], "int x;\n");
    vscodeStub.window.activeTextEditor = editor;
    vscodeStub.window.visibleTextEditors = [editor];
    vscodeStub.window.activeEditorChanged.fire(editor);
    return editor;
}

function pickLabel(label: string) {
    vscodeStub.window.pick = (items) => items.find((item) => item.label.includes(label));
}

test.before(async () => {
    ext = await startExtension({
        folders: ["app", "lib"],
        account: { email: "dev@example.com" },
        files: async (root) => {
            for (const [folder, lines] of [
                ["app", { 1: 1 }],
                ["lib", { 1: 1, 2: 0, 3: 0, 4: 0 }],
            ] as const) {
                sources[folder] = writeFile(path.join(root, folder, "src", `${folder}.cpp`));
                await writeCovdb(path.join(root, folder, ".covdbg", "coverage.covdb"), {
                    lines: { [sources[folder]]: lines },
                });
            }
        },
    });
    await waitFor(() => vscodeStub.commands.context.get("covdbg.hasCoverage") === true, "load");
});

test.after(() => ext.dispose());

test("each folder loads its own .covdb, and the status bar follows the active editor", async () => {
    focus("lib");
    await waitFor(() => statusBarText() === "$(beaker) 25.0%", "lib's coverage");
    focus("app");
    await waitFor(() => statusBarText() === "$(beaker) 100.0%", "app's coverage");
});

test("closing a .covdb closes only the active editor's folder", async () => {
    const editor = focus("app");
    await waitFor(() => editor.decorations.size > 0, "app's decorations");
    pickLabel("Close Current Database");
    await ext.command("covdbg.configurePath");
    assert.ok([...editor.decorations.values()].every((ranges) => ranges.length === 0));
    assert.equal(statusBarText(), "$(beaker) 25.0%");
});

test("Create .covdbg.yaml asks which folder it is for", async () => {
    vscodeStub.window.pick = (items) => items.find((item) => item.label === "lib");
    await ext.command("covdbg.createConfig");
    assert.ok(fs.existsSync(path.join(ext.root, "lib", ".covdbg.yaml")));
    vscodeStub.window.pick = undefined;
    await ext.command("covdbg.createConfig");
    assert.equal(fs.existsSync(path.join(ext.root, "app", ".covdbg.yaml")), false);
});

test("with no folder open, covdbg.covdbPath still names a .covdb to load", async () => {
    vscodeStub.window.activeTextEditor = undefined;
    vscodeStub.window.visibleTextEditors = [];
    vscodeStub.workspace.workspaceFolders = undefined;
    vscodeStub.workspace.settings.covdbPath = path.join(
        ext.root,
        "app",
        ".covdbg",
        "coverage.covdb",
    );
    vscodeStub.workspace.foldersChanged.fire();
    await waitFor(() => statusBarText() === "$(beaker) 100.0%", "the configured .covdb");

    let root: { description?: string } | undefined;
    vscodeStub.tests.controllers[0].items.forEach((item) => (root = item));
    await waitFor(
        () => root?.description === "Open a workspace folder to discover tests",
        "the Testing view to say why it is empty",
    );

    pickLabel("Close Current Database");
    await ext.command("covdbg.configurePath");
    assert.equal(statusBarText(), "");
});

test("with no folder open, a missing covdbg.covdbPath is logged and nothing loads", async () => {
    vscodeStub.workspace.settings.covdbPath = path.join(ext.root, "missing.covdb");
    vscodeStub.workspace.configurationChanged.fire({
        affectsConfiguration: (key) => key === "covdbg.covdbPath",
    });
    await waitFor(
        () => vscodeStub.window.log.some((line) => line.includes("covdbg.covdbPath not found:")),
        "the missing file to be logged",
    );
    assert.equal(statusBarText(), "");
});

test("with no folder open, the folder commands ask for one", async () => {
    vscodeStub.window.toasts = [];
    await ext.command("covdbg.chooseExecutable");
    await ext.command("covdbg.openConfig");
    await ext.command("covdbg.openLog");
    assert.deepEqual(vscodeStub.window.toasts, [
        "covdbg: Open a workspace folder before choosing an executable.",
        "covdbg: Open a workspace folder before creating .covdbg.yaml.",
        "covdbg: No covdbg.log found for this workspace yet.",
    ]);
});
