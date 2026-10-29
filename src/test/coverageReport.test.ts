import { vscodeStub, stubFolder } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import type { CovdbFileSummary } from "../coverage/covdbParser";
import { CoverageReport } from "../views/coverageReport";
import { provideSqlWasm, tempFolder, writeCovdb, writeFile } from "./fixtures";

provideSqlWasm();

const window = vscodeStub.window;
const last = <T>(items: T[]) => items[items.length - 1];

/** A workspace with one source file and a .covdb that covers it. */
async function workspace() {
    const root = tempFolder();
    const source = writeFile(path.join(root, "src", "main.cpp"), "int main() {\n    run();\n}\n");
    const covdbPath = await writeCovdb(path.join(root, "coverage.covdb"), {
        lines: { [source]: { 1: 1, 2: 0 } },
        functions: [
            { filePath: source, functionName: "main", startLine: 1, endLine: 3, hitCount: 1 },
        ],
    });
    const fileIndex = new Map<string, CovdbFileSummary>([
        [source, { filePath: source, totalLines: 2, coveredLines: 1, coveragePercent: 50 }],
    ]);
    return { root, source, covdbPath, fileIndex };
}

/** Waits for the report to finish handling a webview message, which it does unawaited. */
async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !done(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(done(), "the report never got there");
}

test("with nothing loaded the report says so instead of opening", async () => {
    const report = new CoverageReport();
    const panels = window.panels.length;

    await report.show(new Map(), undefined);

    assert.equal(window.panels.length, panels);
    assert.equal(last(window.toasts), "covdbg: No coverage data loaded.");
});

test("the report shows files and functions, relative to the workspace folder", async () => {
    const { root, covdbPath, fileIndex } = await workspace();
    vscodeStub.workspace.workspaceFolders = [stubFolder(root)];
    const report = new CoverageReport();

    await report.show(fileIndex, covdbPath);

    const panel = last(window.panels);
    assert.equal(panel.title, "covdbg Coverage Report");
    assert.match(panel.webview.html, /1 \/ 2 lines &bull; 1 files/);
    assert.match(panel.webview.html, /1 \/ 1 functions hit/);
    assert.match(panel.webview.html, /<span class="label folder-name">src<\/span>/);
    assert.match(panel.webview.html, /<span class="label fn-name">main<\/span>/);
    report.dispose();
    vscodeStub.workspace.workspaceFolders = undefined;
});

test("without a workspace folder files are named by their file name", async () => {
    const { fileIndex } = await workspace();
    const report = new CoverageReport();

    await report.show(fileIndex, undefined);

    const html = last(window.panels).webview.html;
    assert.match(html, /<span class="label">main\.cpp<\/span>/);
    assert.doesNotMatch(html, /class="label folder-name"/);
    assert.match(html, /0 \/ 0 functions hit/, "with no .covdb there are no functions");
    report.dispose();
});

test("showing the report again reuses its panel; once closed, a new one opens", async () => {
    const { covdbPath, fileIndex } = await workspace();
    const report = new CoverageReport();
    const panels = window.panels.length;

    await report.show(fileIndex, covdbPath);
    await report.show(fileIndex, covdbPath);
    assert.equal(window.panels.length, panels + 1);
    assert.equal(last(window.panels).revealed, 1);

    // The user closes it.
    last(window.panels).dispose();
    await report.show(fileIndex, covdbPath);
    assert.equal(window.panels.length, panels + 2);
    report.dispose();
});

test("an update redraws an open report, and does nothing when it is closed", async () => {
    const { source, covdbPath, fileIndex } = await workspace();
    const report = new CoverageReport();
    const panels = window.panels.length;

    await report.update(fileIndex, covdbPath);
    assert.equal(window.panels.length, panels, "an update never opens the report");

    await report.show(fileIndex, covdbPath);
    const panel = last(window.panels);
    const better = new Map([
        [source, { filePath: source, totalLines: 2, coveredLines: 2, coveragePercent: 100 }],
    ]);
    await report.update(better, covdbPath);
    assert.match(panel.webview.html, /2 \/ 2 lines/);
    report.dispose();
});

test("after the .covdb is reloaded the next update reads its functions again", async () => {
    const { source, covdbPath, fileIndex } = await workspace();
    const report = new CoverageReport();
    await report.show(fileIndex, covdbPath);
    const panel = last(window.panels);

    await writeCovdb(covdbPath, {
        lines: { [source]: { 1: 1, 2: 1 } },
        functions: [
            { filePath: source, functionName: "main", startLine: 1, endLine: 3, hitCount: 1 },
            { filePath: source, functionName: "run", startLine: 2, endLine: 2, hitCount: 0 },
        ],
    });
    await report.update(fileIndex, covdbPath);
    assert.match(panel.webview.html, /1 \/ 1 functions hit/, "functions are cached until cleared");

    report.clearFunctionIndex();
    await report.update(fileIndex, covdbPath);
    assert.match(panel.webview.html, /1 \/ 2 functions hit/);
    report.dispose();
});

test("an update that finishes after the report was closed does nothing", async () => {
    const { covdbPath, fileIndex } = await workspace();
    const report = new CoverageReport();
    await report.show(fileIndex, covdbPath);
    report.clearFunctionIndex();

    // The update waits for the functions while the report closes.
    const updating = report.update(fileIndex, covdbPath);
    report.dispose();

    await assert.doesNotReject(updating);
});

test("clicking a function opens its file at that line", async () => {
    const { source, covdbPath, fileIndex } = await workspace();
    const report = new CoverageReport();
    await report.show(fileIndex, covdbPath);
    const panel = last(window.panels);
    const shown = window.editors.length;

    panel.received.fire({ command: "openFile", filePath: source, line: 2 });
    await until(() => window.editors.length === shown + 1);

    const editor = last(window.editors);
    assert.equal(editor.document.fileName, source);
    assert.equal(editor.selection?.start.line, 1);
    assert.equal(editor.revealed?.start.line, 1);
    report.dispose();
});

test("clicking a file opens it without moving the cursor", async () => {
    const { source, covdbPath, fileIndex } = await workspace();
    const report = new CoverageReport();
    await report.show(fileIndex, covdbPath);
    const panel = last(window.panels);
    const shown = window.editors.length;

    panel.received.fire({ command: "openFile", filePath: source, line: 0 });
    await until(() => window.editors.length === shown + 1);

    assert.equal(last(window.editors).selection, undefined);
    report.dispose();
});

test("a file that cannot be opened is a warning, and other messages are ignored", async () => {
    const { root, covdbPath, fileIndex } = await workspace();
    const report = new CoverageReport();
    await report.show(fileIndex, covdbPath);
    const panel = last(window.panels);
    const shown = window.shown.length;
    const gone = path.join(root, "src", "deleted.cpp");

    panel.received.fire({ command: "refresh", filePath: gone });
    panel.received.fire({ command: "openFile" });
    panel.received.fire({ command: "openFile", filePath: gone });
    await until(() => last(window.toasts) === `Cannot open: ${gone}`);

    assert.equal(window.shown.length, shown);
    report.dispose();
});
