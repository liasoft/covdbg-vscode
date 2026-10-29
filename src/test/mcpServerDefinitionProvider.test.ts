import { vscodeStub } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import type * as vscode from "vscode";
import { CovdbgMcpServerDefinitionProvider } from "../mcp/serverDefinitionProvider";
import type { RunnerSettings, RuntimeState } from "../runner/runnerTypes";

const ROOT = path.resolve("work", "app");
const OK: RuntimeState = {
    kind: "ok",
    path: "C:/covdbg/covdbg.exe",
    version: "1.4.0",
    source: "path",
};
const TOO_OLD: RuntimeState = {
    kind: "tooOld",
    path: "C:/old/covdbg.exe",
    version: "1.2.0",
    fromSetting: false,
};

/** A provider whose covdbg the test controls; `resolved` records every resolution asked for. */
function provider(runtime: RuntimeState = OK, lastCheck?: RuntimeState) {
    const resolved: { settings: RunnerSettings; workspaceRoot: string }[] = [];
    const instance = new CovdbgMcpServerDefinitionProvider({
        resolveRuntime: async (settings, workspaceRoot) => {
            resolved.push({ settings, workspaceRoot });
            return runtime;
        },
        runtimeProblem: () => (lastCheck && lastCheck.kind !== "ok" ? lastCheck : undefined),
    });
    return { instance, resolved };
}

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

test.beforeEach(() => {
    // The server is offered only on Windows; these tests also run on Linux CI.
    Object.defineProperty(process, "platform", { value: "win32" });
    vscodeStub.workspace.isTrusted = true;
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: ROOT } }];
    vscodeStub.workspace.settings = {};
});

test.afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vscodeStub.workspace.workspaceFolders = undefined;
    vscodeStub.workspace.settings = {};
});

test("the server is started with --workspace and runs from the working directory", async () => {
    const { instance } = provider();
    const [server] = instance.provideMcpServerDefinitions();

    assert.deepEqual(server.args, ["mcp", "--workspace", ROOT]);
    assert.equal((server.cwd as vscode.Uri).fsPath, ROOT);

    const resolved = await instance.resolveMcpServerDefinition(server);
    assert.equal(resolved?.command, OK.path);
    assert.equal(resolved?.version, "1.4.0");
    assert.deepEqual(resolved?.args, ["mcp", "--workspace", ROOT]);
});

test("covdbg is resolved for the folder the definition was offered for", async () => {
    const { instance, resolved } = provider();
    const [server] = instance.provideMcpServerDefinitions();

    // Another folder becomes the preferred one between offering and starting.
    const other = path.resolve("work", "other");
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: other } }];

    await instance.resolveMcpServerDefinition(server);
    assert.equal(resolved[0].workspaceRoot, ROOT);
});

test("the environment is covdbg.runner.env plus COVDBG_OUTPUT, and nothing about licenses", () => {
    vscodeStub.workspace.settings = {
        "runner.env": { COVDBG_PROJECT_TOKEN: "cvt_123" },
        "runner.outputPath": "out/cov.covdb",
    };
    const [server] = provider().instance.provideMcpServerDefinitions();

    assert.deepEqual(server.env, {
        COVDBG_PROJECT_TOKEN: "cvt_123",
        COVDBG_OUTPUT: path.join(ROOT, "out", "cov.covdb"),
    });
});

test("without an output setting COVDBG_OUTPUT is covdbg's own default, as an absolute path", () => {
    vscodeStub.workspace.settings = { "runner.workingDirectory": "build" };
    const [server] = provider().instance.provideMcpServerDefinitions();

    assert.equal(server.env.COVDBG_OUTPUT, path.join(ROOT, "build", ".covdbg", "coverage.covdb"));
    assert.equal((server.cwd as vscode.Uri).fsPath, path.join(ROOT, "build"));
});

test("refresh tells the editor the definitions changed", () => {
    const { instance } = provider();
    let fired = 0;
    instance.onDidChangeMcpServerDefinitions(() => fired++);

    instance.refresh();
    assert.equal(fired, 1);
});

test("no server is offered when covdbg is too old or missing", () => {
    assert.deepEqual(provider(OK, TOO_OLD).instance.provideMcpServerDefinitions(), []);
    assert.deepEqual(provider(OK, { kind: "missing" }).instance.provideMcpServerDefinitions(), []);
});

test("a covdbg found too old only when starting is not started", async () => {
    const { instance, resolved } = provider(TOO_OLD);
    const [server] = instance.provideMcpServerDefinitions();

    assert.equal(await instance.resolveMcpServerDefinition(server), undefined);
    assert.equal(resolved[0].workspaceRoot, ROOT);
});

test("no server is offered in an untrusted window or without a folder", () => {
    vscodeStub.workspace.isTrusted = false;
    assert.deepEqual(provider().instance.provideMcpServerDefinitions(), []);

    vscodeStub.workspace.isTrusted = true;
    vscodeStub.workspace.workspaceFolders = undefined;
    assert.deepEqual(provider().instance.provideMcpServerDefinitions(), []);
});

test("no server is offered or started outside Windows", async () => {
    const { instance, resolved } = provider();
    const [server] = instance.provideMcpServerDefinitions();

    Object.defineProperty(process, "platform", { value: "linux" });
    assert.deepEqual(instance.provideMcpServerDefinitions(), []);
    assert.equal(await instance.resolveMcpServerDefinition(server), undefined);
    assert.equal(resolved.length, 0);
});

test("a definition without a folder, or one the window stopped trusting, is not started", async () => {
    const { instance, resolved } = provider();
    const [server] = instance.provideMcpServerDefinitions();

    vscodeStub.workspace.isTrusted = false;
    assert.equal(await instance.resolveMcpServerDefinition(server), undefined);

    vscodeStub.workspace.isTrusted = true;
    server.args = ["mcp"];
    assert.equal(await instance.resolveMcpServerDefinition(server), undefined);
    assert.equal(resolved.length, 0);
});

test("a disposed provider tells the editor nothing more", () => {
    const { instance } = provider();
    let fired = 0;
    instance.onDidChangeMcpServerDefinitions(() => fired++);

    instance.dispose();
    instance.refresh();
    assert.equal(fired, 0);
});
