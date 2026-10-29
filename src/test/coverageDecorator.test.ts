import { vscodeStub, stubEditor } from "./vscodeStub";
import type * as vscode from "vscode";
import test from "node:test";
import assert from "node:assert/strict";
import { CoverageDecorator } from "../coverage/coverageDecorator";
import type { FileCoverage } from "../coverage/covdbParser";

const TEXT = ["int main() {", "    run();", "    return 0;", "}"].join("\n");

/** Line 1 ran once, line 2 three times, line 3 never; line 9 is past the end of the file. */
const COVERAGE: FileCoverage = {
    sourceFile: "C:/app/main.cpp",
    lines: new Map(
        (
            [
                [1, 1],
                [2, 3],
                [3, 0],
                [9, 5],
            ] as const
        ).map(([lineNumber, executionCount]) => [
            lineNumber,
            { lineNumber, executionCount, isCovered: executionCount > 0 },
        ]),
    ),
    totalLines: 4,
    coveredLines: 3,
    coveragePercent: 75,
};

/** What the editor shows, by decoration: each range as `line:end hover`. */
function decorate(decorator: CoverageDecorator, coverage = COVERAGE) {
    const editor = stubEditor("C:/app/main.cpp", TEXT);
    decorator.applyDecorations(editor as unknown as vscode.TextEditor, coverage);
    const [lineCovered, lineUncovered, gutterCovered, gutterUncovered] = [
        ...editor.decorations.values(),
    ].map((ranges) =>
        ranges.map(
            ({ range, hoverMessage }) =>
                `${range.start.line}:${range.end.character} ${hoverMessage}`,
        ),
    );
    return { editor, lineCovered, lineUncovered, gutterCovered, gutterUncovered };
}

test("by default whole lines are highlighted, with how often each ran", () => {
    const decorator = new CoverageDecorator();
    const shown = decorate(decorator);

    assert.equal(decorator.getRenderMode(), "line");
    assert.deepEqual(shown.lineCovered, [
        "0:12 Covered (executed 1 time)",
        "1:10 Covered (executed 3 times)",
    ]);
    assert.deepEqual(shown.lineUncovered, ["2:13 Not covered"]);
    assert.deepEqual(shown.gutterCovered, []);
    assert.deepEqual(shown.gutterUncovered, []);
});

test("gutter mode shows icons only, and both shows both", () => {
    const decorator = new CoverageDecorator();

    decorator.setRenderMode("gutter");
    const gutter = decorate(decorator);
    assert.equal(decorator.getRenderMode(), "gutter");
    assert.deepEqual(gutter.lineCovered, []);
    assert.deepEqual(gutter.lineUncovered, []);
    assert.equal(gutter.gutterCovered.length, 2);
    assert.deepEqual(gutter.gutterUncovered, ["2:13 Not covered"]);

    decorator.setRenderMode("both");
    const both = decorate(decorator);
    assert.equal(both.lineCovered.length, 2);
    assert.equal(both.gutterCovered.length, 2);
    assert.equal(both.lineUncovered.length, 1);
    assert.equal(both.gutterUncovered.length, 1);
});

test("lines outside the file are skipped", () => {
    const decorator = new CoverageDecorator();
    const outside: FileCoverage = {
        ...COVERAGE,
        lines: new Map([
            [0, { lineNumber: 0, executionCount: 1, isCovered: true }],
            [5, { lineNumber: 5, executionCount: 0, isCovered: false }],
        ]),
    };

    const shown = decorate(decorator, outside);

    assert.deepEqual(shown.lineCovered, []);
    assert.deepEqual(shown.lineUncovered, []);
});

test("while coverage is hidden nothing is drawn, and clearing removes every decoration", () => {
    const decorator = new CoverageDecorator();

    decorator.setEnabled(false);
    assert.equal(decorator.isDisplayEnabled(), false);
    assert.equal(decorate(decorator).editor.decorations.size, 0);

    decorator.setEnabled(true);
    const { editor } = decorate(decorator);
    decorator.clearDecorations(editor as unknown as vscode.TextEditor);
    assert.deepEqual([...editor.decorations.values()], [[], [], [], []]);
});

test("the gutter icons are green and red bars, and disposing frees all four styles", () => {
    const before = vscodeStub.window.decorationTypes.length;
    const decorator = new CoverageDecorator();
    const types = vscodeStub.window.decorationTypes.slice(before);
    const icon = (index: number) =>
        Buffer.from(
            String(types[index].options.gutterIconPath).split("base64,")[1],
            "base64",
        ).toString();

    assert.equal(types.length, 4);
    assert.match(icon(2), /fill="#4caf50"/);
    assert.match(icon(3), /fill="#f44336"/);

    decorator.dispose();
    assert.deepEqual(
        types.map((type) => type.disposed),
        [true, true, true, true],
    );
});
