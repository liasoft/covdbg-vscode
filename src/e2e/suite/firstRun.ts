import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    assert,
    installSpies,
    mcpSession,
    openScenarioFolder,
    screenshot,
    steps,
    sessionId,
    toolText,
    treeText,
    waitFor,
} from "./harness";

/**
 * A C++ project opened for the first time on a machine already signed in to covdbg, with the real
 * covdbg: quiet start, ▶ offers the starter config once, the run lands coverage in the view, and
 * the second ▶ just runs.
 */
export async function run(): Promise<void> {
    const spies = installSpies();
    let folder = "";

    const findCovdbs = (): string[] =>
        fs
            .readdirSync(folder, { recursive: true, encoding: "utf8" })
            .filter((file) => file.endsWith(".covdb"))
            .map((file) => path.join(folder, file));

    await steps([
        [
            "opening a C++ folder activates the extension",
            async () => {
                folder = await openScenarioFolder();
            },
        ],
        [
            "it reuses the machine's sign-in and finds the test executable",
            async () => {
                await waitFor(
                    "the signed-in state",
                    () => spies.contexts.get("covdbg.auth") === "signedIn",
                );
                const tree = await waitFor("the ready row", async () => {
                    const text = await treeText(spies);
                    return /test_app\.exe/.test(text) && text;
                });
                console.log(indent(tree));
            },
        ],
        [
            "startup shows no notification and does not open the Output panel",
            async () => {
                await new Promise((resolve) => setTimeout(resolve, 3_000));
                assert.deepStrictEqual(spies.messages, []);
                assert.strictEqual(spies.outputShown, 0);
            },
        ],
        [
            "covdbg's MCP server is offered for the folder",
            async () => {
                assert.ok(spies.mcp, "MCP provider registered");
                const definitions =
                    (await spies.mcp.provideMcpServerDefinitions(
                        new vscode.CancellationTokenSource().token,
                    )) ?? [];
                assert.strictEqual(definitions.length, 1);
                const server = definitions[0] as vscode.McpStdioServerDefinition;
                console.log(`    ${server.command} ${server.args.join(" ")}`);
                assert.match(server.command, /covdbg(\.exe)?$/i);
                assert.deepStrictEqual(server.args.slice(0, 2), ["mcp", "--workspace"]);
                assert.strictEqual(
                    path.resolve(server.args[2]).toLowerCase(),
                    path.resolve(folder).toLowerCase(),
                );
            },
        ],
        [
            "▶ offers the starter .covdbg.yaml once, creates it, and runs",
            async () => {
                spies.answers.push({ match: /needs a \.covdbg\.yaml/, item: "Create and run" });
                await vscode.commands.executeCommand("covdbg.runCoverage");
                assert.deepStrictEqual(
                    spies.messages.map((message) => message[1]),
                    ["covdbg needs a .covdbg.yaml."],
                );
                assert.ok(fs.existsSync(path.join(folder, ".covdbg.yaml")), ".covdbg.yaml written");
                assert.ok(findCovdbs().length > 0, "a .covdb was written");
            },
        ],
        [
            "coverage shows in the view, counting only the project's sources",
            async () => {
                const tree = await waitFor("the coverage summary", async () => {
                    const text = await treeText(spies);
                    return /\d+(\.\d+)?%/.test(text) && text;
                }).catch(async (error) => {
                    console.log(indent(await treeText(spies)));
                    console.log(indent(findCovdbs().join("\n")));
                    console.log(indent(spies.log.join("\n")));
                    throw error;
                });
                console.log(indent(tree));
                assert.match(tree, /main\.cpp/);
                assert.doesNotMatch(tree, /vcruntime|crt|stl|Windows Kits/i);
                // How the program exited is in the log, not a notice in the view
                assert.doesNotMatch(tree, /exited with/);
            },
        ],
        [
            "the status bar shows the coverage; the gutter is highlighted (screenshot)",
            async () => {
                await waitFor("the coverage in the status bar", () => spies.statusBar.visible);
                assert.strictEqual(spies.statusBar.text, "$(beaker) 100.0%");
                const main = await vscode.workspace.openTextDocument(
                    path.join(folder, "src", "main.cpp"),
                );
                await vscode.window.showTextDocument(main);
                await vscode.commands.executeCommand("covdbg.homeView.focus");
                await new Promise((resolve) => setTimeout(resolve, 2_000));
                console.log(`    screenshot: ${screenshot("first-run-coverage")}`);
            },
        ],
        [
            "an agent's run through covdbg's MCP server lands in the editor",
            async () => {
                const definitions =
                    (await spies.mcp?.provideMcpServerDefinitions(
                        new vscode.CancellationTokenSource().token,
                    )) ?? [];
                const server = definitions[0] as vscode.McpStdioServerDefinition;
                const covdbgOutput = server.env.COVDBG_OUTPUT;
                assert.ok(covdbgOutput, "COVDBG_OUTPUT points the server's runs at the editor");
                const mcp = await mcpSession(server);
                try {
                    const { tools } = await mcp.request("tools/list");
                    assert.strictEqual(tools.length, 11);
                    const call = async (name: string, args: unknown) =>
                        toolText(await mcp.request("tools/call", { name, arguments: args }));

                    const loadsBefore = spies.log.filter((line) =>
                        /Loading index/.test(line),
                    ).length;
                    const started = await call("run", {
                        target: path.join(folder, "build", "Debug", "test_app.exe"),
                        config_path: path.join(folder, ".covdbg.yaml"),
                    });
                    const finished = await call("wait_run", {
                        session_id: sessionId(started),
                        timeout_seconds: 60,
                    });
                    console.log(indent(finished.trim().split("\n").slice(0, 6).join("\n")));
                    assert.ok(fs.existsSync(String(covdbgOutput)), "the run wrote COVDBG_OUTPUT");

                    const opened = await call("open_coverage", { path: covdbgOutput });
                    const session = sessionId(opened);
                    // `files` ranks only files with uncovered lines; quick-start has none.
                    const rows = await call("query", {
                        session_id: session,
                        sql: "SELECT relative_path FROM files",
                    });
                    assert.match(rows, /main\.cpp/);
                    await call("close", { session_id: session });

                    await waitFor(
                        "the editor to reload the agent's coverage",
                        () =>
                            spies.log.filter((line) => /Loading index/.test(line)).length >
                            loadsBefore,
                    );
                } finally {
                    mcp.close();
                }
            },
        ],
        [
            "the second ▶ runs the remembered target with no questions",
            async () => {
                const before = spies.messages.length;
                const covdb = findCovdbs()[0];
                const firstWrite = fs.statSync(covdb).mtimeMs;
                await vscode.commands.executeCommand("covdbg.runCoverage");
                assert.strictEqual(spies.messages.length, before, "no new messages");
                assert.ok(fs.statSync(covdb).mtimeMs > firstWrite, "the .covdb was rewritten");
                assert.strictEqual(spies.outputShown, 0, "the Output panel stayed closed");
            },
        ],
    ]);
}

function indent(text: string): string {
    return text
        .split("\n")
        .map((line) => `    | ${line}`)
        .join("\n");
}
