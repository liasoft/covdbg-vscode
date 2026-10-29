import { stubFolder, vscodeStub } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import { mergeCoverageFiles, runCoverageForTarget } from "../runner/runnerService";
import { FakeProcess, stubSpawn } from "./fakeCovdbg";
import { tempFolder, writeFile } from "./fixtures";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

/**
 * A workspace folder with covdbg.executablePath set to a covdbg that reports `version`; `run`
 * plays every other covdbg process started.
 */
function workspace(
    run: (process: FakeProcess) => void = (process) => process.exit(0),
    version = "1.5.1",
) {
    const root = tempFolder();
    const covdbg = writeFile(path.join(root, "tools", "covdbg.exe"));
    const target = writeFile(path.join(root, "build", "Debug", "app_tests.exe"));
    vscodeStub.workspace.workspaceFolders = [stubFolder(root)];
    vscodeStub.workspace.settings = { executablePath: covdbg };
    const spawned = stubSpawn((process) => {
        if (process.args[0] === "--version") {
            process.print(`covdbg ${version}\n`);
            process.exit(0);
        } else {
            run(process);
        }
    });
    const runs = () => spawned.started.filter((process) => process.args[0] !== "--version");
    return { root, covdbg, target, runs, restore: spawned.restore };
}

const context = {
    extensionUri: { fsPath: path.join(tempFolder(), "extension") },
    globalStorageUri: { fsPath: path.join(tempFolder(), "storage") },
} as unknown as vscode.ExtensionContext;

test.beforeEach(() => {
    // covdbg runs only on Windows; these tests also run on Linux CI.
    Object.defineProperty(process, "platform", { value: "win32" });
    vscodeStub.workspace.isTrusted = true;
    vscodeStub.env.remoteName = undefined;
    vscodeStub.window.log = [];
});

test.afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vscodeStub.workspace.workspaceFolders = undefined;
    vscodeStub.workspace.settings = {};
    vscodeStub.window.activeTextEditor = undefined;
});

function logged(pattern: RegExp): boolean {
    return vscodeStub.window.log.some((line) => pattern.test(line));
}

test("a run starts covdbg on the target with the settings' output, arguments and environment", async () => {
    const { root, covdbg, target, runs, restore } = workspace();
    try {
        vscodeStub.workspace.settings = {
            executablePath: covdbg,
            "runner.targetArgs": ["--gtest_filter=Suite.*"],
            "runner.outputPath": "out/run.covdb",
            "runner.workingDirectory": "build",
            "runner.env": { MARKER: "1" },
        };
        const result = await runCoverageForTarget(context, target);

        const output = path.join(root, "out", "run.covdb");
        assert.deepEqual(result, { success: true, outputPath: output, notices: [] });
        const [run] = runs();
        assert.equal(run.command, covdbg);
        assert.deepEqual(run.args, ["--output", output, target, "--gtest_filter=Suite.*"]);
        assert.equal(run.options.cwd, path.join(root, "build"));
        assert.equal(run.options.env?.MARKER, "1");
        assert.ok(fs.existsSync(path.join(root, "out")));
        assert.ok(logged(/No \.covdbg\.yaml resolved explicitly/));
        assert.ok(logged(/Running coverage \(setting\): .*covdbg\.exe \(covdbg 1\.5\.1\)/));
        assert.ok(logged(/Coverage run finished/));
    } finally {
        restore();
    }
});

test("without settings a run lands in .covdbg under the folder, with the nearest .covdbg.yaml", async () => {
    const { root, target, runs, restore } = workspace();
    try {
        const config = writeFile(path.join(root, "build", ".covdbg.yaml"), "version: 1");
        const result = await runCoverageForTarget(context, target);

        const output = path.join(root, ".covdbg", "coverage.covdb");
        assert.equal(result.outputPath, output);
        assert.deepEqual(runs()[0].args, ["--config", config, "--output", output, target]);
        assert.equal(runs()[0].options.cwd, root);
    } finally {
        restore();
    }
});

test("a relative target is found in the folder, and an output override is used as given", async () => {
    const { root, target, runs, restore } = workspace();
    try {
        const override = path.join(root, "batch", ".", "app_tests.covdb");
        const result = await runCoverageForTarget(
            context,
            path.join("build", "Debug", "app_tests.exe"),
            override,
        );

        assert.equal(result.outputPath, path.normalize(override));
        assert.equal(runs()[0].args[2], target);
    } finally {
        restore();
    }
});

test("what covdbg says about the license comes back as notices, however the pipe splits it", async () => {
    const { target, restore } = workspace((process) => {
        process.print("covdbg: collecting coverage for app_tests.exe\n");
        process.stderr.emit("data", Buffer.from("covdbg: This run is not "));
        process.stderr.emit("data", Buffer.from("licensed: Sign in with `covdbg login`."));
        process.exit(1);
    });
    try {
        const result = await runCoverageForTarget(context, target);

        assert.equal(result.success, false);
        assert.deepEqual(result.notices, [
            { kind: "refused", message: "Sign in with `covdbg login`.", action: "signIn" },
        ]);
        assert.equal(result.problem, undefined);
        assert.ok(logged(/collecting coverage for app_tests\.exe/));
        assert.ok(logged(/ERROR: covdbg exited with code 1/));
    } finally {
        restore();
    }
});

test("a project token in covdbg.runner.env routes a refusal to the app, not to signing in", async () => {
    const { covdbg, target, restore } = workspace((process) => {
        process.stderr.emit(
            "data",
            Buffer.from("covdbg: This run is not licensed: Sign in with `covdbg login`.\n"),
        );
        process.exit(1);
    });
    try {
        vscodeStub.workspace.settings = {
            executablePath: covdbg,
            "runner.env": { COVDBG_PROJECT_TOKEN: "cvt_123" },
        };
        const result = await runCoverageForTarget(context, target);
        assert.equal(result.notices[0].action, "openApp");
    } finally {
        restore();
    }
});

test("a run that finds no functions to track says how to fix the filters", async () => {
    const { target, restore } = workspace((process) => process.exit(2));
    try {
        const result = await runCoverageForTarget(context, target);

        assert.equal(result.success, false);
        assert.match(result.problem?.message ?? "", /No functions passed the coverage filter/);
        assert.deepEqual(result.problem?.actions, []);
    } finally {
        restore();
    }
});

test("a covdbg that cannot be started fails the run", async () => {
    const { target, restore } = workspace((process) =>
        process.emit("error", new Error("spawn EACCES")),
    );
    try {
        const result = await runCoverageForTarget(context, target);

        assert.equal(result.success, false);
        assert.equal(result.problem, undefined);
        assert.ok(logged(/ERROR: Failed to start covdbg: spawn EACCES/));
    } finally {
        restore();
    }
});

test("a run needs a trusted, local Windows window", async () => {
    const { target, runs, restore } = workspace();
    try {
        Object.defineProperty(process, "platform", { value: "linux" });
        assert.deepEqual((await runCoverageForTarget(context, target)).problem, {
            message: "covdbg runner is supported only on Windows.",
            actions: [],
        });

        Object.defineProperty(process, "platform", { value: "win32" });
        vscodeStub.workspace.isTrusted = false;
        assert.deepEqual((await runCoverageForTarget(context, target)).problem, {
            message: "covdbg runner requires a trusted workspace.",
            actions: ["Manage Trust"],
        });

        vscodeStub.workspace.isTrusted = true;
        vscodeStub.env.remoteName = "wsl";
        assert.deepEqual((await runCoverageForTarget(context, target)).problem, {
            message: "covdbg runner requires local Windows VS Code. Current remote: wsl",
            actions: [],
        });
        assert.equal(runs().length, 0);
    } finally {
        restore();
    }
});

test("a run needs a folder, a target that exists and the config it names", async () => {
    const { root, covdbg, target, runs, restore } = workspace();
    try {
        vscodeStub.workspace.settings = {
            executablePath: covdbg,
            "runner.configPath": "missing.yaml",
        };
        assert.equal(
            (await runCoverageForTarget(context, target)).problem?.message,
            `Config file not found: ${path.join(root, "missing.yaml")}`,
        );

        assert.match(
            (await runCoverageForTarget(context, path.join(root, "gone.exe"))).problem?.message ??
                "",
            /No runnable test executable found/,
        );

        vscodeStub.workspace.workspaceFolders = undefined;
        assert.equal(
            (await runCoverageForTarget(context, "app_tests.exe")).problem?.message,
            "Open a workspace folder before running coverage.",
        );
        assert.equal(runs().length, 0);
    } finally {
        restore();
    }
});

test("a covdbg too old to drive is reported instead of run", async () => {
    const { target, runs, restore } = workspace(undefined, "1.2.0");
    try {
        const result = await runCoverageForTarget(context, target);

        assert.match(result.problem?.message ?? "", /points at covdbg 1\.2\.0, but covdbg 1\.4\.0/);
        assert.equal(runs().length, 0);
    } finally {
        restore();
    }
});

test("merging passes every input to covdbg merge and logs what it prints", async () => {
    const { root, covdbg, runs, restore } = workspace((process) => {
        process.print("merged 2 files\n");
        process.stderr.emit("data", Buffer.from("warning: skipped nothing\n"));
        process.exit(0);
    });
    try {
        vscodeStub.workspace.settings = { executablePath: covdbg, "runner.env": { MARKER: "1" } };
        const output = path.join(root, "merged", "all.covdb");
        assert.equal(await mergeCoverageFiles(context, ["a.covdb", "b.covdb"], output), true);

        const [merge] = runs();
        assert.deepEqual(merge.args, [
            "merge",
            "--input",
            "a.covdb",
            "--input",
            "b.covdb",
            "--output",
            output,
        ]);
        assert.equal(merge.options.cwd, root);
        assert.equal(merge.options.env?.MARKER, "1");
        assert.ok(fs.existsSync(path.dirname(output)));
        assert.ok(logged(/Merging 2 coverage file\(s\) into /));
        assert.ok(logged(/merged 2 files$/));
        assert.ok(logged(/warning: skipped nothing$/));
    } finally {
        restore();
    }
});

test("a merge runs in the folder it is given", async () => {
    const { runs, restore } = workspace();
    try {
        const other = tempFolder();
        const output = path.join(other, "all.covdb");
        assert.equal(
            await mergeCoverageFiles(
                context,
                ["a.covdb"],
                output,
                stubFolder(other) as vscode.WorkspaceFolder,
            ),
            true,
        );
        assert.equal(runs()[0].options.cwd, other);
    } finally {
        restore();
    }
});

test("a merge that fails or cannot start reports false", async () => {
    const failing = workspace((process) => process.exit(4));
    try {
        const output = path.join(failing.root, "all.covdb");
        assert.equal(await mergeCoverageFiles(context, ["a.covdb"], output), false);
        assert.ok(logged(/ERROR: covdbg merge exited with code 4/));
    } finally {
        failing.restore();
    }

    const broken = workspace((process) => process.emit("error", new Error("spawn ENOENT")));
    try {
        const output = path.join(broken.root, "all.covdb");
        assert.equal(await mergeCoverageFiles(context, ["a.covdb"], output), false);
        assert.ok(logged(/ERROR: Failed to start covdbg merge: spawn ENOENT/));
    } finally {
        broken.restore();
    }
});

test("nothing is merged without inputs, a folder or a window that can run covdbg", async () => {
    const { root, runs, restore } = workspace();
    try {
        const output = path.join(root, "all.covdb");
        assert.equal(await mergeCoverageFiles(context, [], output), false);

        vscodeStub.workspace.isTrusted = false;
        assert.equal(await mergeCoverageFiles(context, ["a.covdb"], output), false);
        assert.ok(logged(/covdbg merge unavailable: covdbg runner requires a trusted workspace/));
        vscodeStub.workspace.isTrusted = true;

        vscodeStub.workspace.workspaceFolders = undefined;
        assert.equal(await mergeCoverageFiles(context, ["a.covdb"], output), false);
        assert.ok(logged(/covdbg merge requires an open workspace folder/));
        assert.equal(runs().length, 0);
    } finally {
        restore();
    }
});

test("a covdbg too old to drive merges nothing", async () => {
    const { root, runs, restore } = workspace(undefined, "1.2.0");
    try {
        assert.equal(
            await mergeCoverageFiles(context, ["a.covdb"], path.join(root, "all.covdb")),
            false,
        );
        assert.ok(
            logged(/ERROR: covdbg merge failed: covdbg\.executablePath points at covdbg 1\.2\.0/),
        );
        assert.equal(runs().length, 0);
    } finally {
        restore();
    }
});
