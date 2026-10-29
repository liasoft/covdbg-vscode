import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import {
    getWorkspaceFoldersInPreferenceOrder,
    readRunnerSettings,
    resolvePathFromWorkspace,
} from "./settings";
import { buildExecutableDiscoveryExcludePattern } from "./discoveryPatterns";

interface CandidateExe {
    absolutePath: string;
    score: number;
}

export async function resolveTargetExecutable(
    requestedTarget: string,
    workspaceRoot: string,
): Promise<string | undefined> {
    const resolved = resolvePathFromWorkspace(requestedTarget, workspaceRoot);
    return (await isFile(resolved)) ? resolved : undefined;
}

export async function resolveEffectiveConfigPath(
    configuredConfigPath: string,
    targetExecutablePath: string,
    workspaceRoot: string,
): Promise<string | undefined> {
    const explicit = configuredConfigPath.trim();
    if (explicit) {
        const explicitResolved = resolvePathFromWorkspace(explicit, workspaceRoot);
        if (await isFile(explicitResolved)) {
            return explicitResolved;
        }
        return undefined;
    }

    return findNearestCovdbgYaml(path.dirname(targetExecutablePath), workspaceRoot);
}

export async function discoverExecutableCandidates(): Promise<CandidateExe[]> {
    const candidates: CandidateExe[] = [];

    for (const folder of getWorkspaceFoldersInPreferenceOrder()) {
        const settings = readRunnerSettings(folder.uri);
        const pattern = settings.binaryDiscoveryPattern;
        const excludePattern = buildExecutableDiscoveryExcludePattern(
            settings.binaryDiscoveryExcludePattern,
        );
        const matches = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, pattern),
            excludePattern,
            500,
        );
        for (const uri of matches) {
            if (!(await isDiscoveredExecutable(uri.fsPath))) {
                continue;
            }
            candidates.push({
                absolutePath: uri.fsPath,
                score: scoreExecutable(uri.fsPath.toLowerCase()),
            });
        }
    }
    return candidates.sort(
        (a, b) => b.score - a.score || a.absolutePath.localeCompare(b.absolutePath),
    );
}

export async function listDiscoveredExecutablePaths(): Promise<string[]> {
    const candidates = await discoverExecutableCandidates();
    return candidates.map((c) => c.absolutePath);
}

function scoreExecutable(p: string): number {
    let score = 0;
    if (p.includes("\\build\\") || p.includes("/build/")) {
        score += 20;
    }
    if (p.includes("\\out\\") || p.includes("/out/")) {
        score += 15;
    }
    if (p.includes("test")) {
        score += 40;
    }
    if (p.includes("gtest")) {
        score += 30;
    }
    if (p.endsWith("tests.exe")) {
        score += 25;
    }
    if (p.includes("\\debug\\") || p.includes("/debug/")) {
        score -= 5;
    }
    return score;
}

async function findNearestCovdbgYaml(
    startDir: string,
    workspaceRoot: string,
): Promise<string | undefined> {
    let current = path.resolve(startDir);
    const root = path.resolve(workspaceRoot);
    while (true) {
        const candidate = path.join(current, ".covdbg.yaml");
        if (await isFile(candidate)) {
            return candidate;
        }
        if (current === root) {
            break;
        }
        const parent = path.dirname(current);
        if (parent === current || !parent.startsWith(root)) {
            break;
        }
        current = parent;
    }
    // A target outside the folder, chosen through Browse…, uses the folder's own config, which is
    // where the starter is written.
    const rootConfig = path.join(root, ".covdbg.yaml");
    return (await isFile(rootConfig)) ? rootConfig : undefined;
}

async function isFile(filePath: string): Promise<boolean> {
    try {
        const stats = await fs.stat(filePath);
        return stats.isFile();
    } catch {
        return false;
    }
}

async function isDiscoveredExecutable(filePath: string): Promise<boolean> {
    if (path.extname(filePath).toLowerCase() !== ".exe") {
        return false;
    }

    if (path.basename(filePath).toLowerCase() === "covdbg.exe") {
        return false;
    }

    return isFile(filePath);
}
