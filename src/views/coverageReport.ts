import * as vscode from "vscode";
import * as path from "path";
import { CovdbFileSummary, CovdbFunctionSummary } from "../coverage/covdbParser";
import { CovdbParser } from "../coverage/covdbParser";
import { generateReportHtml } from "./reportHtml";

// ---------------------------------------------------------------------------
// Coverage Report — webview panel management
// ---------------------------------------------------------------------------

export class CoverageReport {
    private panel: vscode.WebviewPanel | undefined;
    private functionIndex: Map<string, CovdbFunctionSummary[]> = new Map();

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
    }

    /** Show (or reveal) the coverage report webview. */
    async show(
        fileIndex: Map<string, CovdbFileSummary>,
        activeCovdbPath: string | undefined,
    ): Promise<void> {
        if (fileIndex.size === 0) {
            vscode.window.showInformationMessage("covdbg: No coverage data loaded.");
            return;
        }

        // Lazy-load function index
        if (this.functionIndex.size === 0 && activeCovdbPath) {
            this.functionIndex = await CovdbParser.loadFunctionIndex(activeCovdbPath);
        }

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Two);
        } else {
            this.panel = vscode.window.createWebviewPanel(
                "covdbgCoverageReport",
                "covdbg Coverage Report",
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                },
            );
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });
            this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
        }
        this.panel.webview.html = generateReportHtml({
            fileIndex,
            functionIndex: this.functionIndex,
            asRelativePath: (p) => this.toRelativePath(p),
        });
    }

    /** Refresh the report content if the panel is already open. */
    async update(
        fileIndex: Map<string, CovdbFileSummary>,
        activeCovdbPath: string | undefined,
    ): Promise<void> {
        if (!this.panel) {
            return;
        }
        if (this.functionIndex.size === 0 && activeCovdbPath) {
            this.functionIndex = await CovdbParser.loadFunctionIndex(activeCovdbPath);
        }
        // The report may have been closed while the functions loaded.
        if (!this.panel) {
            return;
        }
        this.panel.webview.html = generateReportHtml({
            fileIndex,
            functionIndex: this.functionIndex,
            asRelativePath: (p) => this.toRelativePath(p),
        });
    }

    /** Clear cached function index (e.g. when the .covdb is reloaded). */
    clearFunctionIndex(): void {
        this.functionIndex.clear();
    }

    // ── Private ──

    private toRelativePath(p: string): string {
        return vscode.workspace.workspaceFolders
            ? vscode.workspace.asRelativePath(p)
            : path.basename(p);
    }

    private async handleMessage(msg: {
        command?: string;
        filePath?: string;
        line?: number;
    }): Promise<void> {
        if (msg.command !== "openFile" || !msg.filePath) {
            return;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(msg.filePath);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            if (msg.line && msg.line > 0) {
                const pos = new vscode.Position(msg.line - 1, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(
                    new vscode.Range(pos, pos),
                    vscode.TextEditorRevealType.InCenter,
                );
            }
        } catch {
            vscode.window.showWarningMessage(`Cannot open: ${msg.filePath}`);
        }
    }
}
