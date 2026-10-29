import { vscodeStub, type StubTestItem } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { ExtensionUnderTest, startExtension, testItems, waitFor } from "./extensionHarness";
import { writeFile } from "./fixtures";

let ext: ExtensionUnderTest;
let source: string;

const exe = (name: string) => path.join(ext.root, "build", "Debug", name);

function controller() {
    return vscodeStub.tests.controllers[0];
}

function lastRun() {
    const { runs } = controller();
    return runs[runs.length - 1];
}

/** The discovered test item for an executable. */
function item(name: string): StubTestItem {
    let found: StubTestItem | undefined;
    controller().items.forEach((root) =>
        root.children.forEach((child) => {
            if (child.label === name) {
                found = child;
            }
        }),
    );
    return found!;
}

/** Runs the Testing view's "Run with Coverage" profile, as the ▶ beside an item does. */
async function runProfile(
    include?: StubTestItem[],
    exclude?: StubTestItem[],
    token = new vscodeStub.CancellationTokenSource().token,
) {
    await controller().profiles[0].handler(new vscodeStub.TestRunRequest(include, exclude), token);
    return lastRun();
}

test.before(async () => {
    ext = await startExtension({
        account: { email: "dev@example.com" },
        files: (root) => {
            source = writeFile(path.join(root, "src", "lib.cpp"), "int f() { return 1; }\n");
            writeFile(path.join(root, "build", "Debug", "alpha_test.exe"));
            writeFile(path.join(root, "build", "Debug", "beta_test.exe"));
        },
    });
    ext.coverage = { lines: { [source]: { 1: 1 } } };
    await waitFor(() => testItems().length === 2, "discovery");
});

test.after(() => ext.dispose());

test("the Testing view lists the discovered executables", async () => {
    assert.deepEqual(testItems(), ["alpha_test.exe", "beta_test.exe"]);
    let root: StubTestItem | undefined;
    controller().items.forEach((item) => (root = item));
    assert.equal(root!.description, "2 discovered tests");

    await controller().resolveHandler!(undefined);
    await controller().refreshHandler!();
    assert.deepEqual(testItems(), ["alpha_test.exe", "beta_test.exe"]);
});

test("without a .covdbg.yaml a run asks first, and declined it is skipped", async () => {
    let asked = "";
    vscodeStub.window.answer = (message) => {
        asked = message;
        return undefined;
    };
    const run = await runProfile([item("alpha_test.exe")]);
    assert.equal(asked, "covdbg needs a .covdbg.yaml.");
    assert.deepEqual(run.events, ["output covdbg needs a .covdbg.yaml.", "skipped alpha_test.exe"]);
    assert.equal(fs.existsSync(path.join(ext.root, ".covdbg.yaml")), false);
});

test("accepted, the starter is written to the folder and the run goes on", async () => {
    vscodeStub.window.answer = (_message, items) => items[0];
    const run = await runProfile([item("alpha_test.exe")]);
    vscodeStub.window.answer = undefined;
    assert.deepEqual(run.events, ["started alpha_test.exe", "passed alpha_test.exe"]);
    assert.match(fs.readFileSync(path.join(ext.root, ".covdbg.yaml"), "utf8"), /^version: 1/m);
    assert.ok(vscodeStub.window.shown.includes(path.join(ext.root, ".covdbg.yaml")));
});

test("a whole-tree run measures every executable but the excluded ones, one after another", async () => {
    const run = await runProfile(undefined, [item("beta_test.exe")]);
    assert.deepEqual(run.events, ["started alpha_test.exe", "passed alpha_test.exe"]);
});

test("a batch writes one .covdb per executable, then merges them into the configured one", async () => {
    const before = ext.started.length;
    const run = await runProfile();
    assert.deepEqual(run.events, [
        "started alpha_test.exe",
        "passed alpha_test.exe",
        "started beta_test.exe",
        "passed beta_test.exe",
    ]);
    const covdbgDir = path.join(ext.root, ".covdbg");
    const [merge] = ext.started.slice(before).filter((process) => process.args[0] === "merge");
    assert.deepEqual(merge.args, [
        "merge",
        "--input",
        path.join(covdbgDir, "alpha_test.covdb"),
        "--input",
        path.join(covdbgDir, "beta_test.covdb"),
        "--output",
        path.join(covdbgDir, "coverage.covdb"),
    ]);
    await waitFor(() => vscodeStub.commands.context.get("covdbg.hasCoverage") === true, "load");

    await ext.command("covdbg.clearLastRunResult");
    assert.deepEqual(fs.readdirSync(covdbgDir), []);
});

test("a batch in which only one run worked copies its .covdb to the configured one", async () => {
    ext.onRun = (process, outputPath) => {
        if (outputPath.includes("beta")) {
            process.exit(1);
            return;
        }
        fs.writeFileSync(outputPath, fs.readFileSync(path.join(ext.root, "covdbg.exe")));
        process.exit(0);
    };
    const before = ext.started.length;
    const run = await runProfile();
    assert.deepEqual(run.events, [
        "started alpha_test.exe",
        "passed alpha_test.exe",
        "started beta_test.exe",
        "failed beta_test.exe",
    ]);
    assert.equal(
        ext.started.slice(before).some((process) => process.args[0] === "merge"),
        false,
    );
    assert.ok(fs.existsSync(path.join(ext.root, ".covdbg", "coverage.covdb")));
});

test("▶ with several executables and none chosen yet asks which, and remembers them", async () => {
    vscodeStub.window.pick = (items) => [items.find((item) => item.label === "beta_test.exe")];
    ext.onRun = (process) => process.exit(0);
    await ext.command("covdbg.runCoverage");
    assert.deepEqual(ext.workspaceState.get("covdbg.lastTargets"), [exe("beta_test.exe")]);
    assert.deepEqual(lastRun().events, ["started beta_test.exe", "passed beta_test.exe"]);

    vscodeStub.window.pick = undefined;
    const picks = vscodeStub.window.quickPicks.length;
    await ext.command("covdbg.runCoverage");
    assert.equal(vscodeStub.window.quickPicks.length, picks);
    assert.deepEqual(lastRun().events, ["started beta_test.exe", "passed beta_test.exe"]);
});

test("Choose Executable… ticks the current choice; Browse… adds one discovery missed", async () => {
    const elsewhere = writeFile(path.join(ext.root, "tools", "manual.exe"));
    let ticked: string[] = [];
    vscodeStub.window.pick = (items) => {
        ticked = (items as { label: string; picked?: boolean }[])
            .filter((item) => item.picked)
            .map((item) => item.label);
        return items.filter((item) => item.label.includes("Browse"));
    };
    vscodeStub.window.openDialogAnswer = [elsewhere];
    assert.deepEqual(await ext.command("covdbg.chooseExecutable"), [elsewhere]);
    assert.deepEqual(ticked, ["beta_test.exe"]);
    assert.deepEqual(testItems(), ["alpha_test.exe", "beta_test.exe", "manual.exe"]);

    vscodeStub.window.openDialogAnswer = undefined;
    vscodeStub.window.pick = () => undefined;
    assert.equal(await ext.command("covdbg.chooseExecutable"), undefined);
    vscodeStub.window.pick = (items) => items.filter((item) => item.label.includes("Browse"));
    assert.equal(await ext.command("covdbg.chooseExecutable"), undefined);
    assert.deepEqual(ext.workspaceState.get("covdbg.lastTargets"), [elsewhere]);

    vscodeStub.window.pick = () => [];
    assert.equal(await ext.command("covdbg.chooseExecutable"), undefined);
    assert.equal(ext.workspaceState.has("covdbg.lastTargets"), false);
    assert.deepEqual(testItems(), ["alpha_test.exe", "beta_test.exe"]);
    vscodeStub.window.pick = undefined;
});

test("▶ does nothing when the choice is dismissed", async () => {
    const runs = controller().runs.length;
    await ext.command("covdbg.runCoverage");
    assert.equal(controller().runs.length, runs);
});

test("a request without executables runs nothing, and a cancelled batch skips the rest", async () => {
    const stray = { id: "stray", label: "stray", children: { forEach: () => undefined } };
    let run = await runProfile([stray as unknown as StubTestItem]);
    assert.deepEqual(run.events, []);

    const source = new vscodeStub.CancellationTokenSource();
    ext.onRun = (process) => {
        source.cancel();
        process.exit(0);
    };
    run = await runProfile(undefined, undefined, source.token);
    assert.deepEqual(run.events, [
        "started alpha_test.exe",
        "passed alpha_test.exe",
        "skipped beta_test.exe",
    ]);
});

test("signed out, a run signs in first; a cancelled sign-in skips it", async () => {
    ext.account = undefined;
    await ext.command("covdbg.refresh");
    await waitFor(() => vscodeStub.commands.context.get("covdbg.auth") === "signedOut", "whoami");

    const source = new vscodeStub.CancellationTokenSource();
    ext.onLogin = () => source.cancel();
    const run = await runProfile([item("alpha_test.exe")], undefined, source.token);
    assert.deepEqual(run.events, [
        "output Sign in to covdbg to measure coverage.",
        "skipped alpha_test.exe",
    ]);
});

test("a run refused for want of a sign-in offers to sign in and runs again", async () => {
    ext.account = { email: "dev@example.com" };
    await ext.command("covdbg.refresh");
    let refusals = 0;
    ext.onRun = (process) => {
        if (refusals++ === 0) {
            process.stderr.emit(
                "data",
                Buffer.from("covdbg: This run is not licensed: Run covdbg login first.\n"),
            );
            process.exit(3);
        } else {
            process.exit(0);
        }
    };
    ext.onLogin = (process) => {
        process.print("Signed in as dev@example.com for Acme.\n");
        process.exit(0);
    };
    vscodeStub.window.answer = (_message, items) => items[0];
    const runs = controller().runs.length;
    await runProfile([item("alpha_test.exe")]);
    await waitFor(() => controller().runs.length === runs + 2, "the second run");
    await waitFor(() => lastRun().ended, "the second run to end");
    assert.deepEqual(lastRun().events, ["started alpha_test.exe", "passed alpha_test.exe"]);
    vscodeStub.window.answer = undefined;
});

test("in an untrusted workspace ▶ says why nothing runs", async () => {
    vscodeStub.workspace.isTrusted = false;
    vscodeStub.window.toasts = [];
    await ext.command("covdbg.refresh");
    ext.workspaceState.set("covdbg.lastTargets", [exe("alpha_test.exe")]);
    await ext.command("covdbg.runCoverage");
    assert.deepEqual(lastRun().events, [
        "output covdbg runs executables only in a trusted workspace.",
        "skipped alpha_test.exe",
    ]);
    assert.deepEqual(vscodeStub.window.toasts, [
        "covdbg: covdbg runs executables only in a trusted workspace.",
    ]);

    vscodeStub.workspace.isTrusted = true;
    vscodeStub.workspace.trustGranted.fire();
    await waitFor(() => vscodeStub.commands.context.get("covdbg.auth") === "signedIn", "trust");
});
