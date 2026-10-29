import { vscodeStub } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import initSqlJs from "sql.js";
import { CovdbParser } from "../coverage/covdbParser";
import { provideSqlWasm, tempFolder, writeCovdb, writeFile } from "./fixtures";

provideSqlWasm();

const MAIN = "C:/app/src/main.cpp";
const UTIL = "C:/app/src/util.cpp";

/** A .covdb with two files and three functions, in a new folder. */
async function sampleCovdb(): Promise<string> {
    return writeCovdb(path.join(tempFolder(), "coverage.covdb"), {
        lines: { [MAIN]: { 1: 3, 2: 0, 3: 1, 4: 0 }, [UTIL]: { 10: 0 } },
        functions: [
            { filePath: UTIL, functionName: "helper", startLine: 10, endLine: 12, hitCount: 0 },
            { filePath: MAIN, functionName: "run", startLine: 3, endLine: 4, hitCount: 1 },
            { filePath: MAIN, functionName: "main", startLine: 1, endLine: 2, hitCount: 2 },
        ],
    });
}

/** A file that is not SQLite at all. */
function notADatabase(): string {
    return writeFile(path.join(tempFolder(), "broken.covdb"), "this is not a database");
}

const lastLog = () => vscodeStub.window.log[vscodeStub.window.log.length - 1] ?? "";

// sql.js starts once per process, so this test runs first: it is the parser that starts it here,
// with the WebAssembly from beside itself, as in the bundled extension.
test("a file that is not SQLite is not a .covdb", async () => {
    const covdbPath = notADatabase();

    const result = await CovdbParser.loadIndex(covdbPath);

    assert.equal(result.files.size, 0);
    assert.equal(result.error, `Invalid .covdb file (no schema version): ${covdbPath}`);
});

test("the index lists each file with its executable and covered line counts", async () => {
    const result = await CovdbParser.loadIndex(await sampleCovdb());

    assert.equal(result.error, undefined);
    assert.equal(result.schemaVersion, 3);
    assert.deepEqual(
        [...result.files.values()],
        [
            { filePath: MAIN, totalLines: 4, coveredLines: 2, coveragePercent: 50 },
            { filePath: UTIL, totalLines: 1, coveredLines: 0, coveragePercent: 0 },
        ],
    );
    assert.match(lastLog(), /Indexed 2 files from \.covdb \(schema v3\)$/);
});

test("a missing .covdb gives an empty index and says so", async () => {
    const missing = path.join(tempFolder(), "nowhere.covdb");

    const result = await CovdbParser.loadIndex(missing);

    assert.equal(result.files.size, 0);
    assert.equal(result.schemaVersion, 0);
    assert.equal(result.error, `Cannot load .covdb: file not found: ${missing}`);
    assert.match(lastLog(), /ERROR: Cannot load \.covdb: file not found/);
});

test("a database without a schema version is not a .covdb", async () => {
    const covdbPath = await writeCovdb(path.join(tempFolder(), "old.covdb"), {
        schemaVersion: null,
    });

    const result = await CovdbParser.loadIndex(covdbPath);

    assert.equal(result.files.size, 0);
    assert.equal(result.error, `Invalid .covdb file (no schema version): ${covdbPath}`);
});

test("a .covdb missing its line table reports the database's own error", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE metadata (key TEXT, value TEXT)");
    db.run("INSERT INTO metadata VALUES ('schema_version', '3')");
    const covdbPath = path.join(tempFolder(), "partial.covdb");
    fs.writeFileSync(covdbPath, db.export());
    db.close();

    const result = await CovdbParser.loadIndex(covdbPath);

    assert.equal(result.files.size, 0);
    assert.match(result.error ?? "", /no such table: line_coverage/);
    assert.match(lastLog(), /ERROR: Failed to index \.covdb: no such table/);
});

test("a file's line coverage marks each executable line covered or not", async () => {
    const result = await CovdbParser.loadFileCoverage(await sampleCovdb(), MAIN);

    assert.equal(result.error, undefined);
    const coverage = result.coverage!;
    assert.equal(coverage.sourceFile, MAIN);
    assert.equal(coverage.totalLines, 4);
    assert.equal(coverage.coveredLines, 2);
    assert.equal(coverage.coveragePercent, 50);
    assert.deepEqual(coverage.lines.get(1), { lineNumber: 1, executionCount: 3, isCovered: true });
    assert.deepEqual(coverage.lines.get(2), { lineNumber: 2, executionCount: 0, isCovered: false });
    assert.equal(coverage.lines.has(9999), false, "a line that is not executable is left out");
});

test("line coverage for a file the .covdb does not have, or from a missing or broken .covdb, is an error", async () => {
    const covdbPath = await sampleCovdb();
    const missing = path.join(tempFolder(), "nowhere.covdb");

    assert.deepEqual(await CovdbParser.loadFileCoverage(covdbPath, "C:/app/other.cpp"), {
        error: "No coverage data for: C:/app/other.cpp",
    });
    assert.deepEqual(await CovdbParser.loadFileCoverage(missing, MAIN), {
        error: `File not found: ${missing}`,
    });
    const broken = await CovdbParser.loadFileCoverage(notADatabase(), MAIN);
    assert.equal(broken.coverage, undefined);
    assert.match(broken.error ?? "", /not a database/);
});

test("the function index groups functions by file, in line order", async () => {
    const functions = await CovdbParser.loadFunctionIndex(await sampleCovdb());

    assert.deepEqual([...functions.keys()], [MAIN, UTIL]);
    assert.deepEqual(
        functions.get(MAIN)!.map((fn) => [fn.functionName, fn.startLine, fn.endLine, fn.hitCount]),
        [
            ["main", 1, 2, 2],
            ["run", 3, 4, 1],
        ],
    );
    assert.deepEqual(functions.get(UTIL), [
        { filePath: UTIL, functionName: "helper", startLine: 10, endLine: 12, hitCount: 0 },
    ]);
});

test("a missing or broken .covdb has no functions", async () => {
    const missing = await CovdbParser.loadFunctionIndex(path.join(tempFolder(), "nowhere.covdb"));
    const broken = await CovdbParser.loadFunctionIndex(notADatabase());

    assert.equal(missing.size, 0);
    assert.equal(broken.size, 0);
    assert.match(lastLog(), /ERROR: Failed to load function index: .*not a database/);
});

test("a failure that is not an Error is still reported as text", async () => {
    const covdbPath = await sampleCovdb();
    const promises = fs.promises as { readFile: unknown };
    const readFile = promises.readFile;
    promises.readFile = () => Promise.reject("disk gone");
    try {
        assert.equal((await CovdbParser.loadIndex(covdbPath)).error, "disk gone");
        assert.deepEqual(await CovdbParser.loadFileCoverage(covdbPath, MAIN), {
            error: "disk gone",
        });
        assert.equal((await CovdbParser.loadFunctionIndex(covdbPath)).size, 0);
        assert.match(lastLog(), /ERROR: Failed to load function index: disk gone$/);
    } finally {
        promises.readFile = readFile;
    }
});
