import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import * as output from "../views/outputChannel";
import { buildCovdbgArguments } from "./runnerArgs";
import { describeRuntimeProblem, resolveCovdbgRuntime } from "./executableResolver";
import { COVDBG_EXIT_NO_FUNCTIONS_TO_TRACK, getCovdbgRunFailureMessage } from "./exitCodes";
import { LineBuffer } from "./lineBuffer";
import { RunNotice, classifyRunLine } from "./runOutcome";
import {
    getPreferredWorkspaceFolder,
    getWorkspaceRoot,
    readRunnerSettings,
    resolveRunnerPaths,
} from "./settings";
import { resolveEffectiveConfigPath, resolveTargetExecutable } from "./workspaceDefaults";

export interface RunResult {
    success: boolean;
    outputPath?: string;
    /** What covdbg said about the run's license: a refusal, an ended sign-in, a lock, gating. */
    notices: RunNotice[];
    /** Why the run could not start, or found nothing to measure; the caller decides how to say so. */
    problem?: RunProblem;
}

export interface RunProblem {
    message: string;
    actions: string[];
}

export async function runCoverageForTarget(
    context: vscode.ExtensionContext,
    targetExecutablePath: string,
    outputPathOverride?: string,
): Promise<RunResult> {
    const trustErr = await ensurePreflight();
    if (trustErr) {
        return { success: false, notices: [], problem: trustErr };
    }

    const workspaceFolder = getPreferredWorkspaceFolder(targetExecutablePath);
    const settings = readRunnerSettings(workspaceFolder?.uri);
    const workspaceRoot = workspaceFolder?.uri.fsPath ?? getWorkspaceRoot();
    if (!workspaceRoot) {
        return fail("Open a workspace folder before running coverage.");
    }

    const effectiveTargetExecutablePath = await resolveTargetExecutable(
        targetExecutablePath,
        workspaceRoot,
    );
    if (!effectiveTargetExecutablePath) {
        return fail(
            "No runnable test executable found. Refresh test discovery or build a test binary first.",
        );
    }

    const paths = resolveRunnerPaths(settings, workspaceRoot);
    const outputPath = outputPathOverride ? path.normalize(outputPathOverride) : paths.outputPath;

    const explicitConfig = settings.configPath.trim();
    const effectiveConfigPath = await resolveEffectiveConfigPath(
        explicitConfig,
        effectiveTargetExecutablePath,
        workspaceRoot,
    );
    if (explicitConfig && !effectiveConfigPath) {
        return fail(`Config file not found: ${paths.configPath ?? explicitConfig}`);
    }
    if (!effectiveConfigPath) {
        output.log(
            "No .covdbg.yaml resolved explicitly; covdbg will use its built-in config discovery.",
        );
    }

    const resolvedExe = await resolveCovdbgRuntime(context, settings, workspaceRoot);
    if (resolvedExe.kind !== "ok") {
        return fail(describeRuntimeProblem(resolvedExe));
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    output.log(
        `Running coverage (${resolvedExe.source}): ${resolvedExe.path} (covdbg ${resolvedExe.version})`,
    );

    // The run carries no licence of its own: covdbg decides it from the machine's sign-in
    // (`covdbg login`) or from COVDBG_PROJECT_TOKEN in the environment, and says so when neither is
    // there. Its notices about the license are read from whole lines, so the editor can offer the fix.
    const args = buildCovdbgArguments(
        {
            ...paths,
            configPath: effectiveConfigPath,
            outputPath,
        },
        effectiveTargetExecutablePath,
        settings.targetArgs,
    );
    const env = {
        ...process.env,
        ...settings.env,
    };
    const projectToken = Boolean(env["COVDBG_PROJECT_TOKEN"]?.trim());
    const notices: RunNotice[] = [];
    const readLines = (stream: "stdout" | "stderr") =>
        new LineBuffer((line) => {
            output.log(line);
            const notice = classifyRunLine(stream, line, projectToken);
            if (notice) {
                notices.push(notice);
            }
        });

    let problem: RunProblem | undefined;
    const executeRun = () =>
        new Promise<boolean>((resolve) => {
            const child = spawn(resolvedExe.path, args, {
                cwd: paths.workingDirectory,
                env,
                windowsHide: true,
            });

            const stdout = readLines("stdout");
            const stderr = readLines("stderr");
            child.stdout.on("data", (chunk) => stdout.push(chunk));
            child.stderr.on("data", (chunk) => stderr.push(chunk));
            child.on("error", (error) => {
                output.logError(`Failed to start covdbg: ${error.message}`);
                resolve(false);
            });
            child.on("close", (code) => {
                stdout.flush();
                stderr.flush();
                const ok = code === 0;
                if (!ok) {
                    const failureMessage = getCovdbgRunFailureMessage(code);
                    output.logError(failureMessage);
                    if (code === COVDBG_EXIT_NO_FUNCTIONS_TO_TRACK) {
                        problem = { message: failureMessage, actions: [] };
                    }
                } else {
                    output.log(`Coverage run finished. Output: ${outputPath}`);
                }
                resolve(ok);
            });
        });

    const success = await executeRun();

    if (success) {
        return {
            success: true,
            outputPath,
            notices,
        };
    }
    return {
        success: false,
        outputPath,
        notices,
        problem,
    };
}

function fail(message: string): RunResult {
    return { success: false, notices: [], problem: { message, actions: [] } };
}

export async function mergeCoverageFiles(
    context: vscode.ExtensionContext,
    inputPaths: string[],
    outputPath: string,
    workspaceFolder?: vscode.WorkspaceFolder,
): Promise<boolean> {
    const trustErr = await ensurePreflight();
    if (trustErr) {
        output.logError(`covdbg merge unavailable: ${trustErr.message}`);
        return false;
    }

    if (inputPaths.length === 0) {
        return false;
    }

    const workspaceRoot = workspaceFolder?.uri.fsPath ?? getWorkspaceRoot();
    if (!workspaceRoot) {
        output.logError("covdbg merge requires an open workspace folder.");
        return false;
    }

    const settings = readRunnerSettings(workspaceFolder?.uri);
    const resolvedExe = await resolveCovdbgRuntime(context, settings, workspaceRoot);
    if (resolvedExe.kind !== "ok") {
        output.logError(`covdbg merge failed: ${describeRuntimeProblem(resolvedExe)}`);
        return false;
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const args = [
        "merge",
        ...inputPaths.flatMap((inputPath) => ["--input", inputPath]),
        "--output",
        outputPath,
    ];

    output.log(`Merging ${inputPaths.length} coverage file(s) into ${outputPath}`);

    return new Promise<boolean>((resolve) => {
        const child = spawn(resolvedExe.path, args, {
            cwd: workspaceRoot,
            env: {
                ...process.env,
                ...settings.env,
            },
            windowsHide: true,
        });

        child.stdout.on("data", (chunk) => output.log(String(chunk).trimEnd()));
        child.stderr.on("data", (chunk) => output.log(String(chunk).trimEnd()));
        child.on("error", (error) => {
            output.logError(`Failed to start covdbg merge: ${error.message}`);
            resolve(false);
        });
        child.on("close", (code) => {
            const ok = code === 0;
            if (!ok) {
                output.logError(`covdbg merge exited with code ${code}`);
            }
            resolve(ok);
        });
    });
}

async function ensurePreflight(): Promise<RunProblem | undefined> {
    if (process.platform !== "win32") {
        return {
            message: "covdbg runner is supported only on Windows.",
            actions: [],
        };
    }
    if (!vscode.workspace.isTrusted) {
        return {
            message: "covdbg runner requires a trusted workspace.",
            actions: ["Manage Trust"],
        };
    }
    if (vscode.env.remoteName) {
        return {
            message: `covdbg runner requires local Windows VS Code. Current remote: ${vscode.env.remoteName}`,
            actions: [],
        };
    }
    return undefined;
}
