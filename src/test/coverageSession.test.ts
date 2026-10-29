import test from "node:test";
import assert from "node:assert/strict";
import { CoverageWorkspaceSession, type CoverageRepository } from "../coverage/coverageSession";
import type { CovdbFileCoverageResult, CovdbIndexResult } from "../coverage/covdbParser";

test("CoverageWorkspaceSession loads index, filters files, and clears caches", async () => {
    const repository: CoverageRepository = {
        loadIndex: async (): Promise<CovdbIndexResult> => ({
            schemaVersion: 1,
            files: new Map([
                [
                    "D:\\repo\\src\\alpha.cpp",
                    {
                        filePath: "D:\\repo\\src\\alpha.cpp",
                        totalLines: 20,
                        coveredLines: 10,
                        coveragePercent: 50,
                    },
                ],
                [
                    "D:\\external\\sdk.cpp",
                    {
                        filePath: "D:\\external\\sdk.cpp",
                        totalLines: 10,
                        coveredLines: 10,
                        coveragePercent: 100,
                    },
                ],
            ]),
        }),
        loadFileCoverage: async (): Promise<CovdbFileCoverageResult> => ({}),
    };

    const session = new CoverageWorkspaceSession(repository);
    const result = await session.loadIndex("D:\\repo\\coverage.covdb", {
        mtime: 42,
        filterFileIndex: (fileIndex) =>
            new Map([...fileIndex].filter(([filePath]) => filePath.startsWith("D:\\repo\\"))),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.loadedFileCount, 1);
    assert.equal(result.totalFileCount, 2);
    assert.equal(result.activeCovdbPath, "D:\\repo\\coverage.covdb");
    assert.equal(result.activeCovdbMtime, 42);
    assert.deepEqual([...result.fileIndex.keys()], ["D:\\repo\\src\\alpha.cpp"]);

    const snapshot = session.snapshot();
    assert.equal(snapshot.cachedCoverageFileCount, 0);
    assert.equal(snapshot.staleCoverageFileCount, 0);
    assert.equal(snapshot.fileIndex.size, 1);
});

test("CoverageWorkspaceSession caches file coverage and reloads stale entries", async () => {
    let loadFileCoverageCallCount = 0;

    const repository: CoverageRepository = {
        loadIndex: async (): Promise<CovdbIndexResult> => ({
            schemaVersion: 1,
            files: new Map(),
        }),
        loadFileCoverage: async (): Promise<CovdbFileCoverageResult> => {
            loadFileCoverageCallCount++;
            return {
                coverage: {
                    sourceFile: "D:\\repo\\src\\alpha.cpp",
                    lines: new Map([
                        [1, { lineNumber: 1, executionCount: 1, isCovered: true }],
                        [2, { lineNumber: 2, executionCount: 0, isCovered: false }],
                    ]),
                    totalLines: 2,
                    coveredLines: 1,
                    coveragePercent: 50,
                },
            };
        },
    };

    const session = new CoverageWorkspaceSession(repository);
    session.replaceIndex("D:\\repo\\coverage.covdb", new Map());

    const first = await session.getOrLoadFileCoverage("D:\\repo\\src\\alpha.cpp");
    const second = await session.getOrLoadFileCoverage("D:\\repo\\src\\alpha.cpp");
    session.markCoverageStale("D:\\repo\\src\\alpha.cpp");
    const third = await session.getOrLoadFileCoverage("D:\\repo\\src\\alpha.cpp");

    assert.equal(first?.coveredLines, 1);
    assert.equal(second?.coveredLines, 1);
    assert.equal(third?.coveredLines, 1);
    assert.equal(loadFileCoverageCallCount, 2);
});

/** A repository with one indexed file, which records each file whose coverage it loads. */
function recordingRepository(options: { indexError?: string; known?: string[] } = {}) {
    const loads: string[] = [];
    const repository: CoverageRepository = {
        loadIndex: async (): Promise<CovdbIndexResult> => ({
            schemaVersion: 1,
            files: new Map([
                [
                    "a.cpp",
                    { filePath: "a.cpp", totalLines: 2, coveredLines: 1, coveragePercent: 50 },
                ],
            ]),
            error: options.indexError,
        }),
        loadFileCoverage: async (_covdb, sourceFile): Promise<CovdbFileCoverageResult> => {
            loads.push(sourceFile);
            if (options.known && !options.known.includes(sourceFile)) {
                return { error: `No coverage data for: ${sourceFile}` };
            }
            return {
                coverage: {
                    sourceFile,
                    lines: new Map(),
                    totalLines: 1,
                    coveredLines: 1,
                    coveragePercent: 100,
                },
            };
        },
    };
    return { repository, loads };
}

test("CoverageWorkspaceSession keeps every file when nothing filters the index", async () => {
    const session = new CoverageWorkspaceSession(recordingRepository().repository);

    const result = await session.loadIndex("D:\\repo\\coverage.covdb");

    assert.equal(result.loadedFileCount, 1);
    assert.equal(session.activeCovdbPath, "D:\\repo\\coverage.covdb");
    assert.equal(session.activeCovdbMtime, 0);
    assert.deepEqual([...session.fileIndex.keys()], ["a.cpp"]);
});

test("CoverageWorkspaceSession keeps what it had when a .covdb fails to load", async () => {
    const options: { indexError?: string } = {};
    const session = new CoverageWorkspaceSession(recordingRepository(options).repository);
    await session.loadIndex("D:\\repo\\good.covdb", { mtime: 7 });

    options.indexError = "file is not a database";
    const result = await session.loadIndex("D:\\repo\\broken.covdb", { mtime: 9 });

    assert.equal(result.error, "file is not a database");
    assert.equal(result.activeCovdbPath, "D:\\repo\\good.covdb");
    assert.equal(result.activeCovdbMtime, 7);
    assert.equal(result.loadedFileCount, 1);
    assert.equal(session.activeCovdbPath, "D:\\repo\\good.covdb");
    assert.equal(session.fileIndex.size, 1);
});

test("CoverageWorkspaceSession loads nothing until a .covdb is loaded, and again after clear", async () => {
    const { repository, loads } = recordingRepository();
    const session = new CoverageWorkspaceSession(repository);

    assert.equal(await session.getOrLoadFileCoverage("a.cpp"), undefined);

    session.replaceIndex("D:\\repo\\coverage.covdb", new Map(), 0, 5);
    await session.getOrLoadFileCoverage("a.cpp");
    session.markCoverageStale("a.cpp");
    session.clear();

    assert.equal(await session.getOrLoadFileCoverage("a.cpp"), undefined);
    assert.deepEqual(loads, ["a.cpp"]);
    assert.deepEqual(session.snapshot(), {
        activeCovdbPath: undefined,
        activeCovdbMtime: 0,
        fileIndex: new Map(),
        cachedCoverageFileCount: 0,
        staleCoverageFileCount: 0,
    });
});

test("CoverageWorkspaceSession forgets a file the .covdb has no coverage for", async () => {
    const session = new CoverageWorkspaceSession(
        recordingRepository({ known: ["a.cpp"] }).repository,
    );
    session.replaceIndex("D:\\repo\\coverage.covdb", new Map());
    session.markCoverageStale("gone.cpp");

    assert.equal(await session.getOrLoadFileCoverage("gone.cpp"), undefined);
    assert.equal(session.hasStaleCoverage("gone.cpp"), false);
    assert.equal(session.snapshot().cachedCoverageFileCount, 0);
});

test("CoverageWorkspaceSession evicts the file used longest ago when its cache is full", async () => {
    const { repository, loads } = recordingRepository();
    const session = new CoverageWorkspaceSession(repository, 2);
    session.replaceIndex("D:\\repo\\coverage.covdb", new Map());

    await session.getOrLoadFileCoverage("a.cpp");
    await session.getOrLoadFileCoverage("b.cpp");
    await session.getOrLoadFileCoverage("a.cpp"); // a.cpp is now the most recent
    await session.getOrLoadFileCoverage("c.cpp"); // so b.cpp goes
    await session.getOrLoadFileCoverage("a.cpp");
    await session.getOrLoadFileCoverage("b.cpp");

    assert.deepEqual(loads, ["a.cpp", "b.cpp", "c.cpp", "b.cpp"]);
    assert.equal(session.snapshot().cachedCoverageFileCount, 2);
});

test("CoverageWorkspaceSession reloads a file once its coverage is cleared", async () => {
    const { repository, loads } = recordingRepository();
    const session = new CoverageWorkspaceSession(repository);
    session.replaceIndex("D:\\repo\\coverage.covdb", new Map());

    await session.getOrLoadFileCoverage("a.cpp");
    session.markCoverageStale("a.cpp");
    assert.equal(session.hasStaleCoverage("a.cpp"), true);
    session.clearCoverage("a.cpp");
    assert.equal(session.hasStaleCoverage("a.cpp"), false);
    await session.getOrLoadFileCoverage("a.cpp");

    assert.deepEqual(loads, ["a.cpp", "a.cpp"]);
});
