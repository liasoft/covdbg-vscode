import * as fs from "fs/promises";
import * as path from "path";
import initSqlJs, { Database } from "sql.js";
import * as output from "../views/outputChannel";

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

export interface LineCoverage {
    lineNumber: number;
    executionCount: number;
    isCovered: boolean;
}

export interface FileCoverage {
    sourceFile: string;
    lines: Map<number, LineCoverage>;
    totalLines: number;
    coveredLines: number;
    coveragePercent: number;
}

/** Summary stats for a single file, loaded from the index query. */
export interface CovdbFileSummary {
    filePath: string;
    totalLines: number;
    coveredLines: number;
    coveragePercent: number;
}

/** Function-level coverage entry. */
export interface CovdbFunctionSummary {
    filePath: string;
    functionName: string;
    startLine: number;
    endLine: number;
    hitCount: number;
}

/** Result of loading the file index from a .covdb. */
export interface CovdbIndexResult {
    files: Map<string, CovdbFileSummary>;
    schemaVersion: number;
    error?: string;
}

/** Result of loading line-level coverage for a single file. */
export interface CovdbFileCoverageResult {
    coverage?: FileCoverage;
    error?: string;
}

/** Cached SQL.js module so we only call initSqlJs() once. */
let sqlJsModule: Awaited<ReturnType<typeof initSqlJs>> | undefined;

async function getSqlJs(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
    if (!sqlJsModule) {
        sqlJsModule = await initSqlJs({
            locateFile: () => path.join(__dirname, "sql-wasm.wasm"),
        });
    }
    return sqlJsModule;
}

/**
 * Directly queries a .covdb SQLite database to extract coverage data.
 * Supports two modes:
 *   1. `loadIndex` — fast: just file paths + summary stats (no line data)
 *   2. `loadFileCoverage` — on-demand: line-level data for a single file
 */
export class CovdbParser {
    // -----------------------------------------------------------------------
    // Index: file list + summary stats
    // -----------------------------------------------------------------------

    /**
     * Load the file index from a .covdb — all tracked file paths with
     * summary coverage numbers. Does NOT load individual line data.
     */
    public static async loadIndex(covdbPath: string): Promise<CovdbIndexResult> {
        const files = new Map<string, CovdbFileSummary>();

        if (!(await fileExists(covdbPath))) {
            const msg = `Cannot load .covdb: file not found: ${covdbPath}`;
            output.logError(msg);
            return { files, schemaVersion: 0, error: msg };
        }

        let db: Database | undefined;
        try {
            const SQL = await getSqlJs();
            const fileBuffer = await fs.readFile(covdbPath);
            db = new SQL.Database(fileBuffer);

            const version = CovdbParser.getSchemaVersion(db);
            if (version === undefined) {
                const msg = `Invalid .covdb file (no schema version): ${covdbPath}`;
                output.logError(msg);
                return { files, schemaVersion: 0, error: msg };
            }

            // Aggregate query: one row per file with total/covered counts
            const stmt = db.prepare(`
                SELECT
                    file_path,
                    COUNT(*) AS total_lines,
                    SUM(CASE WHEN execution_count > 0 THEN 1 ELSE 0 END) AS covered_lines
                FROM line_coverage
                WHERE is_executable = 1
                GROUP BY file_path
                ORDER BY file_path
            `);

            while (stmt.step()) {
                const row = stmt.getAsObject() as {
                    file_path: string;
                    total_lines: number;
                    covered_lines: number;
                };
                // Each row groups at least one line, so total_lines is never 0.
                files.set(row.file_path, {
                    filePath: row.file_path,
                    totalLines: row.total_lines,
                    coveredLines: row.covered_lines,
                    coveragePercent: (row.covered_lines / row.total_lines) * 100,
                });
            }
            stmt.free();

            output.log(`Indexed ${files.size} files from .covdb (schema v${version})`);
            return { files, schemaVersion: version };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            output.logError(`Failed to index .covdb: ${message}`);
            return { files, schemaVersion: 0, error: message };
        } finally {
            db?.close();
        }
    }

    // -----------------------------------------------------------------------
    // Per-file: line-level coverage
    // -----------------------------------------------------------------------

    /**
     * Load line-level coverage for a single source file from the .covdb.
     */
    public static async loadFileCoverage(
        covdbPath: string,
        sourceFilePath: string,
    ): Promise<CovdbFileCoverageResult> {
        if (!(await fileExists(covdbPath))) {
            return { error: `File not found: ${covdbPath}` };
        }

        let db: Database | undefined;
        try {
            const SQL = await getSqlJs();
            const fileBuffer = await fs.readFile(covdbPath);
            db = new SQL.Database(fileBuffer);

            const stmt = db.prepare(`
                SELECT line_number, execution_count
                FROM line_coverage
                WHERE file_path = :path AND is_executable = 1
                ORDER BY line_number
            `);
            stmt.bind({ ":path": sourceFilePath });

            const lines = new Map<number, LineCoverage>();
            let totalLines = 0;
            let coveredLines = 0;

            while (stmt.step()) {
                const row = stmt.getAsObject() as {
                    line_number: number;
                    execution_count: number;
                };
                const isCovered = row.execution_count > 0;
                lines.set(row.line_number, {
                    lineNumber: row.line_number,
                    executionCount: row.execution_count,
                    isCovered,
                });
                totalLines++;
                if (isCovered) {
                    coveredLines++;
                }
            }
            stmt.free();

            if (totalLines === 0) {
                return { error: `No coverage data for: ${sourceFilePath}` };
            }

            const coveragePercent = (coveredLines / totalLines) * 100;
            return {
                coverage: {
                    sourceFile: sourceFilePath,
                    lines,
                    totalLines,
                    coveredLines,
                    coveragePercent,
                },
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { error: message };
        } finally {
            db?.close();
        }
    }

    // -----------------------------------------------------------------------
    // Function-level coverage (for report)
    // -----------------------------------------------------------------------

    /**
     * Load all function coverage entries from the .covdb.
     * Returns a map from file_path to its function summaries.
     */
    public static async loadFunctionIndex(
        covdbPath: string,
    ): Promise<Map<string, CovdbFunctionSummary[]>> {
        const result = new Map<string, CovdbFunctionSummary[]>();
        if (!(await fileExists(covdbPath))) {
            return result;
        }

        let db: Database | undefined;
        try {
            const SQL = await getSqlJs();
            const fileBuffer = await fs.readFile(covdbPath);
            db = new SQL.Database(fileBuffer);

            const stmt = db.prepare(`
                SELECT file_path, function_name, start_line, end_line, hit_count
                FROM function_coverage
                ORDER BY file_path, start_line
            `);

            while (stmt.step()) {
                const row = stmt.getAsObject() as {
                    file_path: string;
                    function_name: string;
                    start_line: number;
                    end_line: number;
                    hit_count: number;
                };
                const entry: CovdbFunctionSummary = {
                    filePath: row.file_path,
                    functionName: row.function_name,
                    startLine: row.start_line,
                    endLine: row.end_line,
                    hitCount: row.hit_count,
                };
                const arr = result.get(row.file_path);
                if (arr) {
                    arr.push(entry);
                } else {
                    result.set(row.file_path, [entry]);
                }
            }
            stmt.free();
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            output.logError(`Failed to load function index: ${message}`);
            return result;
        } finally {
            db?.close();
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static getSchemaVersion(db: Database): number | undefined {
        try {
            const stmt = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'");
            if (stmt.step()) {
                const row = stmt.getAsObject() as { value: string };
                stmt.free();
                return parseInt(row.value, 10);
            }
            stmt.free();
            return undefined;
        } catch {
            return undefined;
        }
    }
}
