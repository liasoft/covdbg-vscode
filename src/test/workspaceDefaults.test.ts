import { stubFolder, vscodeStub } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    DEFAULT_BINARY_DISCOVERY_EXCLUDE_PATTERN,
    DEFAULT_BINARY_DISCOVERY_PATTERN,
    buildExecutableDiscoveryExcludePattern,
} from "../runner/discoveryPatterns";
import {
    listDiscoveredExecutablePaths,
    resolveEffectiveConfigPath,
    resolveTargetExecutable,
} from "../runner/workspaceDefaults";
import { tempFolder, writeFile } from "./fixtures";

test("buildExecutableDiscoveryExcludePattern returns builtin excludes by default", () => {
    assert.equal(
        buildExecutableDiscoveryExcludePattern(""),
        "**/{.git,node_modules,.vscode,assets}/**",
    );
});

test("buildExecutableDiscoveryExcludePattern combines builtin and user excludes", () => {
    assert.equal(
        buildExecutableDiscoveryExcludePattern("**/copied-tests/**"),
        "{**/{.git,node_modules,.vscode,assets}/**,**/copied-tests/**}",
    );
});

/** Whether the default discovery settings pick this workspace-relative path. */
function discovered(relativePath: string): boolean {
    return (
        path.posix.matchesGlob(relativePath, DEFAULT_BINARY_DISCOVERY_PATTERN) &&
        !path.posix.matchesGlob(relativePath, DEFAULT_BINARY_DISCOVERY_EXCLUDE_PATTERN)
    );
}

test("default discovery finds CMake, MSBuild and CLion debug test executables", () => {
    for (const found of [
        "build/Debug/test_app.exe",
        "out/build/x64-Debug/tests/UnitTests.exe",
        "x64/Debug/ParserTests.exe",
        "cmake-build-debug/tests/app_test.exe",
    ]) {
        assert.ok(discovered(found), found);
    }
});

test("default discovery skips optimized builds and executables that are not tests", () => {
    for (const skipped of [
        "build/Release/test_app.exe",
        "x64/RelWithDebInfo/ParserTests.exe",
        "cmake-build-release/tests/app_test.exe",
        "cmake-build-relwithdebinfo-visual-studio/tests/app_test.exe",
        "build/Debug/app.exe",
        "tools/test_runner.exe",
    ]) {
        assert.ok(!discovered(skipped), skipped);
    }
});

test("the manifest's discovery defaults are the ones the settings fall back to", () => {
    const manifest = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    );
    const properties = manifest.contributes.configuration.properties;

    assert.equal(
        properties["covdbg.runner.binaryDiscoveryPattern"].default,
        DEFAULT_BINARY_DISCOVERY_PATTERN,
    );
    assert.equal(
        properties["covdbg.runner.binaryDiscoveryExcludePattern"].default,
        DEFAULT_BINARY_DISCOVERY_EXCLUDE_PATTERN,
    );
});

test("a target outside the folder uses the folder's own .covdbg.yaml", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covdbg-config-"));
    try {
        const folder = path.join(dir, "project");
        const nested = path.join(folder, "build", "Debug");
        fs.mkdirSync(nested, { recursive: true });
        fs.mkdirSync(path.join(dir, "elsewhere"));
        const rootConfig = path.join(folder, ".covdbg.yaml");
        fs.writeFileSync(rootConfig, "version: 1");
        fs.writeFileSync(path.join(nested, ".covdbg.yaml"), "version: 1");

        assert.equal(
            await resolveEffectiveConfigPath("", path.join(dir, "elsewhere", "test.exe"), folder),
            rootConfig,
        );
        assert.equal(
            await resolveEffectiveConfigPath("", path.join(nested, "test.exe"), folder),
            path.join(nested, ".covdbg.yaml"),
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("an explicit config is used when it exists, and none is found when it does not", async () => {
    const folder = tempFolder();
    const config = writeFile(path.join(folder, "cfg", "covdbg.yaml"), "version: 1");
    writeFile(path.join(folder, ".covdbg.yaml"), "version: 1");
    const target = path.join(folder, "build", "test.exe");

    assert.equal(await resolveEffectiveConfigPath(" cfg/covdbg.yaml ", target, folder), config);
    assert.equal(await resolveEffectiveConfigPath("missing.yaml", target, folder), undefined);
});

test("without any .covdbg.yaml there is no config", async () => {
    const folder = tempFolder();
    assert.equal(
        await resolveEffectiveConfigPath("", path.join(folder, "build", "test.exe"), folder),
        undefined,
    );
});

test("a target is resolved against the folder and must be a file", async () => {
    const folder = tempFolder();
    const target = writeFile(path.join(folder, "build", "app_tests.exe"));

    assert.equal(await resolveTargetExecutable("build/app_tests.exe", folder), target);
    assert.equal(await resolveTargetExecutable(target, folder), target);
    assert.equal(await resolveTargetExecutable("build", folder), undefined);
    assert.equal(await resolveTargetExecutable("missing.exe", folder), undefined);
});

test("discovery lists test executables, likeliest first, never covdbg itself", async (t) => {
    const folder = tempFolder();
    for (const file of [
        "build/Debug/app_tests.exe",
        "build/Debug/covdbg.exe",
        "build/gtest_main_test.exe",
        "build/Debug/test_notes.txt",
        "build/Release/app_tests.exe",
        "out/x64/unit_test.exe",
        "x64/Debug/ParserTest.exe",
        "x64/Debug/OtherTest.exe",
        "build/app.exe",
    ]) {
        writeFile(path.join(folder, file));
    }
    vscodeStub.workspace.workspaceFolders = [stubFolder(folder)];
    t.after(() => (vscodeStub.workspace.workspaceFolders = undefined));

    assert.deepEqual(await listDiscoveredExecutablePaths(), [
        path.join(folder, "build", "gtest_main_test.exe"),
        path.join(folder, "build", "Debug", "app_tests.exe"),
        path.join(folder, "out", "x64", "unit_test.exe"),
        path.join(folder, "x64", "Debug", "OtherTest.exe"),
        path.join(folder, "x64", "Debug", "ParserTest.exe"),
    ]);
});

test("discovery looks in every folder with its pattern settings, never at covdbg itself", async (t) => {
    const first = tempFolder();
    const second = tempFolder();
    writeFile(path.join(first, "bin", "runner.exe"));
    writeFile(path.join(second, "bin", "runner.exe"));
    writeFile(path.join(second, "bin", "skipped", "runner.exe"));
    writeFile(path.join(second, "bin", "covdbg.exe"));
    vscodeStub.workspace.workspaceFolders = [stubFolder(first, 0), stubFolder(second, 1)];
    vscodeStub.workspace.settings = {
        "runner.binaryDiscoveryPattern": "bin/**/*.exe",
        "runner.binaryDiscoveryExcludePattern": "**/skipped/**",
    };
    t.after(() => {
        vscodeStub.workspace.workspaceFolders = undefined;
        vscodeStub.workspace.settings = {};
    });

    const found = await listDiscoveredExecutablePaths();
    assert.deepEqual(
        found.sort(),
        [path.join(first, "bin", "runner.exe"), path.join(second, "bin", "runner.exe")].sort(),
    );
});
