import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    assert,
    installSpies,
    openScenarioFolder,
    resizeWindow,
    screenshot,
    steps,
    treeText,
    waitFor,
} from "./harness";

/**
 * The screenshots for the documentation page on covdbg.com: quick-start in the light theme, in a
 * 1024 × 640 window. The sign-in goes through the covdbg stand-in, so the shots show its example
 * account; every run is the real covdbg's. Asserts little: firstRun and signIn cover behaviour.
 */
export async function run(): Promise<void> {
    const spies = installSpies();
    let testing: vscode.TestController | undefined;
    const createTestController = vscode.tests.createTestController;
    (vscode.tests as unknown as Record<string, unknown>).createTestController = (
        ...args: Parameters<typeof createTestController>
    ) => (testing = createTestController(...args));
    const state = process.env.FAKE_COVDBG_STATE ?? "";
    assert.ok(state, "FAKE_COVDBG_STATE is set");
    let folder = "";

    const settle = (ms = 2_000) => new Promise((resolve) => setTimeout(resolve, ms));
    const covdbWrites = (): number[] =>
        fs
            .readdirSync(folder, { recursive: true, encoding: "utf8" })
            .filter((file) => file.endsWith(".covdb"))
            .map((file) => fs.statSync(path.join(folder, file)).mtimeMs);

    await steps([
        [
            "signed out, the Coverage view offers sign-in (screenshot)",
            async () => {
                resizeWindow(1024, 640);
                folder = await openScenarioFolder();
                await waitFor(
                    "the signed-out welcome",
                    () => spies.contexts.get("covdbg.welcome") === "signedOut",
                );
                // Swapping the folder in shows a status-bar message no user sees; it lasts 10 s.
                await settle(10_000);
                await vscode.commands.executeCommand("covdbg.homeView.focus");
                await settle();
                console.log(`    screenshot: ${screenshot("vscode-sign-in")}`);
            },
        ],
        [
            "signed in, the view is ready to run (screenshot)",
            async () => {
                void vscode.commands.executeCommand("covdbg.signIn");
                await waitFor(
                    "signing in",
                    () => spies.contexts.get("covdbg.auth") === "signingIn",
                );
                fs.writeFileSync(path.join(state, "confirm"), "");
                await waitFor("the ready row", async () =>
                    /test_app\.exe/.test(await treeText(spies)),
                );
                await settle();
                console.log(`    screenshot: ${screenshot("vscode-ready")}`);
            },
        ],
        [
            "▶ creates the starter config and runs",
            async () => {
                spies.answers.push({ match: /needs a \.covdbg\.yaml/, item: "Create and run" });
                await vscode.commands.executeCommand("covdbg.runCoverage");
                await waitFor("the coverage summary", async () =>
                    /\d+(\.\d+)?%/.test(await treeText(spies)),
                );
            },
        ],
        [
            "coverage in the editor, the view and the status bar (screenshot)",
            async () => {
                await vscode.commands.executeCommand("covdbg.setRenderMode", "both");
                const main = await vscode.workspace.openTextDocument(
                    path.join(folder, "src", "main.cpp"),
                );
                await vscode.window.showTextDocument(main);
                await vscode.commands.executeCommand("covdbg.homeView.focus");
                await settle();
                console.log(`    screenshot: ${screenshot("vscode-editor-coverage")}`);
            },
        ],
        [
            "the menu (screenshot)",
            async () => {
                void vscode.commands.executeCommand("covdbg.showMenu");
                await settle(1_500);
                console.log(`    screenshot: ${screenshot("vscode-menu")}`);
                await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
            },
        ],
        [
            "the coverage report (screenshot)",
            async () => {
                await vscode.commands.executeCommand("workbench.action.closeAllEditors");
                await vscode.commands.executeCommand("covdbg.showReport");
                await vscode.commands.executeCommand("workbench.action.joinAllGroups");
                await settle(3_000);
                console.log(`    screenshot: ${screenshot("vscode-report")}`);
                await vscode.commands.executeCommand("workbench.action.closeAllEditors");
            },
        ],
        [
            "a run from the Testing view (screenshot)",
            async () => {
                const before = Math.max(...covdbWrites());
                await vscode.window.showTextDocument(
                    vscode.Uri.file(path.join(folder, "src", "main.cpp")),
                );
                await vscode.commands.executeCommand("workbench.view.testing.focus");
                await settle();
                await vscode.commands.executeCommand("testing.runAll");
                await waitFor(
                    "the Testing run to write a .covdb",
                    () => Math.max(...covdbWrites()) > before,
                );
                const root = testing?.items.get("covdbg.root");
                const item = root && [...root.children].map(([, child]) => child)[0];
                assert.ok(item, "the Testing view lists the test executable");
                await vscode.commands.executeCommand("vscode.revealTestInExplorer", item);
                await vscode.commands.executeCommand("workbench.action.closePanel");
                await settle(3_000);
                console.log(`    screenshot: ${screenshot("vscode-testing")}`);
            },
        ],
    ]);
}
