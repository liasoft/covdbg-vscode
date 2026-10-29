import * as path from "path";

export function deriveCoverageBatchOutputPath(
    configuredOutputPath: string,
    targetExecutablePath: string,
): string {
    const outputPathLib = getPathLibrary(configuredOutputPath);
    const targetPathLib = getPathLibrary(targetExecutablePath);
    const parsedOutputPath = outputPathLib.parse(outputPathLib.normalize(configuredOutputPath));
    const parsedTargetPath = targetPathLib.parse(targetPathLib.normalize(targetExecutablePath));
    const targetBaseName = sanitizeOutputSegment(parsedTargetPath.name) || "coverage";
    return outputPathLib.join(parsedOutputPath.dir, `${targetBaseName}.covdb`);
}

export function dedupeNormalizedPaths(paths: string[]): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const filePath of paths) {
        const normalizedPath = path.normalize(filePath);
        const key = normalizedPath.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(normalizedPath);
    }
    return deduped;
}

function sanitizeOutputSegment(value: string): string {
    return value
        .trim()
        .replace(/[<>:"/\\|?*]+/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

function getPathLibrary(filePath: string): typeof path.posix | typeof path.win32 {
    return /^[a-zA-Z]:[\\/]|^\\\\/.test(filePath) || filePath.includes("\\")
        ? path.win32
        : path.posix;
}
