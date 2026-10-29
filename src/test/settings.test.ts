import { stubEditor, stubFolder, vscodeStub } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { DEFAULT_BINARY_DISCOVERY_PATTERN } from "../runner/discoveryPatterns";
import {
    getPreferredWorkspaceFolder,
    getWorkspaceFoldersInPreferenceOrder,
    getWorkspaceRoot,
    readRunnerSettings,
    resolveRunnerPaths,
} from "../runner/settings";

const FIRST = path.resolve("work", "first");
const SECOND = path.resolve("work", "second");

test.beforeEach(() => {
    vscodeStub.workspace.workspaceFolders = [stubFolder(FIRST, 0), stubFolder(SECOND, 1)];
});

test.afterEach(() => {
    vscodeStub.workspace.workspaceFolders = undefined;
    vscodeStub.workspace.settings = {};
    vscodeStub.window.activeTextEditor = undefined;
});

test("settings are read trimmed, with the default discovery pattern for a blank one", () => {
    vscodeStub.workspace.settings = {
        executablePath: "  C:/covdbg/covdbg.exe ",
        portableCachePath: " cache ",
        "runner.binaryDiscoveryPattern": "   ",
        "runner.binaryDiscoveryExcludePattern": " **/skip/** ",
        "runner.targetArgs": [" --gtest_filter=A.* ", 3, ""],
        "runner.configPath": " .covdbg.yaml ",
        "runner.outputPath": " out/cov.covdb ",
        "runner.workingDirectory": " build ",
        "runner.env": { GOOD: "1", NUMBER: 2, "": "nameless" },
    };
    assert.deepEqual(readRunnerSettings(), {
        executablePath: "C:/covdbg/covdbg.exe",
        portableCachePath: "cache",
        binaryDiscoveryPattern: DEFAULT_BINARY_DISCOVERY_PATTERN,
        binaryDiscoveryExcludePattern: "**/skip/**",
        targetArgs: ["--gtest_filter=A.*"],
        configPath: ".covdbg.yaml",
        outputPath: "out/cov.covdb",
        workingDirectory: "build",
        env: { GOOD: "1" },
    });
});

test("paths in the settings resolve against the folder, absolute ones as they are", () => {
    const config = path.resolve("elsewhere", "covdbg.yaml");
    const paths = resolveRunnerPaths(
        { ...readRunnerSettings(), configPath: config, workingDirectory: "build" },
        FIRST,
    );
    assert.deepEqual(paths, {
        workspaceRoot: FIRST,
        configPath: config,
        configuredOutputPath: path.join(FIRST, "build", ".covdbg", "coverage.covdb"),
        outputPath: path.join(FIRST, "build", ".covdbg", "coverage.covdb"),
        appDataPath: path.join(FIRST, "build", ".covdbg"),
        workingDirectory: path.join(FIRST, "build"),
    });
});

test("the folder a file is in is preferred, then the active editor's, then the first", () => {
    assert.equal(getPreferredWorkspaceFolder(path.join(SECOND, "app.exe"))?.uri.fsPath, SECOND);
    assert.equal(getPreferredWorkspaceFolder("app.exe")?.uri.fsPath, FIRST);
    assert.equal(getWorkspaceRoot(), FIRST);

    vscodeStub.window.activeTextEditor = stubEditor(path.join(SECOND, "src", "main.cpp"));
    assert.equal(getPreferredWorkspaceFolder(path.resolve("outside.exe"))?.uri.fsPath, SECOND);
    assert.equal(getWorkspaceRoot(), SECOND);

    vscodeStub.window.activeTextEditor = stubEditor(path.resolve("outside.cpp"));
    assert.equal(getWorkspaceRoot(), FIRST);

    vscodeStub.workspace.workspaceFolders = undefined;
    assert.equal(getWorkspaceRoot(), undefined);
});

test("folders are listed with the preferred one first", () => {
    assert.deepEqual(
        getWorkspaceFoldersInPreferenceOrder().map((folder) => folder.uri.fsPath),
        [FIRST, SECOND],
    );

    vscodeStub.window.activeTextEditor = stubEditor(path.join(SECOND, "main.cpp"));
    assert.deepEqual(
        getWorkspaceFoldersInPreferenceOrder().map((folder) => folder.uri.fsPath),
        [SECOND, FIRST],
    );

    vscodeStub.workspace.workspaceFolders = undefined;
    assert.deepEqual(getWorkspaceFoldersInPreferenceOrder(), []);
});
