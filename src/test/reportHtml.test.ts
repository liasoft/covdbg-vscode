import test from "node:test";
import assert from "node:assert/strict";
import type { CovdbFileSummary, CovdbFunctionSummary } from "../coverage/covdbParser";
import {
    TreeNode,
    buildTree,
    esc,
    generateReportHtml,
    pctCssVar,
    renderTreeHtml,
} from "../views/reportHtml";

/** Files keyed by an absolute path whose display path is the part after `C:/ws/`. */
function files(...entries: [string, number, number][]): Map<string, CovdbFileSummary> {
    return new Map(
        entries.map(([display, totalLines, coveredLines]) => {
            const filePath = `C:/ws/${display}`;
            const coveragePercent = totalLines > 0 ? (coveredLines / totalLines) * 100 : 0;
            return [filePath, { filePath, totalLines, coveredLines, coveragePercent }];
        }),
    );
}

const relative = (filePath: string) => filePath.replace("C:/ws/", "");

const INDEX = files(
    ["src/main.cpp", 10, 5],
    ["src/core/io/read.cpp", 10, 10],
    ["lib/deep/only/util.cpp", 4, 1],
    ["top.cpp", 2, 0],
    ["include\\api.h", 0, 0],
);

function fn(functionName: string, startLine: number, hitCount: number): CovdbFunctionSummary {
    return {
        filePath: "C:/ws/src/main.cpp",
        functionName,
        startLine,
        endLine: startLine + 2,
        hitCount,
    };
}

const FUNCTIONS = new Map([["C:/ws/src/main.cpp", [fn("main", 1, 3), fn("unused", 8, 0)]]]);

const child = (node: TreeNode, name: string) => {
    const found = [...node.children.values()].find((c) => c.name === name);
    assert.ok(found, `${node.name || "the root"} has no ${name}`);
    return found;
};

/** The labels of every row, in order, with their depth. */
const rows = (html: string) =>
    [
        ...html.matchAll(
            /<div class="(?:tree-item \w+|fn-summary) depth-(\d+)"[^>]*>.*?class="label[^"]*">([^<]*)</g,
        ),
    ].map(([, depth, label]) => `${depth} ${label}`);

test("the tree has a folder per path segment, and backslashes separate them too", () => {
    const tree = buildTree(INDEX, FUNCTIONS, relative);

    assert.deepEqual([...tree.children.values()].map((c) => c.name).sort(), [
        "include",
        "lib/deep/only",
        "src",
        "top.cpp",
    ]);
    const header = child(child(tree, "include"), "api.h");
    assert.deepEqual(header.file, {
        absPath: "C:/ws/include\\api.h",
        display: "include\\api.h",
        covered: 0,
        total: 0,
        pct: 0,
    });
});

test("a folder that holds only one folder is merged with it, one that holds a file is not", () => {
    const tree = buildTree(INDEX, FUNCTIONS, relative);

    const lib = child(tree, "lib/deep/only");
    assert.equal(lib.fullPath, "lib/deep/only");
    assert.equal(child(lib, "util.cpp").file?.absPath, "C:/ws/lib/deep/only/util.cpp");
    assert.ok(child(child(tree, "src"), "core/io"));
    assert.equal(child(tree, "include").children.size, 1);
});

test("folders add up the lines of everything under them, and files carry their functions", () => {
    const tree = buildTree(INDEX, FUNCTIONS, relative);
    const src = child(tree, "src");

    assert.deepEqual([tree.aggCovered, tree.aggTotal], [16, 26]);
    assert.deepEqual([src.aggCovered, src.aggTotal], [15, 20]);
    assert.equal(child(src, "main.cpp").functions?.length, 2);
    assert.equal(child(tree, "top.cpp").functions, undefined);
});

test("coverage is good from 80%, fair from 50% and bad below", () => {
    assert.equal(pctCssVar(80), "var(--cov-good)");
    assert.equal(pctCssVar(79.9), "var(--cov-warn)");
    assert.equal(pctCssVar(50), "var(--cov-warn)");
    assert.equal(pctCssVar(49.9), "var(--cov-bad)");
});

test("text is escaped before it goes into the page", () => {
    assert.equal(esc(`a<b>&"c"`), "a&lt;b&gt;&amp;&quot;c&quot;");
});

test("folders come before files, each alphabetically, nested by depth", () => {
    const html = renderTreeHtml(buildTree(INDEX, FUNCTIONS, relative));

    assert.deepEqual(rows(html), [
        "0 include",
        "1 api.h",
        "0 lib/deep/only",
        "1 util.cpp",
        "0 src",
        "1 core/io",
        "2 read.cpp",
        "1 main.cpp",
        "2 1/2 functions hit",
        "2 main",
        "2 unused",
        "0 top.cpp",
    ]);
});

test("a file row shows its lines, bar and percentage; a folder with no lines is 0%", () => {
    const html = renderTreeHtml(buildTree(INDEX, FUNCTIONS, relative));

    assert.match(
        html,
        /<div class="tree-item file depth-1" data-path="C:\/ws\/src\/main.cpp"><span class="indent" style="width:16px"><\/span><span class="toggle collapsed"><\/span>/,
    );
    assert.match(
        html,
        /<span class="stats">5\/10<\/span>.*?width:50%;background:var\(--cov-warn\).*?50\.0%/,
    );
    assert.match(
        html,
        /folder-name">include<\/span><span class="stats">0\/0<\/span>.*?width:0%;background:var\(--cov-bad\).*?>0\.0%</,
    );
    assert.match(
        html,
        /data-path="C:\/ws\/top.cpp"><span class="indent" style="width:0px"><\/span><span class="toggle-placeholder">/,
    );
});

test("functions show their lines and how often they ran, and link to their first line", () => {
    const html = renderTreeHtml(buildTree(INDEX, FUNCTIONS, relative));

    assert.match(
        html,
        /data-line="1">.*?L1–3<\/span><span class="fn-hit" style="color:var\(--cov-good\)">3x</,
    );
    assert.match(
        html,
        /data-line="8">.*?L8–10<\/span><span class="fn-hit" style="color:var\(--cov-bad\)">miss</,
    );
});

test("names from the .covdb are escaped in the tree", () => {
    const html = renderTreeHtml(buildTree(files(['<b>&"x".cpp', 1, 1]), new Map(), relative));

    assert.match(html, /data-path="C:\/ws\/&lt;b&gt;&amp;&quot;x&quot;.cpp"/);
    assert.match(html, /<span class="label">&lt;b&gt;&amp;&quot;x&quot;.cpp<\/span>/);
});

test("the page sums up lines, files and functions", () => {
    const html = generateReportHtml({
        fileIndex: INDEX,
        functionIndex: FUNCTIONS,
        asRelativePath: relative,
    });

    assert.match(html, /<span class="summary-pct" style="color:var\(--cov-warn\)">61\.5%<\/span>/);
    assert.match(html, /16 \/ 26 lines &bull; 5 files<br>\s*1 \/ 2 functions hit/);
    assert.match(html, /<script>\s*const vscode = acquireVsCodeApi\(\);/);
});

test("an empty report reads 0%", () => {
    const html = generateReportHtml({
        fileIndex: new Map(),
        functionIndex: new Map(),
        asRelativePath: relative,
    });

    assert.match(html, /color:var\(--cov-bad\)">0\.0%/);
    assert.match(html, /0 \/ 0 lines &bull; 0 files<br>\s*0 \/ 0 functions hit/);
    assert.match(html, /<div id="tree"><\/div>/);
});
