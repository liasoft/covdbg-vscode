import { vscodeStub, stubFolder } from "./vscodeStub";
import * as path from "path";
import { activate, deactivate } from "../extension";
import { FakeProcess, answerWhoami, stubSpawn } from "./fakeCovdbg";
import { CovdbContent, provideSqlWasm, tempFolder, writeCovdb, writeFile } from "./fixtures";
import type { SignedInAccount } from "../runner/signIn";

/** How the stand-in covdbg answers a run: by default it writes `coverage` and succeeds. */
export type RunScript = (process: FakeProcess, outputPath: string) => void;

export interface ExtensionUnderTest {
    root: string;
    /** Every covdbg process started, in order. */
    started: FakeProcess[];
    /** Who `whoami` says is signed in; unset, nobody. */
    account: SignedInAccount | undefined;
    /** What a run writes to its output, unless `onRun` says otherwise. */
    coverage: CovdbContent;
    onRun: RunScript;
    /** How `covdbg login` goes; by default it waits until it is cancelled. */
    onLogin: (process: FakeProcess) => void;
    workspaceState: Map<string, unknown>;
    /** Runs one of the extension's commands, as the palette does. */
    command(id: string, ...args: unknown[]): Promise<unknown>;
    /** The covdbg runs started so far, by their target. */
    runs(): string[];
    dispose(): void;
}

/** The workspace folder under `root`: its own .git with an origin, so no repository hint shows. */
export function prepareFolder(root: string): void {
    writeFile(path.join(root, ".git", "config"), '[remote "origin"]\n\turl = x\n');
}

/**
 * Activates the extension on a fresh workspace folder (or `folders` under one temp folder), with
 * covdbg.executablePath pointing at a stand-in that answers `--version`, `whoami`, `merge` and runs.
 * Call it once per test file: the extension keeps its state in the module, as it does in VS Code.
 */
export async function startExtension(
    options: {
        folders?: string[];
        files?: (root: string) => Promise<void> | void;
        settings?: Record<string, unknown>;
        account?: SignedInAccount;
    } = {},
): Promise<ExtensionUnderTest> {
    provideSqlWasm();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });

    const root = tempFolder();
    const folderPaths = (options.folders ?? ["."]).map((folder) => path.join(root, folder));
    folderPaths.forEach(prepareFolder);
    writeFile(path.join(root, "covdbg.exe"));
    await options.files?.(root);

    vscodeStub.workspace.workspaceFolders = folderPaths.map((folder, index) =>
        stubFolder(folder, index),
    );
    vscodeStub.workspace.settings = {
        executablePath: path.join(root, "covdbg.exe"),
        ...options.settings,
    };

    const workspaceState = new Map<string, unknown>();
    const context = {
        subscriptions: [] as { dispose(): unknown }[],
        workspaceState: {
            get: (key: string) => workspaceState.get(key),
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    workspaceState.delete(key);
                } else {
                    workspaceState.set(key, value);
                }
            },
            keys: () => [...workspaceState.keys()],
        },
        extensionUri: { fsPath: root },
        globalStorageUri: { fsPath: path.join(root, "globalStorage") },
    };

    const covdbg = stubSpawn((process) => {
        const [first] = process.args;
        if (first === "--version") {
            process.print("covdbg 1.5.1\n");
            process.exit(0);
        } else if (first === "whoami") {
            answerWhoami(process, extension.account);
        } else if (first === "login") {
            extension.onLogin(process);
        } else if (first === "merge") {
            const outputPath = process.args[process.args.indexOf("--output") + 1];
            void writeCovdb(outputPath, extension.coverage).then(() => process.exit(0));
        } else {
            extension.onRun(process, process.args[process.args.indexOf("--output") + 1]);
        }
    });
    const extension: ExtensionUnderTest = {
        root,
        started: covdbg.started,
        account: options.account,
        coverage: {},
        onRun: (process, outputPath) => {
            void writeCovdb(outputPath, extension.coverage).then(() => process.exit(0));
        },
        onLogin: () => undefined,
        workspaceState,
        command: (id, ...args) => vscodeStub.commands.executeCommand(id, ...args),
        runs: () =>
            extension.started
                .filter(
                    (process) => process.args.includes("--output") && process.args[0] !== "merge",
                )
                .map((process) => path.basename(process.args[process.args.length - 1])),
        dispose: () => {
            context.subscriptions.forEach((subscription) => subscription.dispose());
            deactivate();
            // The stand-in stays: work still in flight may start covdbg after the last test.
            Object.defineProperty(process, "platform", platform);
        },
    };

    activate(context as never);
    return extension;
}

/** Waits until `condition` holds, for the extension's background work to land. */
export async function waitFor(condition: () => unknown, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** The status bar item the extension shows. */
export function statusBarText(): string {
    const item = vscodeStub.window.statusBarItems[0];
    return item.visible ? item.text : "";
}

/** The Testing view's discovered executables, by label. */
export function testItems(): string[] {
    const labels: string[] = [];
    vscodeStub.tests.controllers[0].items.forEach((root) =>
        root.children.forEach((item) => labels.push(item.label)),
    );
    return labels;
}
