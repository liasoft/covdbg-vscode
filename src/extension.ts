import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { realpathSync } from "fs";
import { CoverageDecorator } from "./coverage/coverageDecorator";
import { RenderMode } from "./types";
import { CovdbParser, CovdbFileSummary, type FileCoverage } from "./coverage/covdbParser";
import { CoverageWorkspaceSession } from "./coverage/coverageSession";
import { buildCoverageSummaryFromFileIndex } from "./coverage/coverageSummary";
import { CovdbReloadScheduler } from "./coverage/covdbReloadScheduler";
import { reportLoadProblem } from "./coverage/loadProblem";
import { findBestCoverageKey } from "./coverage/coverageKeyMatcher";
import { StatusBar } from "./views/statusBar";
import { CoverageReport } from "./views/coverageReport";
import * as output from "./views/outputChannel";
import {
    showMenu as showMenuPopup,
    showDatabaseSwitcher,
    showFileBrowser as showFileBrowserPopup,
    MenuContext,
    MenuActions,
} from "./views/menuPopup";
import { CoverageTree, FolderCoverage } from "./views/coverageTree";
import {
    RunProblem,
    RunResult,
    mergeCoverageFiles,
    runCoverageForTarget,
} from "./runner/runnerService";
import { AuthService } from "./auth/authService";
import { resolveCovdbgRuntime } from "./runner/executableResolver";
import { APP_URL, NoticeAction, PROFILE_URL, RunNotice, pickBatchToast } from "./runner/runOutcome";
import {
    listDiscoveredExecutablePaths,
    resolveEffectiveConfigPath,
} from "./runner/workspaceDefaults";
import { buildStarterConfig } from "./runner/starterConfig";
import { needsRepositoryHint } from "./runner/repositoryHint";
import {
    COVDBG_MCP_PROVIDER_ID,
    CovdbgMcpServerDefinitionProvider,
} from "./mcp/serverDefinitionProvider";
import {
    getPreferredWorkspaceFolder,
    resolvePathFromWorkspace,
    readRunnerSettings,
    resolveRunnerPaths,
} from "./runner/settings";
import { dedupeNormalizedPaths, deriveCoverageBatchOutputPath } from "./runner/outputPaths";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let decorator: CoverageDecorator;
let statusBar: StatusBar;
let report: CoverageReport;
let coverageTree: CoverageTree;
let auth: AuthService;
/** Where each folder's last chosen targets are kept. */
let workspaceState: vscode.Memento;

/** Guard to prevent overlapping loadIndex calls. */
let isLoadingIndex = false;
/** Guard to prevent overlapping queued covdb reload flushes. */
let isFlushingPendingCovdbReloads = false;
/** Testing API controller for discovered binaries. */
let testingController: vscode.TestController | undefined;
/** Root item shown in the Testing view. */
let testingRootItem: vscode.TestItem | undefined;
/** Executable path lookup for file-less test items. */
const testExecutablePaths: Map<string, string> = new Map();
/** Set once the first discovery has ended, so the Coverage view does not say none were found. */
let testDiscoveryDone = false;
/** The preferred folder has no git remote and no commit, as of the last discovery. */
let repositoryHint = false;
const covdbReloadScheduler = new CovdbReloadScheduler();
const covdbWatchers = new Map<string, { covdbPath: string; watcher: vscode.FileSystemWatcher }>();
/**
 * Watchers over the discovery glob, one per workspace folder.
 *
 * Separate from covdbWatchers, which watch the one already-active path and so do not exist at all
 * until something has been loaded. Without these, a .covdb created for the first time - by an MCP
 * run, or by covdbg on the command line - goes unnoticed until the window is reloaded, because
 * discoverAndLoadIndex runs only at activation, on three configuration changes, and on a
 * workspace-folder change.
 */
const covdbDiscoveryWatchers = new Map<string, vscode.FileSystemWatcher>();
/** Debounce timer for a discovery hit, so one run's write does not queue several loads. */
let discoveryReloadTimer: NodeJS.Timeout | undefined;
/** Debounce timer for a watched .covdb being rewritten underneath us. */
let covdbReloadDebounceTimer: NodeJS.Timeout | undefined;
let lastDiscoveredTestBinaryIds: string | undefined;
/** Track last run output for clear command. */
let lastRunOutputPaths: string[] = [];

const CONFIG_FILE_NAME = ".covdbg.yaml";
/** The workspaceState key holding the targets ▶ runs. */
const LAST_TARGETS_KEY = "covdbg.lastTargets";
/** How long the writes to a new .covdb must stop before it is read. */
const DISCOVERY_RELOAD_DEBOUNCE_MS = 750;
const CONFIG_FILE_GLOB = `**/${CONFIG_FILE_NAME}`;
const DISCOVERY_EXCLUDE_GLOB = "**/{.git,node_modules,.vscode,assets}/**";
const MAX_DISCOVERED_COVDB_FILES = 50;

class CoverageWorkspaceState {
    /** Why the last .covdb load showed nothing, for the view. */
    loadProblem: string | undefined;

    constructor(
        public workspaceFolder: vscode.WorkspaceFolder | undefined,
        public readonly session: CoverageWorkspaceSession,
    ) {}

    get activeCovdbPath(): string | undefined {
        return this.session.activeCovdbPath;
    }

    get activeCovdbMtime(): number {
        return this.session.activeCovdbMtime;
    }

    get fileIndex(): Map<string, CovdbFileSummary> {
        return this.session.fileIndex;
    }
}

const coverageStates = new Map<string, CoverageWorkspaceState>();

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
    output.log("covdbg extension activated");

    workspaceState = context.workspaceState;
    decorator = new CoverageDecorator();
    statusBar = new StatusBar();
    report = new CoverageReport();
    auth = new AuthService({
        // Sign-in needs covdbg, not a workspace folder: with none open, relative settings resolve
        // against the process directory and are unlikely to matter.
        resolveRuntime: () => {
            const folder = getPreferredWorkspaceFolder();
            return resolveCovdbgRuntime(
                context,
                readRunnerSettings(folder?.uri),
                folder?.uri.fsPath ?? process.cwd(),
            );
        },
        readSettingsEnv: () => readRunnerSettings(getPreferredWorkspaceFolder()?.uri).env,
    });
    // Every change to trust, folders, covdbg or covdbg.runner.env refreshes auth, which is when
    // the server definition may have changed too.
    const mcpProvider = new CovdbgMcpServerDefinitionProvider({
        resolveRuntime: (settings, workspaceRoot) =>
            resolveCovdbgRuntime(context, settings, workspaceRoot),
        runtimeProblem: () => (auth.state.kind === "unavailable" ? auth.state.runtime : undefined),
    });
    coverageTree = new CoverageTree(auth, {
        getCoverage: getFolderCoverage,
        getTargets: () => {
            if (!testDiscoveryDone) {
                return undefined;
            }
            const remembered = getRememberedTargets();
            const targets = remembered.length > 0 ? remembered : [...testExecutablePaths.values()];
            return targets.map((p) => vscode.workspace.asRelativePath(p));
        },
        needsRepositoryHint: () => repositoryHint,
    });

    // Restore persisted render mode (workspace state takes priority, then setting)
    const savedMode = context.workspaceState.get<RenderMode>("covdbg.renderMode");
    const configMode = vscode.workspace
        .getConfiguration("covdbg")
        .get<RenderMode>("renderMode", "gutter");
    const initialMode = savedMode ?? configMode;
    decorator.setRenderMode(initialMode);
    statusBar.setRenderMode(initialMode);

    context.subscriptions.push(
        auth,
        auth.onDidChange(() => statusBar.setAuth(auth.state, auth.lastRunNotice, auth.runtime)),
        mcpProvider,
        auth.onDidChange(() => mcpProvider.refresh()),
        coverageTree,
        vscode.commands.registerCommand("covdbg.signIn", () => auth.signIn()),
        vscode.commands.registerCommand("covdbg.signOut", () => auth.signOut()),
        vscode.commands.registerCommand("covdbg.cancelSignIn", () => auth.cancelSignIn()),
        vscode.commands.registerCommand("covdbg.copySignInCode", () => auth.copySignInCode()),
        vscode.commands.registerCommand("covdbg.openSignInPage", () => auth.openSignInPage()),
        vscode.commands.registerCommand("covdbg.refresh", () =>
            Promise.all([auth.refresh(), refreshTestControllerItems(), discoverAndLoadIndex()]),
        ),
        vscode.commands.registerCommand("covdbg.showMenu", () => showMenu(context)),
        vscode.commands.registerCommand("covdbg.toggleCoverage", () => toggleVisibility()),
        vscode.commands.registerCommand("covdbg.showReport", showCoverageReportCommand),
        vscode.commands.registerCommand("covdbg.browseFiles", () => showFileBrowser()),
        vscode.commands.registerCommand("covdbg.setRenderMode", (mode: string) =>
            applyRenderMode(mode as RenderMode, context),
        ),
        vscode.commands.registerCommand("covdbg.configurePath", () => loadCovdbCommand(context)),
        vscode.commands.registerCommand("covdbg.createConfig", () => createConfigCommand()),
        vscode.commands.registerCommand("covdbg.openConfig", () => openConfigCommand()),
        vscode.commands.registerCommand("covdbg.openLog", () => openLogCommand()),
        vscode.commands.registerCommand("covdbg.openSettings", () =>
            vscode.commands.executeCommand("workbench.action.openSettings", "covdbg"),
        ),
        vscode.commands.registerCommand("covdbg.runCoverage", () => runCoverageCommand(context)),
        vscode.commands.registerCommand("covdbg.chooseExecutable", () => chooseExecutable()),
        vscode.commands.registerCommand("covdbg.clearLastRunResult", () =>
            clearLastRunResultCommand(),
        ),
        vscode.commands.registerCommand("covdbg.showOutput", () => output.show()),
        vscode.lm.registerMcpServerDefinitionProvider(COVDBG_MCP_PROVIDER_ID, mcpProvider),
    );

    // Decorate when switching editors
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                void decorateEditor(editor);
            }
            updateActiveWorkspaceUi();
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.contentChanges.length === 0) {
                return;
            }
            invalidateCoverageForDocument(event.document);
        }),
    );

    // Reload index when settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (
                e.affectsConfiguration("covdbg.covdbPath") ||
                e.affectsConfiguration("covdbg.showExternalFiles") ||
                e.affectsConfiguration("covdbg.discoveryPattern")
            ) {
                ensureCovdbDiscoveryWatchers();
                await discoverAndLoadIndex();
            }
            if (e.affectsConfiguration("covdbg.renderMode")) {
                const mode = vscode.workspace
                    .getConfiguration("covdbg")
                    .get<RenderMode>("renderMode", "gutter");
                decorator.setRenderMode(mode);
                statusBar.setRenderMode(mode);
                context.workspaceState.update("covdbg.renderMode", mode);
                refreshAllEditors();
            }
            if (
                e.affectsConfiguration("covdbg.runner.binaryDiscoveryPattern") ||
                e.affectsConfiguration("covdbg.runner.binaryDiscoveryExcludePattern")
            ) {
                await refreshTestControllerItems();
            }
            if (
                e.affectsConfiguration("covdbg.executablePath") ||
                e.affectsConfiguration("covdbg.portableCachePath") ||
                e.affectsConfiguration("covdbg.runner.env")
            ) {
                void auth.refresh();
            }
        }),
        vscode.workspace.onDidGrantWorkspaceTrust(() => void auth.refresh()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void auth.refresh();
            void refreshTestControllerItems();
            ensureCovdbDiscoveryWatchers();
            void discoverAndLoadIndex();
        }),
    );

    const configWatcher = vscode.workspace.createFileSystemWatcher(CONFIG_FILE_GLOB);
    context.subscriptions.push(
        configWatcher,
        configWatcher.onDidDelete((uri) => {
            void clearDeletedRunnerConfigPath(uri);
        }),
    );

    context.subscriptions.push({
        dispose: () => disposeAllCovdbWatchers(),
    });

    initializeTestingController(context);
    statusBar.setIdle();
    void auth.refresh();
    ensureCovdbDiscoveryWatchers();
    void discoverAndLoadIndex();
}

export function deactivate(): void {
    disposeAllCovdbWatchers();
    testingController?.dispose();
    decorator?.dispose();
    statusBar?.dispose();
    report?.dispose();
    output.dispose();
}

// ---------------------------------------------------------------------------
// Discovery & index loading
// ---------------------------------------------------------------------------

async function discoverAndLoadIndex(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
        const explicitCandidate = await getExplicitCovdbCandidate();
        if (explicitCandidate) {
            await loadIndex(explicitCandidate, "settings");
        } else {
            const newest = await getMostRecentFile(await findDiscoveredCovdbFiles());
            if (newest) {
                await loadIndex(newest.fsPath, "auto-discovered");
            }
        }
    } else {
        for (const folder of workspaceFolders) {
            const explicitCandidate = await getExplicitCovdbCandidate(folder);
            if (explicitCandidate) {
                await loadIndex(explicitCandidate, "settings", folder);
                continue;
            }

            const discoveredFiles = await findDiscoveredCovdbFiles(folder);
            const newest = await getMostRecentFile(discoveredFiles);
            if (newest) {
                await loadIndex(newest.fsPath, "auto-discovered", folder);
            } else {
                clearCoverageState(folder, false);
            }
        }
    }
    // Folders that have left the window take their coverage with them, the last one too.
    pruneCoverageStates(workspaceFolders ?? []);

    updateActiveWorkspaceUi();
    coverageTree.refresh();
    void flushPendingCovdbReloads();
}

async function loadIndex(
    covdbPath: string,
    source: "settings" | "auto-discovered" = "settings",
    workspaceFolder?: vscode.WorkspaceFolder,
    userInitiated = false,
): Promise<void> {
    if (isLoadingIndex) {
        return;
    }
    isLoadingIndex = true;
    try {
        const mtime = await getMtime(covdbPath);
        output.log(`Loading index from: ${covdbPath} (${source})`);

        const targetWorkspaceFolder = workspaceFolder ?? getWorkspaceFolderForPath(covdbPath);
        const state = getOrCreateCoverageState(targetWorkspaceFolder);
        const showExternal = vscode.workspace
            .getConfiguration("covdbg", targetWorkspaceFolder?.uri)
            .get<boolean>("showExternalFiles", false);
        const result = await state.session.loadIndex(covdbPath, {
            mtime,
            filterFileIndex: showExternal
                ? undefined
                : (fileIndex) => filterToWorkspaceFiles(fileIndex, targetWorkspaceFolder),
        });
        state.loadProblem = reportLoadProblem(result, userInitiated, {
            log: output.logError,
            toast: (message) => void vscode.window.showWarningMessage(message),
        });
        // A .covdb that failed to parse leaves the last good one on screen; say which that is.
        if (result.error && state.activeCovdbPath) {
            state.loadProblem += ` (still showing the last good load of ${path.basename(state.activeCovdbPath)})`;
        }
        if (state.loadProblem) {
            coverageTree.refresh();
            return;
        }

        ensureCovdbWatcher(state);

        const excluded = result.totalFileCount - result.loadedFileCount;
        const excludedMsg = excluded > 0 ? ` (${excluded} external files hidden)` : "";
        output.log(`Indexed ${result.loadedFileCount} files${excludedMsg} (mtime ${mtime})`);

        refreshAllEditors();
        updateActiveWorkspaceUi();
        coverageTree.refresh();
        void flushPendingCovdbReloads();
    } finally {
        isLoadingIndex = false;
        if (!covdbReloadScheduler.hasActiveExecution()) {
            void flushPendingCovdbReloads();
        }
    }
}

// ---------------------------------------------------------------------------
// Event-driven .covdb watching — defer reloads until workflows are idle
// ---------------------------------------------------------------------------

function ensureCovdbWatcher(state: CoverageWorkspaceState): void {
    const stateKey = getWorkspaceStateKey(state.workspaceFolder);
    const covdbPath = state.activeCovdbPath;
    const existing = covdbWatchers.get(stateKey);

    if (!covdbPath) {
        disposeCovdbWatcher(stateKey);
        return;
    }

    if (existing && normalizePathKey(existing.covdbPath) === normalizePathKey(covdbPath)) {
        return;
    }

    disposeCovdbWatcher(stateKey);

    const filePattern = new vscode.RelativePattern(
        path.dirname(covdbPath),
        path.basename(covdbPath),
    );
    const watcher = vscode.workspace.createFileSystemWatcher(filePattern);
    const queueReload = (uri: vscode.Uri) => {
        queueCovdbReload(stateKey, uri.fsPath);
    };

    watcher.onDidCreate(queueReload);
    watcher.onDidChange(queueReload);
    watcher.onDidDelete((uri) => {
        output.log(`covdbg file watcher noticed deletion: ${uri.fsPath}`);
    });

    covdbWatchers.set(stateKey, { covdbPath, watcher });
}

/**
 * Watch each workspace folder's discovery glob so a .covdb that has never been loaded is noticed.
 *
 * Cheap to keep open, and idempotent: an existing watcher for a folder is left in place.
 */
function ensureCovdbDiscoveryWatchers(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];

    for (const stateKey of [...covdbDiscoveryWatchers.keys()]) {
        if (!folders.some((folder) => getWorkspaceStateKey(folder) === stateKey)) {
            covdbDiscoveryWatchers.get(stateKey)?.dispose();
            covdbDiscoveryWatchers.delete(stateKey);
        }
    }

    for (const folder of folders) {
        const stateKey = getWorkspaceStateKey(folder);
        if (covdbDiscoveryWatchers.has(stateKey)) {
            continue;
        }

        const pattern = vscode.workspace
            .getConfiguration("covdbg", folder.uri)
            .get<string>("discoveryPattern", "**/*.covdb");
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, pattern),
        );

        const onDiscovered = (uri: vscode.Uri) => {
            queueDiscoveryReload(uri, folder);
        };
        watcher.onDidCreate(onDiscovered);
        watcher.onDidChange(onDiscovered);

        covdbDiscoveryWatchers.set(stateKey, watcher);
    }
}

/**
 * React to a .covdb appearing where nothing was loaded before.
 *
 * Debounced, and deliberately so twice over: covdbg writes the file in pieces, so create is
 * followed by a run of change events, and reading a half-written SQLite file yields either a
 * malformed database or an empty index. Waiting for the writes to stop is the cheap guard the
 * mtime comparison in flushPendingCovdbReloads cannot give, since an mtime says when a file was
 * last touched and nothing about whether it is complete.
 *
 * A folder that already has this path active is left to its own watcher, which has the mtime
 * check and the run-in-progress deferral that this path does not.
 */
function queueDiscoveryReload(uri: vscode.Uri, folder: vscode.WorkspaceFolder): void {
    const state = coverageStates.get(getWorkspaceStateKey(folder));
    if (state?.activeCovdbPath) {
        return;
    }

    if (discoveryReloadTimer) {
        clearTimeout(discoveryReloadTimer);
    }

    discoveryReloadTimer = setTimeout(() => {
        discoveryReloadTimer = undefined;
        if (covdbReloadScheduler.hasActiveExecution() || isLoadingIndex) {
            return;
        }

        output.log(`covdbg noticed a new coverage database: ${uri.fsPath}`);
        void discoverAndLoadIndex();
    }, DISCOVERY_RELOAD_DEBOUNCE_MS);
}

function disposeCovdbDiscoveryWatchers(): void {
    if (discoveryReloadTimer) {
        clearTimeout(discoveryReloadTimer);
        discoveryReloadTimer = undefined;
    }

    if (covdbReloadDebounceTimer) {
        clearTimeout(covdbReloadDebounceTimer);
        covdbReloadDebounceTimer = undefined;
    }

    for (const watcher of covdbDiscoveryWatchers.values()) {
        watcher.dispose();
    }
    covdbDiscoveryWatchers.clear();
}

function disposeCovdbWatcher(stateKey: string): void {
    const existing = covdbWatchers.get(stateKey);
    if (!existing) {
        return;
    }

    existing.watcher.dispose();
    covdbWatchers.delete(stateKey);
}

function disposeAllCovdbWatchers(): void {
    for (const stateKey of covdbWatchers.keys()) {
        disposeCovdbWatcher(stateKey);
    }
    disposeCovdbDiscoveryWatchers();
}

function queueCovdbReload(stateKey: string, covdbPath: string): void {
    covdbReloadScheduler.queueReload(stateKey, covdbPath);
    if (covdbReloadScheduler.hasActiveExecution()) {
        output.log(`Queued .covdb reload until current coverage workflow completes: ${covdbPath}`);
        return;
    }

    // Debounced rather than flushed straight away. withDeferredCovdbReloads only covers runs this
    // extension started, so a covdbg writing from anywhere else - an MCP run, a terminal - fires
    // the watcher repeatedly while the file is still being written, and reading a half-written
    // SQLite file gives either a malformed database or an empty index. The mtime check in the
    // flush cannot help: an mtime says when a file was last touched, never whether it is
    // finished. Waiting for the writes to stop is the guard that actually holds.
    if (covdbReloadDebounceTimer) {
        clearTimeout(covdbReloadDebounceTimer);
    }

    covdbReloadDebounceTimer = setTimeout(() => {
        covdbReloadDebounceTimer = undefined;
        void flushPendingCovdbReloads();
    }, DISCOVERY_RELOAD_DEBOUNCE_MS);
}

async function flushPendingCovdbReloads(): Promise<void> {
    if (
        isFlushingPendingCovdbReloads ||
        isLoadingIndex ||
        covdbReloadScheduler.hasActiveExecution()
    ) {
        return;
    }

    isFlushingPendingCovdbReloads = true;
    try {
        const pendingReloads = covdbReloadScheduler.drainPendingReloads(
            getActiveCovdbPathsByState(),
        );

        for (const pending of pendingReloads) {
            if (covdbReloadScheduler.hasActiveExecution()) {
                covdbReloadScheduler.queueReload(pending.stateKey, pending.covdbPath);
                break;
            }

            const state = coverageStates.get(pending.stateKey);
            if (!state?.activeCovdbPath) {
                continue;
            }

            const mtime = await getMtime(pending.covdbPath);
            if (mtime <= 0 || mtime === state.activeCovdbMtime) {
                continue;
            }

            output.log(`.covdb changed on disk, reloading index: ${pending.covdbPath}`);
            await loadIndex(pending.covdbPath, "settings", state.workspaceFolder);
        }
    } finally {
        isFlushingPendingCovdbReloads = false;
        if (
            !isLoadingIndex &&
            !covdbReloadScheduler.hasActiveExecution() &&
            covdbReloadScheduler.hasPendingReloads()
        ) {
            void flushPendingCovdbReloads();
        }
    }
}

async function withDeferredCovdbReloads<T>(operation: () => Promise<T>): Promise<T> {
    covdbReloadScheduler.beginExecution();
    try {
        return await operation();
    } finally {
        covdbReloadScheduler.endExecution();
        void flushPendingCovdbReloads();
    }
}

function getActiveCovdbPathsByState(): Map<string, string> {
    const activeCovdbPaths = new Map<string, string>();
    for (const [stateKey, state] of coverageStates) {
        if (state.activeCovdbPath) {
            activeCovdbPaths.set(stateKey, state.activeCovdbPath);
        }
    }

    return activeCovdbPaths;
}

function normalizePathKey(filePath: string): string {
    return path.normalize(filePath).toLowerCase();
}

// ---------------------------------------------------------------------------
// Lazy per-file loading
// ---------------------------------------------------------------------------

/**
 * Find the covdb key that matches an editor path, using case-insensitive
 * and suffix matching. Single pass with priority: exact > suffix > basename.
 */
function findIndexKey(editorPath: string): string | undefined {
    const state = getCoverageStateForPath(editorPath);
    if (!state) {
        return undefined;
    }

    return findBestCoverageKey(
        editorPath,
        state.fileIndex.keys(),
        state.workspaceFolder?.uri.fsPath,
    );
}

async function getOrLoadCoverage(editorPath: string): Promise<FileCoverage | undefined> {
    const state = getCoverageStateForPath(editorPath);
    if (!state?.activeCovdbPath) {
        return undefined;
    }

    const key = findIndexKey(editorPath);
    if (!key) {
        return undefined;
    }
    if (await isCoverageStaleForPath(editorPath, key, state)) {
        return undefined;
    }

    return state.session.getOrLoadFileCoverage(key);
}

async function isCoverageStaleForPath(
    editorPath: string,
    key: string,
    state: CoverageWorkspaceState,
): Promise<boolean> {
    if (state.session.hasStaleCoverage(key)) {
        return true;
    }

    const openDocument = vscode.workspace.textDocuments.find(
        (document) =>
            document.uri.scheme === "file" &&
            path.normalize(document.uri.fsPath).toLowerCase() ===
                path.normalize(editorPath).toLowerCase(),
    );
    if (openDocument?.isDirty) {
        return true;
    }

    if (state.activeCovdbMtime <= 0) {
        return false;
    }

    const sourceMtime = await getMtime(editorPath);
    return sourceMtime > 0 && sourceMtime > state.activeCovdbMtime;
}

// ---------------------------------------------------------------------------
// Decoration
// ---------------------------------------------------------------------------

/** Apply coverage decorations to a single editor, loading data lazily. */
async function decorateEditor(editor: vscode.TextEditor): Promise<void> {
    if (!decorator.isDisplayEnabled()) {
        return;
    }

    const coverage = await getOrLoadCoverage(editor.document.uri.fsPath);
    if (coverage) {
        decorator.applyDecorations(editor, coverage);
    } else {
        decorator.clearDecorations(editor);
    }
}

/** Re-apply decorations to all currently visible editors. */
function refreshAllEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
        decorateEditor(editor);
    }
}

function invalidateCoverageForDocument(document: vscode.TextDocument): void {
    if (document.uri.scheme !== "file") {
        return;
    }

    const state = getCoverageStateForPath(document.uri.fsPath);
    if (!state) {
        return;
    }

    const key = findIndexKey(document.uri.fsPath);
    if (!key) {
        return;
    }

    state.session.clearCoverage(key);
    state.session.markCoverageStale(key);

    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.fsPath === document.uri.fsPath) {
            decorator.clearDecorations(editor);
        }
    }
}

// ---------------------------------------------------------------------------
// Main menu (status bar click)
// ---------------------------------------------------------------------------

async function showMenu(context: vscode.ExtensionContext): Promise<void> {
    await showMenuPopup(await buildMenuContext(), buildMenuActions(context));
}

/** Load .covdb…: a discovered database, or any file. */
async function loadCovdbCommand(context: vscode.ExtensionContext): Promise<void> {
    await showDatabaseSwitcher(await buildMenuContext(), buildMenuActions(context));
}

async function buildMenuContext(): Promise<MenuContext> {
    const activeState = getActiveCoverageState();
    return {
        isLoaded: Boolean(activeState?.activeCovdbPath),
        isCoverageEnabled: statusBar.isCoverageEnabled(),
        activeCovdbPath: activeState?.activeCovdbPath,
        fileIndex: activeState?.fileIndex ?? new Map(),
        currentRenderMode: decorator.getRenderMode(),
        // Discover available .covdb files for the switcher
        availableCovdbFiles: await findDiscoveredCovdbFiles(),
    };
}

function buildMenuActions(context: vscode.ExtensionContext): MenuActions {
    return {
        toggle: () => toggleVisibility(),
        setRenderMode: (mode) => applyRenderMode(mode, context),
        showReport: () => showCoverageReportCommand(),
        configure: () => pickCovdbFile(),
        switchDatabase: (covdbPath) => loadIndex(covdbPath, "settings", undefined, true),
        closeDatabase: () => closeCovdb(),
    };
}

// ---------------------------------------------------------------------------
// Commands — toggle, browse, render mode, configure, close
// ---------------------------------------------------------------------------

/** Toggle coverage overlay visibility on/off. */
function toggleVisibility(): void {
    const nowEnabled = statusBar.toggleCoverage();
    decorator.setEnabled(nowEnabled);
    if (nowEnabled) {
        refreshAllEditors();
    } else {
        vscode.window.visibleTextEditors.forEach((e) => decorator.clearDecorations(e));
    }
}

/** Unload the current .covdb and clear all state. */
function closeCovdb(): void {
    const activeState = getActiveCoverageState();
    if (activeState?.workspaceFolder) {
        clearCoverageState(activeState.workspaceFolder, true);
        output.log(`Coverage database closed for workspace ${activeState.workspaceFolder.name}`);
    } else {
        for (const state of coverageStates.values()) {
            clearCoverageState(state.workspaceFolder, false);
        }
        vscode.window.visibleTextEditors.forEach((e) => decorator.clearDecorations(e));
        output.log("Coverage database closed");
    }
    updateActiveWorkspaceUi();
    coverageTree.refresh();
    void flushPendingCovdbReloads();
}

async function showFileBrowser(): Promise<void> {
    const activeState = getActiveCoverageState();
    await showFileBrowserPopup(activeState?.fileIndex ?? new Map());
}

async function applyRenderMode(mode: RenderMode, context: vscode.ExtensionContext): Promise<void> {
    decorator.setRenderMode(mode);
    statusBar.setRenderMode(mode);
    context.workspaceState.update("covdbg.renderMode", mode);
    refreshAllEditors();
}

async function pickCovdbFile(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { "Coverage Database": ["covdb"] },
        title: "Select .covdb file",
    });
    if (result && result.length > 0) {
        // Loaded here, before the setting's own reload, so a file that shows nothing says why.
        await loadIndex(result[0].fsPath, "settings", undefined, true);
        const config = vscode.workspace.getConfiguration("covdbg");
        await config.update("covdbPath", result[0].fsPath, vscode.ConfigurationTarget.Workspace);
    }
}

async function createConfigCommand(): Promise<void> {
    const targetFolder = await pickWorkspaceFolderForConfig();
    if (!targetFolder) {
        return;
    }

    await createConfigInWorkspace(targetFolder);
}

async function createConfigInWorkspace(targetFolder: vscode.WorkspaceFolder): Promise<void> {
    const configPath = path.join(targetFolder.uri.fsPath, CONFIG_FILE_NAME);
    if (await fileExists(configPath)) {
        const doc = await vscode.workspace.openTextDocument(configPath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        return;
    }

    await fs.writeFile(configPath, buildStarterConfig(), "utf8");

    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
}

/** Opens the folder's .covdbg.yaml, or creates one when there is none. */
async function openConfigCommand(): Promise<void> {
    const folder = getPreferredWorkspaceFolder(vscode.window.activeTextEditor?.document.uri.fsPath);
    if (!folder) {
        await createConfigCommand();
        return;
    }

    const matches = await findCovdbgConfigFiles(folder);
    if (matches.length === 0) {
        await createConfigInWorkspace(folder);
        return;
    }

    const picked =
        matches.length === 1
            ? { uri: matches[0] }
            : await vscode.window.showQuickPick(
                  matches.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
                  {
                      title: "covdbg: Open .covdbg.yaml",
                      placeHolder: "Select the config file to open",
                  },
              );
    if (picked) {
        const doc = await vscode.workspace.openTextDocument(picked.uri);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    }
}

/** Opens covdbg's own log from the folder's last run. */
async function openLogCommand(): Promise<void> {
    const folder = getPreferredWorkspaceFolder(vscode.window.activeTextEditor?.document.uri.fsPath);
    const appDataPath = folder
        ? resolveRunnerPaths(readRunnerSettings(folder.uri), folder.uri.fsPath).appDataPath
        : undefined;
    const candidates = appDataPath
        ? [path.join(appDataPath, "covdbg.log"), path.join(appDataPath, "Logs", "covdbg.log")]
        : [];
    for (const logPath of candidates) {
        if (await fileExists(logPath)) {
            const doc = await vscode.workspace.openTextDocument(logPath);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            return;
        }
    }
    vscode.window.showInformationMessage("covdbg: No covdbg.log found for this workspace yet.");
}

async function clearDeletedRunnerConfigPath(configUri: vscode.Uri): Promise<void> {
    const workspaceFolder = getWorkspaceFolderForPath(configUri.fsPath);
    if (!workspaceFolder) {
        return;
    }

    const config = vscode.workspace.getConfiguration("covdbg", workspaceFolder.uri);
    const inspected = config.inspect<string>("runner.configPath");
    if (!inspected) {
        return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    let cleared = false;

    if (
        configuredRunnerConfigMatches(
            inspected.workspaceFolderValue,
            workspaceRoot,
            configUri.fsPath,
        )
    ) {
        await config.update(
            "runner.configPath",
            undefined,
            vscode.ConfigurationTarget.WorkspaceFolder,
        );
        cleared = true;
    }

    if (configuredRunnerConfigMatches(inspected.workspaceValue, workspaceRoot, configUri.fsPath)) {
        await config.update("runner.configPath", undefined, vscode.ConfigurationTarget.Workspace);
        cleared = true;
    }

    if (configuredRunnerConfigMatches(inspected.globalValue, workspaceRoot, configUri.fsPath)) {
        await config.update("runner.configPath", undefined, vscode.ConfigurationTarget.Global);
        cleared = true;
    }

    if (cleared) {
        output.log(
            `covdbg: cleared stale runner.configPath after ${CONFIG_FILE_NAME} was deleted: ${configUri.fsPath}`,
        );
    }
}

function configuredRunnerConfigMatches(
    configuredPath: string | undefined,
    workspaceRoot: string,
    targetPath: string,
): boolean {
    if (!configuredPath || configuredPath.trim().length === 0) {
        return false;
    }

    return (
        path.normalize(resolvePathFromWorkspace(configuredPath, workspaceRoot)).toLowerCase() ===
        path.normalize(targetPath).toLowerCase()
    );
}

/**
 * ▶: the last chosen targets, else the only discovered one, else whatever the user chooses now,
 * which is then remembered.
 */
async function runCoverageCommand(context: vscode.ExtensionContext): Promise<void> {
    await refreshTestControllerItems();
    const remembered = getRememberedTargets();
    const discovered = [...testExecutablePaths.values()];
    const targets =
        remembered.length > 0
            ? remembered
            : discovered.length === 1
              ? discovered
              : await chooseExecutable();
    const selectedItems = (targets ?? [])
        .map((target) => testingRootItem?.children.get(path.normalize(target)))
        .filter((item): item is vscode.TestItem => item !== undefined);
    if (selectedItems.length === 0) {
        return;
    }

    const cancellation = new vscode.CancellationTokenSource();
    try {
        await runCoverageFromTestRequest(
            new vscode.TestRunRequest(selectedItems),
            cancellation.token,
            context,
            true,
        );
    } finally {
        cancellation.dispose();
    }
}

const NOTICE_ACTION_LABELS: Record<NoticeAction, string> = {
    signIn: "Sign in and run again",
    openProfile: "Open profile",
    openApp: "Open app.covdbg.com",
};

/** The one toast a batch may show: a refusal, with its fix. The sign-in fix runs the batch again. */
function showRefusal(notice: RunNotice, runAgain: () => void): void {
    const label = notice.action ? NOTICE_ACTION_LABELS[notice.action] : undefined;
    void vscode.window
        .showWarningMessage(
            `covdbg: This run is not licensed: ${notice.message}`,
            ...(label ? [label] : []),
        )
        .then(async (chosen) => {
            if (!chosen) {
                return;
            }
            if (notice.action === "signIn") {
                if (await auth.signIn()) {
                    runAgain();
                }
                return;
            }
            const url = notice.action === "openProfile" ? PROFILE_URL : APP_URL;
            void vscode.env.openExternal(vscode.Uri.parse(url));
        });
}

function showRunProblem(problem: RunProblem): void {
    void vscode.window
        .showErrorMessage(`covdbg: ${problem.message}`, ...problem.actions)
        .then((action) => {
            if (action === "Manage Trust") {
                void vscode.commands.executeCommand("workbench.trust.manage");
            }
        });
}

/** A message in Test Results, with a Show Log button: the run's output is in the covdbg log. */
function runMessage(text: string): vscode.TestMessage {
    const message = new vscode.TestMessage(text);
    message.contextValue = "covdbg.run";
    return message;
}

async function clearLastRunResultCommand(): Promise<void> {
    const toDelete = [...lastRunOutputPaths];
    closeCovdb();
    auth.clearLastRunNotice();

    if (toDelete.length > 0) {
        let deletedCount = 0;
        for (const outputPath of toDelete) {
            if (!(await fileExists(outputPath))) {
                continue;
            }

            try {
                await fs.unlink(outputPath);
                deletedCount++;
                output.log(`Cleared last run result: ${outputPath}`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                output.logError(`Failed to clear last run result: ${message}`);
                vscode.window.showWarningMessage(
                    `covdbg: Failed to delete last .covdb: ${message}`,
                );
                break;
            }
        }

        if (deletedCount === 0) {
            output.log("Cleared UI state for last run result.");
        }
    } else {
        output.log("Cleared UI state for last run result.");
    }
    lastRunOutputPaths = [];
}

async function showCoverageReportCommand(): Promise<void> {
    const activeState = getActiveCoverageState();
    await report.show(activeState?.fileIndex ?? new Map(), activeState?.activeCovdbPath);
}

async function executeCoverageRun(
    context: vscode.ExtensionContext,
    targetExecutablePath: string,
    outputPathOverride?: string,
): Promise<RunResult> {
    statusBar.setRunning();
    const result = await runCoverageForTarget(context, targetExecutablePath, outputPathOverride);
    // Also a run that never started, so the status bar stops spinning.
    statusBar.setRunFinished();

    if (result.success) {
        if (result.outputPath && (await fileExists(result.outputPath))) {
            await loadIndex(result.outputPath, "settings");
        } else {
            await discoverAndLoadIndex();
        }
    }
    return result;
}

async function finalizeBatchCoverageOutputs(
    context: vscode.ExtensionContext,
    successfulOutputPaths: string[],
    generatedOutputPaths: string[],
): Promise<void> {
    lastRunOutputPaths = dedupeNormalizedPaths(generatedOutputPaths);

    if (successfulOutputPaths.length === 0) {
        return;
    }

    const canonicalOutputPath = getCanonicalCoverageOutputPath(successfulOutputPaths[0]);
    if (!canonicalOutputPath) {
        return;
    }

    const finalInputPaths = dedupeNormalizedPaths(successfulOutputPaths);

    const finalized =
        finalInputPaths.length === 1
            ? await copyCoverageFile(finalInputPaths[0], canonicalOutputPath)
            : await mergeCoverageFiles(
                  context,
                  finalInputPaths,
                  canonicalOutputPath,
                  getWorkspaceFolderForPath(canonicalOutputPath),
              );

    if (!finalized || !(await fileExists(canonicalOutputPath))) {
        return;
    }

    lastRunOutputPaths = dedupeNormalizedPaths([...generatedOutputPaths, canonicalOutputPath]);
    await loadIndex(canonicalOutputPath, "settings");
}

function buildBatchIntermediateOutputPath(targetExecutablePath: string): string | undefined {
    const canonicalOutputPath = getCanonicalCoverageOutputPath(targetExecutablePath);
    return (
        canonicalOutputPath &&
        deriveCoverageBatchOutputPath(canonicalOutputPath, targetExecutablePath)
    );
}

/** Where a run in the folder of `pathInFolder` writes its .covdb unless told otherwise. */
function getCanonicalCoverageOutputPath(pathInFolder: string): string | undefined {
    const workspaceFolder = getPreferredWorkspaceFolder(pathInFolder);
    return (
        workspaceFolder &&
        resolveRunnerPaths(readRunnerSettings(workspaceFolder.uri), workspaceFolder.uri.fsPath)
            .configuredOutputPath
    );
}

async function copyCoverageFile(sourcePath: string, targetPath: string): Promise<boolean> {
    try {
        if (path.normalize(sourcePath).toLowerCase() === path.normalize(targetPath).toLowerCase()) {
            return true;
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(sourcePath, targetPath);
        output.log(`Copied coverage output to ${targetPath}`);
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.logError(`Failed to copy coverage output: ${message}`);
        return false;
    }
}

/** covdbg.covdbPath, resolved against the folder, when the file is there. */
async function getExplicitCovdbCandidate(
    workspaceFolder?: vscode.WorkspaceFolder,
): Promise<string | undefined> {
    const explicit = vscode.workspace
        .getConfiguration("covdbg", workspaceFolder?.uri)
        .get<string>("covdbPath", "")
        .trim();
    if (!explicit) {
        return undefined;
    }

    const resolved = workspaceFolder
        ? resolvePathFromWorkspace(explicit, workspaceFolder.uri.fsPath)
        : explicit;
    if (await fileExists(resolved)) {
        return resolved;
    }

    output.logError(
        workspaceFolder
            ? `covdbg.covdbPath not found for workspace folder ${workspaceFolder.name}: ${resolved}`
            : `covdbg.covdbPath not found: ${explicit}`,
    );
    return undefined;
}

async function findDiscoveredCovdbFiles(
    workspaceFolder?: vscode.WorkspaceFolder,
): Promise<vscode.Uri[]> {
    if (workspaceFolder) {
        const pattern = vscode.workspace
            .getConfiguration("covdbg", workspaceFolder.uri)
            .get<string>("discoveryPattern", "**/*.covdb");
        return vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, pattern),
            DISCOVERY_EXCLUDE_GLOB,
            MAX_DISCOVERED_COVDB_FILES,
        );
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const found: vscode.Uri[] = [];

    if (!workspaceFolders || workspaceFolders.length === 0) {
        const pattern = vscode.workspace
            .getConfiguration("covdbg")
            .get<string>("discoveryPattern", "**/*.covdb");
        return vscode.workspace.findFiles(
            pattern,
            DISCOVERY_EXCLUDE_GLOB,
            MAX_DISCOVERED_COVDB_FILES,
        );
    }

    for (const folder of workspaceFolders) {
        const pattern = vscode.workspace
            .getConfiguration("covdbg", folder.uri)
            .get<string>("discoveryPattern", "**/*.covdb");
        const matches = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, pattern),
            DISCOVERY_EXCLUDE_GLOB,
            MAX_DISCOVERED_COVDB_FILES,
        );
        found.push(...matches);
    }

    return dedupeUris(found);
}

async function findCovdbgConfigFiles(
    workspaceFolder: vscode.WorkspaceFolder,
): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, CONFIG_FILE_GLOB),
        DISCOVERY_EXCLUDE_GLOB,
        MAX_DISCOVERED_COVDB_FILES,
    );
}

async function pickWorkspaceFolderForConfig(): Promise<vscode.WorkspaceFolder | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage(
            "covdbg: Open a workspace folder before creating .covdbg.yaml.",
        );
        return undefined;
    }

    if (workspaceFolders.length === 1) {
        return workspaceFolders[0];
    }

    const picked = await vscode.window.showQuickPick(
        workspaceFolders.map((folder) => ({
            label: folder.name,
            description: folder.uri.fsPath,
            folder,
        })),
        {
            title: "covdbg: Choose workspace folder for .covdbg.yaml",
            placeHolder: "Select the workspace folder where the starter config should be created",
            matchOnDescription: true,
        },
    );
    return picked?.folder;
}

function dedupeUris(uris: vscode.Uri[]): vscode.Uri[] {
    const seen = new Set<string>();
    const deduped: vscode.Uri[] = [];
    for (const uri of uris) {
        const key = path.normalize(uri.fsPath).toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(uri);
    }
    return deduped;
}

function getWorkspaceStateKey(workspaceFolder?: vscode.WorkspaceFolder): string {
    return workspaceFolder?.uri.toString() ?? "__no_workspace__";
}

function getOrCreateCoverageState(
    workspaceFolder?: vscode.WorkspaceFolder,
): CoverageWorkspaceState {
    const key = getWorkspaceStateKey(workspaceFolder);
    let state = coverageStates.get(key);
    if (!state) {
        state = new CoverageWorkspaceState(
            workspaceFolder,
            new CoverageWorkspaceSession(CovdbParser),
        );
        coverageStates.set(key, state);
    } else if (workspaceFolder) {
        state.workspaceFolder = workspaceFolder;
    }
    return state;
}

function getWorkspaceFolderForPath(filePath: string): vscode.WorkspaceFolder | undefined {
    const exactFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    return exactFolder ?? getPreferredWorkspaceFolder(filePath);
}

function getCoverageStateForPath(filePath: string): CoverageWorkspaceState | undefined {
    const workspaceFolder = getWorkspaceFolderForPath(filePath);
    return coverageStates.get(getWorkspaceStateKey(workspaceFolder));
}

function getActiveCoverageState(): CoverageWorkspaceState | undefined {
    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeEditorPath) {
        const activeState = getCoverageStateForPath(activeEditorPath);
        if (activeState?.activeCovdbPath) {
            return activeState;
        }
    }

    for (const state of coverageStates.values()) {
        if (state.activeCovdbPath) {
            return state;
        }
    }

    return undefined;
}

/** What each folder has loaded, for the Coverage view. */
function getFolderCoverage(): FolderCoverage[] {
    return [...coverageStates.values()].map((state) => ({
        folderName: state.workspaceFolder?.name,
        covdbPath: state.activeCovdbPath,
        mtime: state.activeCovdbMtime,
        files: [...state.fileIndex.values()],
        problem: state.loadProblem,
    }));
}

/** The status bar and the report follow the active editor's folder; the Coverage view does not. */
function updateActiveWorkspaceUi(): void {
    const activeState = getActiveCoverageState();
    if (!activeState?.activeCovdbPath || activeState.fileIndex.size === 0) {
        report.clearFunctionIndex();
        statusBar.setIdle();
        return;
    }

    statusBar.setLoaded(buildCoverageSummaryFromFileIndex(activeState.fileIndex).coveragePercent);
    report.update(activeState.fileIndex, activeState.activeCovdbPath);
}

function clearCoverageState(
    workspaceFolder: vscode.WorkspaceFolder | undefined,
    clearEditors: boolean,
): void {
    const stateKey = getWorkspaceStateKey(workspaceFolder);
    const state = coverageStates.get(stateKey);
    if (!state) {
        return;
    }

    disposeCovdbWatcher(stateKey);
    state.session.clear();
    state.loadProblem = undefined;

    if (clearEditors) {
        for (const editor of vscode.window.visibleTextEditors) {
            const editorFolder = getWorkspaceFolderForPath(editor.document.uri.fsPath);
            if (getWorkspaceStateKey(editorFolder) === stateKey) {
                decorator.clearDecorations(editor);
            }
        }
    }
}

function pruneCoverageStates(workspaceFolders: readonly vscode.WorkspaceFolder[]): void {
    const validKeys = new Set(workspaceFolders.map((folder) => getWorkspaceStateKey(folder)));
    for (const [stateKey] of coverageStates) {
        if (stateKey === "__no_workspace__") {
            continue;
        }
        if (!validKeys.has(stateKey)) {
            disposeCovdbWatcher(stateKey);
            coverageStates.delete(stateKey);
        }
    }
}

async function getMostRecentFile(files: vscode.Uri[]): Promise<vscode.Uri | undefined> {
    let newest: vscode.Uri | undefined;
    let best = 0;
    for (const file of files) {
        const mt = await getMtime(file.fsPath);
        if (mt > best) {
            best = mt;
            newest = file;
        }
    }
    return newest;
}

async function getMtime(filePath: string): Promise<number> {
    try {
        return (await fs.stat(filePath)).mtimeMs;
    } catch {
        return 0;
    }
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

function initializeTestingController(context: vscode.ExtensionContext): void {
    testingController = vscode.tests.createTestController("covdbg.testController", "covdbg");
    context.subscriptions.push(testingController);

    testingRootItem = testingController.createTestItem("covdbg.root", "covdbg");
    testingRootItem.description = "Discovering test executables...";
    testingRootItem.canResolveChildren = true;
    testingController.items.replace([testingRootItem]);
    testingController.resolveHandler = async (item) => {
        if (!item || item.id === testingRootItem?.id) {
            await refreshTestControllerItems();
        }
    };
    testingController.refreshHandler = async () => {
        await refreshTestControllerItems();
    };

    testingController.createRunProfile(
        "Run with Coverage",
        vscode.TestRunProfileKind.Run,
        (request, token) => runCoverageFromTestRequest(request, token, context),
        true,
    );

    void refreshTestControllerItems();
}

async function refreshTestControllerItems(): Promise<void> {
    if (!testingController || !testingRootItem) {
        return;
    }
    testingController.items.replace([testingRootItem]);
    testExecutablePaths.clear();
    testingRootItem.children.replace([]);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        testingRootItem.description = "Open a workspace folder to discover tests";
        testDiscoveryDone = true;
        coverageTree.refresh();
        lastDiscoveredTestBinaryIds = undefined;
        return;
    }

    const binaries = dedupeNormalizedPaths([
        ...(await listDiscoveredExecutablePaths()),
        ...(await listRememberedTargets()),
    ]);
    const preferredFolder = getPreferredWorkspaceFolder();
    repositoryHint = preferredFolder
        ? await needsRepositoryHint(preferredFolder.uri.fsPath)
        : false;
    const items: vscode.TestItem[] = [];
    for (const binaryPath of binaries) {
        const id = path.normalize(binaryPath);
        const item = testingController.createTestItem(id, path.basename(binaryPath));
        item.description = vscode.workspace.asRelativePath(binaryPath);
        item.canResolveChildren = false;
        items.push(item);
        testExecutablePaths.set(id, binaryPath);
    }

    testingRootItem.description =
        binaries.length === 0
            ? "No discovered tests"
            : `${binaries.length} discovered test${binaries.length === 1 ? "" : "s"}`;
    testingRootItem.children.replace(items);
    testDiscoveryDone = true;
    coverageTree.refresh();
    const discoveredBinaryIds = items.map((item) => item.id).join("|");
    if (discoveredBinaryIds !== lastDiscoveredTestBinaryIds) {
        lastDiscoveredTestBinaryIds = discoveredBinaryIds;
        output.log(`Testing API: discovered ${binaries.length} binaries.`);
    }
}

async function runCoverageFromTestRequest(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    context: vscode.ExtensionContext,
    fromPalette = false,
): Promise<void> {
    await withDeferredCovdbReloads(async () => {
        if (!testingController) {
            return;
        }
        const run = testingController.createTestRun(request);
        const targets = collectRequestedTests(request, testingController);
        if (targets.length === 0) {
            run.end();
            return;
        }

        const successfulOutputPaths: string[] = [];
        const generatedOutputPaths: string[] = [];
        const notices: RunNotice[] = [];
        let problem: RunProblem | undefined;
        const batchMode = targets.length > 1;

        try {
            // Signed out, this signs in first and the same run goes on; cancelled, it is skipped.
            const stopSignIn = token.onCancellationRequested(() => auth.cancelSignIn());
            const readiness = await auth.ensureReadyToRun().finally(() => stopSignIn.dispose());
            if (!readiness.run) {
                run.appendOutput(`${readiness.reason}\r\n`);
                targets.forEach((item) => run.skipped(item));
                // A cancelled sign-in needs no word; a missing covdbg does when nothing else shows it.
                if (fromPalette && auth.state.kind === "unavailable") {
                    void vscode.window.showErrorMessage(`covdbg: ${readiness.reason}`);
                }
                return;
            }

            if (!(await ensureRunConfigs(targets))) {
                run.appendOutput(`${NEEDS_CONFIG}\r\n`);
                targets.forEach((item) => run.skipped(item));
                return;
            }

            for (const item of targets) {
                if (token.isCancellationRequested) {
                    run.skipped(item);
                    continue;
                }
                run.started(item);
                statusBar.setRunning();
                const targetExecutablePath = getExecutablePathForTestItem(item);
                if (!targetExecutablePath) {
                    run.errored(
                        item,
                        runMessage("covdbg test item is missing an executable path."),
                    );
                    statusBar.setRunFinished();
                    continue;
                }
                const execution = await executeCoverageRun(
                    context,
                    targetExecutablePath,
                    batchMode ? buildBatchIntermediateOutputPath(targetExecutablePath) : undefined,
                );
                if (execution.outputPath) {
                    generatedOutputPaths.push(execution.outputPath);
                }
                notices.push(...execution.notices);
                const refusal = execution.notices.find((notice) => notice.kind === "refused");
                if (execution.success) {
                    if (execution.outputPath) {
                        successfulOutputPaths.push(execution.outputPath);
                    }
                    run.passed(item);
                } else if (refusal) {
                    run.errored(item, runMessage(`This run is not licensed: ${refusal.message}`));
                } else if (execution.problem) {
                    problem ??= execution.problem;
                    run.errored(item, runMessage(execution.problem.message));
                } else {
                    run.failed(item, runMessage("Coverage run failed"));
                }
            }

            // Test Results already says what went wrong; the palette has nothing else to show it.
            if (fromPalette && problem) {
                showRunProblem(problem);
            }

            auth.applyRunNotices(notices);
            const toast = pickBatchToast(notices);
            if (toast) {
                showRefusal(toast, () => {
                    const cancellation = new vscode.CancellationTokenSource();
                    void runCoverageFromTestRequest(request, cancellation.token, context).finally(
                        () => cancellation.dispose(),
                    );
                });
            }

            if (batchMode) {
                await finalizeBatchCoverageOutputs(
                    context,
                    successfulOutputPaths,
                    generatedOutputPaths,
                );
            } else {
                lastRunOutputPaths = dedupeNormalizedPaths(generatedOutputPaths);
            }
        } finally {
            run.end();
        }
    });
}

const NEEDS_CONFIG = "covdbg needs a .covdbg.yaml.";

/**
 * covdbg does not run without a .covdbg.yaml. When a target's folder has none, one modal offers
 * the starter at the folder's root; declined, the run is skipped. A configured covdbg.runner.configPath
 * is left to the runner, which says when it is missing.
 */
async function ensureRunConfigs(targets: vscode.TestItem[]): Promise<boolean> {
    const missing = new Map<string, vscode.WorkspaceFolder>();
    for (const item of targets) {
        const target = getExecutablePathForTestItem(item);
        const folder = target ? getPreferredWorkspaceFolder(target) : undefined;
        if (!target || !folder || missing.has(folder.uri.toString())) {
            continue;
        }
        const settings = readRunnerSettings(folder.uri);
        if (settings.configPath) {
            continue;
        }
        // covdbg looks in its working directory first, then beside the target.
        const { workingDirectory } = resolveRunnerPaths(settings, folder.uri.fsPath);
        const found =
            (await fileExists(path.join(workingDirectory, CONFIG_FILE_NAME))) ||
            (await resolveEffectiveConfigPath("", target, folder.uri.fsPath)) !== undefined;
        if (!found) {
            missing.set(folder.uri.toString(), folder);
        }
    }
    if (missing.size === 0) {
        return true;
    }

    const create = "Create and run";
    const answer = await vscode.window.showInformationMessage(
        NEEDS_CONFIG,
        {
            modal: true,
            detail: `A starter .covdbg.yaml is written to the root of ${[...missing.values()].map((folder) => folder.name).join(", ")}. It counts every source file the tests' debug info names, except the Windows SDK, the MSVC runtime and vendored dependencies.`,
        },
        create,
    );
    if (answer !== create) {
        return false;
    }
    for (const folder of missing.values()) {
        await createConfigInWorkspace(folder);
    }
    return true;
}

function collectRequestedTests(
    request: vscode.TestRunRequest,
    controller: vscode.TestController,
): vscode.TestItem[] {
    const included =
        request.include && request.include.length > 0
            ? [...request.include]
            : collectTopLevelTestItems(controller);
    const excludedIds = new Set((request.exclude ?? []).map((item) => item.id));
    const collected = new Map<string, vscode.TestItem>();

    for (const item of included) {
        collectLeafTestItems(item, excludedIds, collected);
    }

    return [...collected.values()];
}

function collectTopLevelTestItems(controller: vscode.TestController): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    controller.items.forEach((item) => items.push(item));
    return items;
}

function collectLeafTestItems(
    item: vscode.TestItem,
    excludedIds: Set<string>,
    collected: Map<string, vscode.TestItem>,
): void {
    if (excludedIds.has(item.id)) {
        return;
    }

    if (testExecutablePaths.has(item.id)) {
        collected.set(item.id, item);
        return;
    }

    item.children.forEach((child) => collectLeafTestItems(child, excludedIds, collected));
}

/**
 * Choose Executable…: the discovered test executables, the current choice (or, before one, all)
 * ticked, plus Browse… for one discovery does not find. The choice is what ▶ runs from then on;
 * none ticked clears it.
 */
async function chooseExecutable(): Promise<string[] | undefined> {
    const folder = getPreferredWorkspaceFolder();
    if (!folder) {
        void vscode.window.showWarningMessage(
            "covdbg: Open a workspace folder before choosing an executable.",
        );
        return undefined;
    }

    const remembered = new Set(getRememberedTargets().map((p) => path.normalize(p)));
    const discovered = [...testExecutablePaths.values()];
    const browse = { label: "$(folder-opened) Browse…", alwaysShow: true };
    let chosen: string[] = [];
    let browsing = discovered.length === 0;
    if (!browsing) {
        const picks = await vscode.window.showQuickPick(
            [
                ...discovered.map((binaryPath) => ({
                    label: path.basename(binaryPath),
                    description: vscode.workspace.asRelativePath(binaryPath),
                    binaryPath,
                    // Nothing chosen yet, all are ticked, so accepting runs them all.
                    picked: remembered.size === 0 || remembered.has(path.normalize(binaryPath)),
                })),
                browse,
            ],
            {
                title: "covdbg: Choose test executables",
                placeHolder: "The executables to run under coverage",
                canPickMany: true,
                matchOnDescription: true,
            },
        );
        if (!picks) {
            return undefined;
        }
        if (picks.length === 0) {
            await workspaceState.update(LAST_TARGETS_KEY, undefined);
            await refreshTestControllerItems();
            return undefined;
        }
        chosen = picks.flatMap((pick) => ("binaryPath" in pick ? [pick.binaryPath] : []));
        browsing = picks.includes(browse);
    }
    if (browsing) {
        const uris = await vscode.window.showOpenDialog({
            title: "covdbg: Choose test executables",
            defaultUri: folder.uri,
            canSelectMany: true,
            filters: { Executables: ["exe"] },
        });
        chosen.push(...(uris ?? []).map((uri) => uri.fsPath));
    }
    if (chosen.length === 0) {
        return undefined;
    }

    await workspaceState.update(LAST_TARGETS_KEY, chosen);
    // A browsed executable becomes a test item, so it runs like a discovered one.
    await refreshTestControllerItems();
    return chosen;
}

/** The chosen targets that are still test items, that is, still there. */
function getRememberedTargets(): string[] {
    return (workspaceState.get<string[]>(LAST_TARGETS_KEY) ?? [])
        .map((target) => testExecutablePaths.get(path.normalize(target)))
        .filter((target): target is string => target !== undefined);
}

/** The chosen targets that still exist, including ones discovery does not find. */
async function listRememberedTargets(): Promise<string[]> {
    const targets: string[] = [];
    for (const target of workspaceState.get<string[]>(LAST_TARGETS_KEY) ?? []) {
        if (await fileExists(target)) {
            targets.push(target);
        }
    }
    return targets;
}

function getExecutablePathForTestItem(item: vscode.TestItem): string | undefined {
    return testExecutablePaths.get(item.id);
}

/**
 * Filter a file index to only include files reachable from a workspace folder.
 * Removes SDK headers, system includes, and other external paths.
 */
function filterToWorkspaceFiles(
    files: Map<string, CovdbFileSummary>,
    workspaceFolder?: vscode.WorkspaceFolder,
): Map<string, CovdbFileSummary> {
    const folders = workspaceFolder ? [workspaceFolder] : (vscode.workspace.workspaceFolders ?? []);
    // covdbg records long paths; a folder opened by its 8.3 name (C:\Users\SVENSC~1\...) is
    // compared by its long name too.
    const roots = folders.flatMap((folder) =>
        [folder.uri.fsPath, longPath(folder.uri.fsPath)].map((root) =>
            path.normalize(root).toLowerCase(),
        ),
    );
    if (roots.length === 0) {
        return files; // no workspace open — keep everything
    }
    const filtered = new Map<string, CovdbFileSummary>();
    for (const [key, summary] of files) {
        const norm = path.normalize(key).toLowerCase();
        if (roots.some((root) => norm.startsWith(root))) {
            filtered.set(key, summary);
        }
    }
    return filtered;
}

function longPath(fsPath: string): string {
    try {
        return realpathSync.native(fsPath);
    } catch {
        return fsPath;
    }
}
