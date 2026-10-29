import * as vscode from "vscode";
import * as path from "path";
import { RenderMode } from "../types";
import { CovdbFileSummary } from "../coverage/covdbParser";
import { buildCoverageSummaryFromFileIndex } from "../coverage/coverageSummary";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Read-only snapshot of state the menu needs to render. */
export interface MenuContext {
    isLoaded: boolean;
    isCoverageEnabled: boolean;
    activeCovdbPath: string | undefined;
    fileIndex: Map<string, CovdbFileSummary>;
    currentRenderMode: RenderMode;
    /** All .covdb files discovered in the workspace (for the switcher). */
    availableCovdbFiles: vscode.Uri[];
}

/** Callbacks the menu can trigger — keeps UI decoupled from extension logic. */
export interface MenuActions {
    toggle(): void;
    setRenderMode(mode: RenderMode): void;
    showReport(): void;
    configure(): void;
    switchDatabase(covdbPath: string): void;
    closeDatabase(): void;
}

// ---------------------------------------------------------------------------
// Main menu (status-bar click)
// ---------------------------------------------------------------------------

interface MenuItem extends vscode.QuickPickItem {
    action?: string;
    mode?: RenderMode;
}

export async function showMenu(ctx: MenuContext, actions: MenuActions): Promise<void> {
    if (!ctx.isLoaded || !ctx.activeCovdbPath) {
        await showDatabaseSwitcher(ctx, actions);
        return;
    }

    const items: MenuItem[] = [];
    const modeLabel = (m: RenderMode) =>
        m === "line" ? "Full Line" : m === "gutter" ? "Gutter" : "Both";

    // ── Database section ──
    const { linesCovered, linesTotal } = buildCoverageSummaryFromFileIndex(ctx.fileIndex);
    const pct = linesTotal > 0 ? (linesCovered / linesTotal) * 100 : 0;
    items.push({
        label: "Coverage Database",
        kind: vscode.QuickPickItemKind.Separator,
        action: "",
    });
    items.push({
        label: `$(database)  ${path.basename(ctx.activeCovdbPath)}`,
        description: `${ctx.fileIndex.size} files — click to switch`,
        detail: `    ${linesCovered} / ${linesTotal} lines — ${pct.toFixed(1)}%`,
        action: "switch-database",
    });

    // ── Rendering section ──
    items.push({ label: "Rendering", kind: vscode.QuickPickItemKind.Separator, action: "" });
    for (const m of ["line", "gutter", "both"] as RenderMode[]) {
        const active = m === ctx.currentRenderMode;
        items.push({
            label: `${active ? "$(check)" : "$(blank)"}  ${modeLabel(m)}`,
            action: "render-mode",
            mode: m,
        });
    }

    // ── Actions section ──
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator, action: "" });
    items.push({
        label: `$(graph)  Coverage Report`,
        action: "report",
    });
    items.push({
        label: ctx.isCoverageEnabled ? "$(eye-closed)  Hide Coverage" : "$(eye)  Show Coverage",
        action: "toggle",
    });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "covdbg",
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!picked || !picked.action) {
        return;
    }

    switch (picked.action) {
        case "toggle":
            actions.toggle();
            break;
        case "render-mode":
            if (picked.mode) {
                actions.setRenderMode(picked.mode);
            }
            break;
        case "report":
            actions.showReport();
            break;
        case "switch-database":
            await showDatabaseSwitcher(ctx, actions);
            break;
    }
}

// ---------------------------------------------------------------------------
// Database switcher popup
// ---------------------------------------------------------------------------

/** Load .covdb…: the discovered databases, a file picker, and closing the current one. */
export async function showDatabaseSwitcher(ctx: MenuContext, actions: MenuActions): Promise<void> {
    interface DbItem extends vscode.QuickPickItem {
        covdbPath?: string;
        action?: string;
    }

    const items: DbItem[] = [];

    // Close current database
    if (ctx.activeCovdbPath) {
        items.push({
            label: "$(close)  Close Current Database",
            description: path.basename(ctx.activeCovdbPath),
            action: "close",
        });

        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    }

    // Available .covdb files in the workspace
    for (const uri of ctx.availableCovdbFiles) {
        const isCurrent =
            ctx.activeCovdbPath &&
            path.normalize(uri.fsPath).toLowerCase() ===
                path.normalize(ctx.activeCovdbPath).toLowerCase();
        const display = vscode.workspace.workspaceFolders
            ? vscode.workspace.asRelativePath(uri.fsPath)
            : path.basename(uri.fsPath);
        items.push({
            label: `${isCurrent ? "$(check)" : "$(database)"}  ${display}`,
            description: isCurrent ? "active" : "",
            covdbPath: uri.fsPath,
            action: "switch",
        });
    }

    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });

    // Browse for a file not in the workspace
    items.push({
        label: "$(folder-opened)  Browse for .covdb File…",
        action: "browse",
    });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "covdbg — switch coverage database",
        matchOnDescription: true,
    });
    if (!picked || !picked.action) {
        return;
    }

    switch (picked.action) {
        case "close":
            actions.closeDatabase();
            break;
        case "switch":
            if (picked.covdbPath) {
                actions.switchDatabase(picked.covdbPath);
            }
            break;
        case "browse":
            actions.configure();
            break;
    }
}

// ---------------------------------------------------------------------------
// File browser popup
// ---------------------------------------------------------------------------

export async function showFileBrowser(fileIndex: Map<string, CovdbFileSummary>): Promise<void> {
    if (fileIndex.size === 0) {
        vscode.window.showInformationMessage("covdbg: No coverage files indexed.");
        return;
    }

    interface FileItem extends vscode.QuickPickItem {
        filePath: string;
    }

    const items: FileItem[] = Array.from(fileIndex.values())
        .sort((a, b) => a.filePath.localeCompare(b.filePath))
        .map((s) => {
            const pct = s.coveragePercent.toFixed(1);
            const icon =
                s.coveragePercent >= 80
                    ? "$(check)"
                    : s.coveragePercent >= 50
                      ? "$(warning)"
                      : "$(error)";
            const display = vscode.workspace.workspaceFolders
                ? vscode.workspace.asRelativePath(s.filePath)
                : path.basename(s.filePath);
            return {
                label: `${icon}  ${display}`,
                description: `${s.coveredLines}/${s.totalLines} — ${pct}%`,
                filePath: s.filePath,
            };
        });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "covdbg — browse covered files",
        matchOnDescription: true,
    });
    if (picked) {
        try {
            const doc = await vscode.workspace.openTextDocument(picked.filePath);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        } catch {
            vscode.window.showWarningMessage(`Cannot open: ${picked.filePath}`);
        }
    }
}
