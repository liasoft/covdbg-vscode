import test from "node:test";
import assert from "node:assert/strict";
import type { CovdbFileSummary } from "../coverage/covdbParser";
import { buildCoverageSummaryFromFileIndex } from "../coverage/coverageSummary";

function index(...files: [string, number, number][]): Map<string, CovdbFileSummary> {
    return new Map(
        files.map(([filePath, totalLines, coveredLines]) => [
            filePath,
            {
                filePath,
                totalLines,
                coveredLines,
                coveragePercent: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
            },
        ]),
    );
}

test("the summary adds up every file's lines", () => {
    assert.deepEqual(
        buildCoverageSummaryFromFileIndex(index(["a.cpp", 10, 4], ["b.cpp", 20, 16])),
        {
            linesTotal: 30,
            linesCovered: 20,
            linesUncovered: 10,
            coveragePercent: 66.67,
            fileCount: 2,
        },
    );
});

test("the percentage is rounded to two decimals", () => {
    assert.equal(buildCoverageSummaryFromFileIndex(index(["a.cpp", 3, 1])).coveragePercent, 33.33);
    assert.equal(buildCoverageSummaryFromFileIndex(index(["a.cpp", 8, 1])).coveragePercent, 12.5);
});

test("no lines at all is 0%, not a division by zero", () => {
    assert.deepEqual(buildCoverageSummaryFromFileIndex(new Map()), {
        linesTotal: 0,
        linesCovered: 0,
        linesUncovered: 0,
        coveragePercent: 0,
        fileCount: 0,
    });
    assert.equal(buildCoverageSummaryFromFileIndex(index(["empty.h", 0, 0])).fileCount, 1);
});
