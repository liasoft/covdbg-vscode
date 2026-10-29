import * as assert from "assert";
import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * This file is inside the extension's folder, so `vscode` here is the same API object the
 * extension uses: whatever the spies replace is what the extension calls. They go in before the
 * extension is activated, so nothing it shows at startup is missed.
 */
export interface Spies {
    /** Every notification or modal: [severity, message, ...items]. */
    messages: string[][];
    /** The latest value set for each context key. */
    contexts: Map<string, unknown>;
    /** Every URL handed to openExternal (the browser is never opened). */
    opened: string[];
    /** What to answer a message with, by message text; unmatched messages are dismissed. */
    answers: Array<{ match: RegExp; item: string }>;
    tree?: vscode.TreeDataProvider<unknown>;
    mcp?: vscode.McpServerDefinitionProvider;
    /** How many times the covdbg output channel was brought to the front. */
    outputShown: number;
    /** Every line the extension wrote to its output channel. */
    log: string[];
    /** The covdbg status-bar item as the user sees it: undefined text while hidden. */
    statusBar: { text?: string; tooltip?: string; visible: boolean };
}

export const EXTENSION_ID = "covdbg.covdbg";

export function installSpies(): Spies {
    const spies: Spies = {
        messages: [],
        contexts: new Map(),
        opened: [],
        answers: [],
        outputShown: 0,
        log: [],
        statusBar: { visible: false },
    };
    const win = vscode.window as unknown as Record<string, unknown>;
    for (const [name, severity] of [
        ["showInformationMessage", "info"],
        ["showWarningMessage", "warning"],
        ["showErrorMessage", "error"],
    ] as const) {
        win[name] = async (message: string, ...rest: unknown[]) => {
            const items = rest.filter((item): item is string => typeof item === "string");
            spies.messages.push([severity, message, ...items]);
            return spies.answers.find((answer) => answer.match.test(message))?.item;
        };
    }
    const createTreeView = vscode.window.createTreeView;
    win.createTreeView = (id: string, options: vscode.TreeViewOptions<unknown>) => {
        if (id === "covdbg.homeView") {
            spies.tree = options.treeDataProvider;
        }
        return createTreeView(id, options);
    };
    const createOutputChannel = vscode.window.createOutputChannel;
    win.createOutputChannel = (...args: unknown[]) => {
        const channel = (createOutputChannel as (...a: unknown[]) => vscode.OutputChannel)(...args);
        // The API hands out frozen objects, so the channel is wrapped rather than patched.
        return new Proxy(channel, {
            get(target, property) {
                if (property === "appendLine") {
                    return (line: string) => {
                        spies.log.push(line);
                        target.appendLine(line);
                    };
                }
                if (property === "show") {
                    return (...showArgs: unknown[]) => {
                        spies.outputShown++;
                        (target.show as (...a: unknown[]) => void)(...showArgs);
                    };
                }
                const value = Reflect.get(target, property) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    };
    const createStatusBarItem = vscode.window.createStatusBarItem;
    win.createStatusBarItem = (...args: unknown[]) => {
        const item = (createStatusBarItem as (...a: unknown[]) => vscode.StatusBarItem)(...args);
        return new Proxy(item, {
            set(target, property, value) {
                if (property === "text" || property === "tooltip") {
                    spies.statusBar[property] = String(value);
                }
                return Reflect.set(target, property, value);
            },
            get(target, property) {
                if (property === "show" || property === "hide") {
                    return () => {
                        spies.statusBar.visible = property === "show";
                        target[property]();
                    };
                }
                const value = Reflect.get(target, property) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    };
    const lm = vscode.lm as unknown as Record<string, unknown>;
    const registerMcp = vscode.lm.registerMcpServerDefinitionProvider;
    lm.registerMcpServerDefinitionProvider = (
        id: string,
        provider: vscode.McpServerDefinitionProvider,
    ) => {
        spies.mcp = provider;
        return registerMcp(id, provider);
    };
    (vscode.env as unknown as Record<string, unknown>).openExternal = async (uri: vscode.Uri) => {
        spies.opened.push(uri.toString(true));
        return true;
    };
    const executeCommand = vscode.commands.executeCommand;
    (vscode.commands as unknown as Record<string, unknown>).executeCommand = (
        command: string,
        ...args: unknown[]
    ) => {
        if (command === "setContext") {
            spies.contexts.set(String(args[0]), args[1]);
        }
        return executeCommand(command, ...args);
    };
    return spies;
}

/**
 * Swaps the scenario's folder (COVDBG_E2E_FOLDER) in for the empty one the window opened on, the
 * way opening it would activate the extension, and waits for the activation.
 */
export async function openScenarioFolder(): Promise<string> {
    const folder = process.env.COVDBG_E2E_FOLDER;
    assert.ok(folder, "COVDBG_E2E_FOLDER is set");
    vscode.workspace.updateWorkspaceFolders(0, 1, { uri: vscode.Uri.file(folder) });
    await waitFor(
        "the extension to activate",
        () => vscode.extensions.getExtension(EXTENSION_ID)?.isActive,
    );
    return folder;
}

/**
 * PowerShell that sets $h to this test's VS Code window, with user32 calls in [W]. It is DPI
 * aware, so sizes are screen pixels and a scaled display does not crop the screenshot.
 */
const findWindow = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool paint);
  public struct R { public int L, T, Ri, B; }
}
'@
[W]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id ${process.ppid}
while ($p -and $p.MainWindowHandle -eq 0) { $p = $p.Parent }
$h = $p.MainWindowHandle`;

/**
 * A PNG of this test's VS Code window, rendered even when another window covers it, saved to
 * %TEMP%\covdbg-e2e\shots\<name>.png for a person to look at.
 */
export function screenshot(name: string): string {
    const file = path.join(process.env.COVDBG_E2E_SHOTS ?? "", `${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const script = `
Add-Type -AssemblyName System.Drawing
${findWindow}
$r = New-Object W+R; [W]::GetWindowRect($h, [ref]$r) | Out-Null
$b = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($b)
[W]::PrintWindow($h, $g.GetHdc(), 2) | Out-Null
$g.ReleaseHdc(); $b.Save('${file}'); $g.Dispose(); $b.Dispose()`;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script]);
    return file;
}

/**
 * Restores this test's VS Code window and sizes it in unscaled pixels, so screenshots show the
 * same layout whatever the display scaling; the PNG is that size times the scaling.
 */
export function resizeWindow(width: number, height: number): void {
    const script = `
${findWindow}
$s = [W]::GetDpiForWindow($h) / 96
[W]::ShowWindow($h, 9) | Out-Null
[W]::MoveWindow($h, 40, 40, [int](${width} * $s), [int](${height} * $s), $true) | Out-Null`;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script]);
}

/**
 * Talks to an MCP server over stdio the way a chat client would: newline-delimited JSON-RPC.
 */
export async function mcpSession(
    server: vscode.McpStdioServerDefinition,
): Promise<{ request: (method: string, params?: unknown) => Promise<any>; close: () => void }> {
    const child = spawn(server.command, server.args, {
        cwd: server.cwd?.fsPath,
        env: { ...process.env, ...(server.env as NodeJS.ProcessEnv) },
        windowsHide: true,
    });
    const pending = new Map<number, (message: any) => void>();
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let newline;
        while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (!line) {
                continue;
            }
            const message = JSON.parse(line);
            pending.get(message.id)?.(message);
        }
    });
    let nextId = 1;
    const request = (method: string, params?: unknown) =>
        new Promise<any>((resolve, reject) => {
            const id = nextId++;
            const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 120_000);
            pending.set(id, (message) => {
                clearTimeout(timer);
                if (message.error) {
                    reject(new Error(`MCP ${method}: ${JSON.stringify(message.error)}`));
                } else {
                    resolve(message.result);
                }
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "covdbg-e2e", version: "0" },
    });
    child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    return { request, close: () => child.kill() };
}

/** A tool's answer: covdbg's tools reply with one Markdown text block. */
export function toolText(result: any): string {
    const text: string = result.content?.find((block: any) => block.type === "text")?.text ?? "";
    assert.ok(!result.isError, `tool failed: ${text}`);
    return text;
}

/**
 * The session id a covdbg tool answer names: `run` answers in JSON ({"sessionId": …}), the
 * coverage tools in Markdown ("Session id: `covdb-b02b00a9`").
 */
export function sessionId(text: string): string {
    let id = /session[ _]id:?\s*`([^`]+)`/i.exec(text)?.[1];
    try {
        id ??= (JSON.parse(text) as { sessionId?: string }).sessionId;
    } catch {
        // Markdown, not JSON.
    }
    assert.ok(id, `no session id in: ${text.slice(0, 300)}`);
    return id;
}

/** The Coverage view as text, one line per item, indented by depth. */
export async function treeText(spies: Spies): Promise<string> {
    const provider = spies.tree;
    if (!provider) {
        return "<no tree>";
    }
    const lines: string[] = [];
    const walk = async (parent: unknown, depth: number): Promise<void> => {
        for (const element of (await provider.getChildren(parent as never)) ?? []) {
            const item = await provider.getTreeItem(element as never);
            const label = typeof item.label === "string" ? item.label : (item.label?.label ?? "");
            const description =
                typeof item.description === "string" ? ` — ${item.description}` : "";
            lines.push(`${"  ".repeat(depth)}${label}${description}`);
            if (item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded) {
                await walk(element, depth + 1);
            }
        }
    };
    await walk(undefined, 0);
    return lines.join("\n");
}

export async function waitFor<T>(
    what: string,
    probe: () => T | undefined | false | Promise<T | undefined | false>,
    timeoutMs = 60_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

/** Runs the named steps in order, printing each; the first failure fails the scenario. */
export async function steps(list: Array<[string, () => Promise<void>]>): Promise<void> {
    for (const [name, step] of list) {
        const started = Date.now();
        try {
            await step();
            console.log(`  ✔ ${name} (${Date.now() - started} ms)`);
        } catch (error) {
            console.log(`  ✖ ${name}`);
            throw error;
        }
    }
}

export { assert };
