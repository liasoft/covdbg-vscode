import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import initSqlJs from "sql.js";

/** A new empty folder under the system temp folder. */
export function tempFolder(): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "covdbg-test-")));
}

/** Writes `text` to `filePath`, creating its folder; returns the path. */
export function writeFile(filePath: string, text = ""): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
    return filePath;
}

export interface CovdbContent {
    /** Execution counts by source file, then by line; every line listed is executable. */
    lines?: Record<string, Record<number, number>>;
    functions?: {
        filePath: string;
        functionName: string;
        startLine: number;
        endLine: number;
        hitCount: number;
    }[];
    /** Leaves out the schema version, which makes the file no .covdb. */
    schemaVersion?: number | null;
}

/** Writes a .covdb with the tables covdbg writes and the extension reads; returns the path. */
export async function writeCovdb(filePath: string, content: CovdbContent): Promise<string> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE metadata (key TEXT, value TEXT)");
    db.run(
        "CREATE TABLE line_coverage (file_path TEXT, line_number INTEGER, execution_count INTEGER, is_executable INTEGER)",
    );
    db.run(
        "CREATE TABLE function_coverage (file_path TEXT, function_name TEXT, start_line INTEGER, end_line INTEGER, hit_count INTEGER)",
    );
    if (content.schemaVersion !== null) {
        db.run("INSERT INTO metadata VALUES ('schema_version', ?)", [
            String(content.schemaVersion ?? 3),
        ]);
    }
    for (const [sourceFile, lines] of Object.entries(content.lines ?? {})) {
        for (const [line, count] of Object.entries(lines)) {
            db.run("INSERT INTO line_coverage VALUES (?, ?, ?, 1)", [
                sourceFile,
                Number(line),
                count,
            ]);
        }
        // A line that is not executable never counts.
        db.run("INSERT INTO line_coverage VALUES (?, 9999, 0, 0)", [sourceFile]);
    }
    for (const fn of content.functions ?? []) {
        db.run("INSERT INTO function_coverage VALUES (?, ?, ?, ?, ?)", [
            fn.filePath,
            fn.functionName,
            fn.startLine,
            fn.endLine,
            fn.hitCount,
        ]);
    }
    writeFile(filePath);
    fs.writeFileSync(filePath, db.export());
    db.close();
    return filePath;
}

/**
 * The parser loads sql.js's WebAssembly from beside itself, where the bundle puts it; the compiled
 * tests have it there too once this has run.
 */
export function provideSqlWasm(): void {
    const target = path.join(__dirname, "..", "coverage", "sql-wasm.wasm");
    if (!fs.existsSync(target)) {
        fs.copyFileSync(require.resolve("sql.js/dist/sql-wasm.wasm"), target);
    }
}
