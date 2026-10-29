import Module from "module";
import * as fs from "fs";
import * as path from "path";

type Listener<T> = (value: T) => unknown;

class EventEmitter<T> {
    private listeners: Listener<T>[] = [];
    readonly event = (listener: Listener<T>) => {
        this.listeners.push(listener);
        return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
    };
    fire(value: T): void {
        this.listeners.forEach((listener) => listener(value));
    }
    dispose(): void {
        this.listeners = [];
    }
}

class Disposable {
    constructor(private readonly onDispose: () => void) {}
    dispose(): void {
        this.onDispose();
    }
}

/** A file URI's text is its path, so tests can compare it with the path they gave. */
class Uri {
    private constructor(
        readonly scheme: string,
        readonly fsPath: string,
        private readonly text: string,
    ) {}
    static file(fsPath: string): Uri {
        return new Uri("file", fsPath, fsPath);
    }
    static parse(value: string): Uri {
        return new Uri(/^([a-z][\w+.-]*):/i.exec(value)?.[1] ?? "file", value, value);
    }
    toString(): string {
        return this.text;
    }
}

interface StubFolder {
    uri: { fsPath: string };
    name?: string;
    index?: number;
}

class RelativePattern {
    readonly baseUri: { fsPath: string };
    constructor(
        base: string | StubFolder,
        readonly pattern: string,
    ) {
        this.baseUri = typeof base === "string" ? Uri.file(base) : base.uri;
    }
}

class Position {
    constructor(
        readonly line: number,
        readonly character: number,
    ) {}
}

class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
        this.start = typeof a === "number" ? new Position(a, b as number) : a;
        this.end = typeof a === "number" ? new Position(c ?? 0, d ?? 0) : (b as Position);
    }
}

class Selection extends Range {}

class ThemeColor {
    constructor(readonly id: string) {}
}

class ThemeIcon {
    constructor(readonly id: string) {}
}

class TreeItem {
    description?: string;
    tooltip?: string;
    iconPath?: unknown;
    contextValue?: string;
    command?: unknown;
    resourceUri?: unknown;
    id?: string;
    constructor(
        readonly label: string,
        readonly collapsibleState: number,
    ) {}
}

class McpStdioServerDefinition {
    cwd: unknown;
    version: string | undefined;
    constructor(
        public label: string,
        public command: string,
        public args: string[] = [],
        public env: Record<string, string> = {},
    ) {}
}

class TestMessage {
    contextValue?: string;
    constructor(readonly message: string) {}
}

class TestRunRequest {
    constructor(
        readonly include?: TestItem[],
        readonly exclude?: TestItem[],
    ) {}
}

class CancellationTokenSource {
    private readonly cancelled = new EventEmitter<void>();
    disposed = false;
    readonly token = {
        isCancellationRequested: false,
        onCancellationRequested: this.cancelled.event,
    };
    cancel(): void {
        this.token.isCancellationRequested = true;
        this.cancelled.fire();
    }
    dispose(): void {
        this.disposed = true;
    }
}

/** The children of a test item, or the controller's top-level items. */
class TestItemCollection {
    private readonly items = new Map<string, TestItem>();
    get size(): number {
        return this.items.size;
    }
    replace(items: readonly TestItem[]): void {
        this.items.clear();
        items.forEach((item) => this.items.set(item.id, item));
    }
    add(item: TestItem): void {
        this.items.set(item.id, item);
    }
    get(id: string): TestItem | undefined {
        return this.items.get(id);
    }
    forEach(callback: (item: TestItem) => void): void {
        this.items.forEach((item) => callback(item));
    }
}

class TestItem {
    description?: string;
    canResolveChildren = false;
    readonly children = new TestItemCollection();
    constructor(
        readonly id: string,
        readonly label: string,
    ) {}
}

/** One test run, as the list of what happened to its items: `passed app.exe`, `output ...`. */
class TestRun {
    readonly events: string[] = [];
    readonly messages: string[] = [];
    ended = false;
    constructor(readonly request: TestRunRequest) {}
    appendOutput(text: string): void {
        this.events.push(`output ${text.trimEnd()}`);
    }
    started(item: TestItem): void {
        this.events.push(`started ${item.label}`);
    }
    skipped(item: TestItem): void {
        this.events.push(`skipped ${item.label}`);
    }
    passed(item: TestItem): void {
        this.events.push(`passed ${item.label}`);
    }
    failed(item: TestItem, message: TestMessage): void {
        this.events.push(`failed ${item.label}`);
        this.messages.push(message.message);
    }
    errored(item: TestItem, message: TestMessage): void {
        this.events.push(`errored ${item.label}`);
        this.messages.push(message.message);
    }
    end(): void {
        this.ended = true;
    }
}

class TestController {
    readonly items = new TestItemCollection();
    readonly runs: TestRun[] = [];
    readonly profiles: {
        label: string;
        handler: (request: TestRunRequest, token: unknown) => Promise<void>;
    }[] = [];
    resolveHandler?: (item: TestItem | undefined) => Promise<void>;
    refreshHandler?: () => Promise<void>;
    disposed = false;
    constructor(
        readonly id: string,
        readonly label: string,
    ) {}
    createTestItem(id: string, label: string): TestItem {
        return new TestItem(id, label);
    }
    createRunProfile(
        label: string,
        _kind: number,
        handler: (request: TestRunRequest, token: unknown) => Promise<void>,
    ): void {
        this.profiles.push({ label, handler });
    }
    createTestRun(request: TestRunRequest): TestRun {
        const run = new TestRun(request);
        this.runs.push(run);
        return run;
    }
    dispose(): void {
        this.disposed = true;
    }
}

class FileSystemWatcher {
    readonly created = new EventEmitter<Uri>();
    readonly changed = new EventEmitter<Uri>();
    readonly deleted = new EventEmitter<Uri>();
    readonly onDidCreate = this.created.event;
    readonly onDidChange = this.changed.event;
    readonly onDidDelete = this.deleted.event;
    disposed = false;
    constructor(readonly pattern: string | RelativePattern) {}
    dispose(): void {
        this.disposed = true;
    }
}

class TextDocument {
    readonly lines: string[];
    isDirty = false;
    constructor(
        readonly uri: Uri,
        text: string,
    ) {
        this.lines = text.split(/\r?\n/);
    }
    get fileName(): string {
        return this.uri.fsPath;
    }
    get lineCount(): number {
        return this.lines.length;
    }
    lineAt(index: number): { text: string } {
        return { text: this.lines[index] };
    }
}

class TextEditor {
    /** The ranges last set for each decoration type, by the type's key. */
    readonly decorations = new Map<string, { range: Range; hoverMessage?: string }[]>();
    selection: Selection | undefined;
    revealed: Range | undefined;
    constructor(readonly document: TextDocument) {}
    setDecorations(type: { key: string }, ranges: { range: Range; hoverMessage?: string }[]): void {
        this.decorations.set(type.key, ranges);
    }
    revealRange(range: Range): void {
        this.revealed = range;
    }
}

class WebviewPanel {
    readonly received = new EventEmitter<unknown>();
    readonly disposedEmitter = new EventEmitter<void>();
    readonly webview = { html: "", onDidReceiveMessage: this.received.event };
    readonly onDidDispose = this.disposedEmitter.event;
    revealed = 0;
    constructor(
        readonly viewType: string,
        readonly title: string,
    ) {}
    reveal(): void {
        this.revealed++;
    }
    dispose(): void {
        this.disposedEmitter.fire();
    }
}

class StatusBarItem {
    name = "";
    text = "";
    tooltip = "";
    command = "";
    visible = false;
    disposed = false;
    show(): void {
        this.visible = true;
    }
    hide(): void {
        this.visible = false;
    }
    dispose(): void {
        this.disposed = true;
    }
}

function isUnder(filePath: string, root: string): boolean {
    const relative = path.relative(root, filePath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function folderFor(filePath: string): StubFolder | undefined {
    return vscodeStub.workspace.workspaceFolders?.find((folder) =>
        isUnder(path.normalize(filePath), path.normalize(folder.uri.fsPath)),
    );
}

/**
 * Node's globbing never matches a name that starts with a dot, and VS Code's does; such names are
 * spelled without the dot, in the glob and in the path alike, before they are compared.
 */
const undot = (text: string) => text.replace(/(^|[/{,])\./g, "$1_dot_");

/** Lists files under `base` that match the glob and not the exclude glob, as VS Code's search does. */
async function findFiles(
    include: string | RelativePattern,
    exclude?: string,
    maxResults?: number,
): Promise<Uri[]> {
    const bases =
        typeof include === "string"
            ? (vscodeStub.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
            : [include.baseUri.fsPath];
    const pattern = undot(typeof include === "string" ? include : include.pattern);
    const found: Uri[] = [];
    for (const base of bases) {
        for (const entry of fs.readdirSync(base, { recursive: true, withFileTypes: true })) {
            if (!entry.isFile()) {
                continue;
            }
            const filePath = path.join(entry.parentPath, entry.name);
            const relative = undot(path.relative(base, filePath).split(path.sep).join("/"));
            if (
                path.matchesGlob(relative, pattern) &&
                !(exclude && path.matchesGlob(relative, undot(exclude)))
            ) {
                found.push(Uri.file(filePath));
            }
        }
    }
    return found.sort((a, b) => a.fsPath.localeCompare(b.fsPath)).slice(0, maxResults);
}

type ShowMessage = (message: string, ...rest: unknown[]) => Promise<string | undefined>;

/** Records a toast and answers it with what `window.answer` chooses. */
function toast(kind: "info" | "warning" | "error"): ShowMessage {
    return async (message, ...rest) => {
        vscodeStub.window.toasts.push(message);
        const items = rest.filter((item): item is string => typeof item === "string");
        const answer = vscodeStub.window.answer?.(message, items);
        return answer ?? (kind === "warning" ? vscodeStub.window.warningAnswer : undefined);
    };
}

/**
 * Just enough of the vscode API for the extension to run under node:test: it records what the
 * extension shows and lets the test answer quick picks, dialogs and toasts. Import this before the
 * module under test: `vscode` exists only inside the editor, not under node:test.
 */
export const vscodeStub = {
    EventEmitter,
    Disposable,
    McpStdioServerDefinition,
    Uri,
    RelativePattern,
    Position,
    Range,
    Selection,
    ThemeColor,
    ThemeIcon,
    TreeItem,
    TestMessage,
    TestRunRequest,
    CancellationTokenSource,
    ViewColumn: { One: 1, Two: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Left: 1 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    TextEditorRevealType: { InCenter: 2 },
    TestRunProfileKind: { Run: 1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    workspace: {
        isTrusted: true,
        workspaceFolders: undefined as StubFolder[] | undefined,
        getWorkspaceFolder: (uri: { fsPath: string }) => folderFor(uri.fsPath),
        /** The `covdbg.*` settings, by key without the prefix. */
        settings: {} as Record<string, unknown>,
        /** What `inspect` reports for a setting, by key without the prefix. */
        inspected: {} as Record<string, Record<string, unknown>>,
        /** Every settings write, as `key=value@target`. */
        updates: [] as string[],
        getConfiguration: () => ({
            get: <T>(key: string, fallback: T): T =>
                (vscodeStub.workspace.settings[key] as T | undefined) ?? fallback,
            inspect: (key: string) => vscodeStub.workspace.inspected[key],
            update: async (key: string, value: unknown, target: number) => {
                vscodeStub.workspace.updates.push(`${key}=${value}@${target}`);
                vscodeStub.workspace.settings[key] = value;
            },
        }),
        findFiles,
        asRelativePath: (pathOrUri: string | { fsPath: string }) => {
            const filePath = typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
            const folder = folderFor(filePath);
            return folder
                ? path.relative(folder.uri.fsPath, filePath).split(path.sep).join("/")
                : filePath;
        },
        /** Every watcher created, in order. */
        watchers: [] as FileSystemWatcher[],
        createFileSystemWatcher: (pattern: string | RelativePattern) => {
            const watcher = new FileSystemWatcher(pattern);
            vscodeStub.workspace.watchers.push(watcher);
            return watcher;
        },
        textDocuments: [] as TextDocument[],
        openTextDocument: async (pathOrUri: string | { fsPath: string }) => {
            const filePath = typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
            return new TextDocument(
                Uri.file(filePath),
                await fs.promises.readFile(filePath, "utf8"),
            );
        },
        configurationChanged: new EventEmitter<{ affectsConfiguration(key: string): boolean }>(),
        trustGranted: new EventEmitter<void>(),
        foldersChanged: new EventEmitter<void>(),
        documentChanged: new EventEmitter<{
            document: TextDocument;
            contentChanges: unknown[];
        }>(),
        get onDidChangeConfiguration() {
            return vscodeStub.workspace.configurationChanged.event;
        },
        get onDidGrantWorkspaceTrust() {
            return vscodeStub.workspace.trustGranted.event;
        },
        get onDidChangeWorkspaceFolders() {
            return vscodeStub.workspace.foldersChanged.event;
        },
        get onDidChangeTextDocument() {
            return vscodeStub.workspace.documentChanged.event;
        },
    },
    env: {
        remoteName: undefined as string | undefined,
        /** Every URL opened, as text. */
        opened: [] as string[],
        openExternal: async (uri: { toString(): string }) => {
            vscodeStub.env.opened.push(uri.toString());
            return true;
        },
        clipboard: {
            text: "",
            writeText: async (text: string) => {
                vscodeStub.env.clipboard.text = text;
            },
        },
    },
    commands: {
        /** The last value set for each context key. */
        context: new Map<string, unknown>(),
        registered: new Map<string, (...args: unknown[]) => unknown>(),
        /** Commands run that the extension does not register, as `id arg...`. */
        executed: [] as string[],
        registerCommand: (id: string, callback: (...args: unknown[]) => unknown) => {
            vscodeStub.commands.registered.set(id, callback);
            return new Disposable(() => vscodeStub.commands.registered.delete(id));
        },
        executeCommand: async (command: string, ...args: unknown[]) => {
            if (command === "setContext") {
                vscodeStub.commands.context.set(args[0] as string, args[1]);
                return undefined;
            }
            const registered = vscodeStub.commands.registered.get(command);
            if (registered) {
                return registered(...args);
            }
            vscodeStub.commands.executed.push([command, ...args.map(String)].join(" "));
            return undefined;
        },
    },
    window: {
        activeTextEditor: undefined as TextEditor | undefined,
        visibleTextEditors: [] as TextEditor[],
        activeEditorChanged: new EventEmitter<TextEditor | undefined>(),
        get onDidChangeActiveTextEditor() {
            return vscodeStub.window.activeEditorChanged.event;
        },
        /** Every line written to the output channel. */
        log: [] as string[],
        createOutputChannel: () => ({
            appendLine: (line: string) => vscodeStub.window.log.push(line),
            show: () => vscodeStub.window.log.push("<shown>"),
            dispose: () => undefined,
        }),
        /** Every toast shown, as its message. */
        toasts: [] as string[],
        /** What the next showWarningMessage call answers, as the chosen item. */
        warningAnswer: undefined as string | undefined,
        /** Chooses the answer to any toast; falls back to `warningAnswer` for warnings. */
        answer: undefined as ((message: string, items: string[]) => string | undefined) | undefined,
        showInformationMessage: toast("info"),
        showWarningMessage: toast("warning"),
        showErrorMessage: toast("error"),
        /** Chooses from a quick pick; unset, every quick pick is dismissed. */
        pick: undefined as
            ((items: { label: string }[], options: Record<string, unknown>) => unknown) | undefined,
        /** The labels of every quick pick shown. */
        quickPicks: [] as string[][],
        showQuickPick: async (items: { label: string }[], options: Record<string, unknown>) => {
            vscodeStub.window.quickPicks.push(items.map((item) => item.label));
            return vscodeStub.window.pick?.(items, options);
        },
        /** The files an open dialog answers with; unset, it is cancelled. */
        openDialogAnswer: undefined as string[] | undefined,
        showOpenDialog: async () => vscodeStub.window.openDialogAnswer?.map((p) => Uri.file(p)),
        /** Every document shown in an editor, by path. */
        shown: [] as string[],
        /** The editors those documents were shown in, in order. */
        editors: [] as TextEditor[],
        showTextDocument: async (document: TextDocument) => {
            vscodeStub.window.shown.push(document.uri.fsPath);
            const editor = new TextEditor(document);
            vscodeStub.window.editors.push(editor);
            return editor;
        },
        /** Every decoration type created, in order. */
        decorationTypes: [] as {
            key: string;
            options: Record<string, unknown>;
            disposed: boolean;
        }[],
        createTextEditorDecorationType: (options: Record<string, unknown>) => {
            const type = {
                key: `decoration${++decorationCount}`,
                options,
                disposed: false,
                dispose: () => (type.disposed = true),
            };
            vscodeStub.window.decorationTypes.push(type);
            return type;
        },
        statusBarItems: [] as StatusBarItem[],
        createStatusBarItem: () => {
            const item = new StatusBarItem();
            vscodeStub.window.statusBarItems.push(item);
            return item;
        },
        panels: [] as WebviewPanel[],
        createWebviewPanel: (viewType: string, title: string) => {
            const panel = new WebviewPanel(viewType, title);
            vscodeStub.window.panels.push(panel);
            return panel;
        },
        treeViews: new Map<string, StubTreeView>(),
        createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
            const visibility = new EventEmitter<{ visible: boolean }>();
            const view: StubTreeView = {
                ...options,
                badge: undefined,
                visible: false,
                onDidChangeVisibility: visibility.event,
                /** Shows or hides the view, as the user does. */
                setVisible: (visible: boolean) => {
                    view.visible = visible;
                    visibility.fire({ visible });
                },
                dispose: () => undefined,
            };
            vscodeStub.window.treeViews.set(id, view);
            return view;
        },
    },
    tests: {
        controllers: [] as TestController[],
        createTestController: (id: string, label: string) => {
            const controller = new TestController(id, label);
            vscodeStub.tests.controllers.push(controller);
            return controller;
        },
    },
    lm: {
        mcpProviders: new Map<string, unknown>(),
        registerMcpServerDefinitionProvider: (id: string, provider: unknown) => {
            vscodeStub.lm.mcpProviders.set(id, provider);
            return new Disposable(() => vscodeStub.lm.mcpProviders.delete(id));
        },
    },
};

let decorationCount = 0;

interface StubTreeView {
    treeDataProvider: unknown;
    badge: unknown;
    visible: boolean;
    onDidChangeVisibility: EventEmitter<{ visible: boolean }>["event"];
    setVisible(visible: boolean): void;
    dispose(): void;
}

/** A workspace folder at `fsPath`, named after its last segment. */
export function stubFolder(fsPath: string, index = 0): StubFolder {
    return { uri: Uri.file(fsPath), name: path.basename(fsPath), index };
}

/** An editor showing the file at `fsPath`, with `text` as its content. */
export function stubEditor(fsPath: string, text = ""): TextEditor {
    return new TextEditor(new TextDocument(Uri.file(fsPath), text));
}

export type {
    FileSystemWatcher as StubWatcher,
    StatusBarItem as StubStatusBarItem,
    TestController as StubTestController,
    TestItem as StubTestItem,
    TestRun as StubTestRun,
    TextEditor as StubEditor,
    WebviewPanel as StubPanel,
};

const moduleLoader = Module as unknown as {
    _load: (request: string, ...rest: unknown[]) => unknown;
};
const load = moduleLoader._load;
moduleLoader._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === "vscode" ? vscodeStub : load.call(this, request, ...rest);
};
