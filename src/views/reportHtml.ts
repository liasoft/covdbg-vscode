import { CovdbFileSummary, CovdbFunctionSummary } from "../coverage/covdbParser";

// ---------------------------------------------------------------------------
// Tree data structures
// ---------------------------------------------------------------------------

export interface TreeNode {
    name: string;
    /** Full dir path segment for folders, absolute path for files. */
    fullPath: string;
    children: Map<string, TreeNode>;
    /** Only on file nodes. */
    file?: { absPath: string; display: string; covered: number; total: number; pct: number };
    functions?: CovdbFunctionSummary[];
    /** Aggregated from children. */
    aggCovered: number;
    aggTotal: number;
}

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

/**
 * Build a tree from the file index and function index.
 * @param fileIndex  Map of file path → summary stats.
 * @param functionIndex  Map of file path → function summaries.
 * @param asRelativePath  Converts an absolute path to a workspace-relative display path.
 */
export function buildTree(
    fileIndex: Map<string, CovdbFileSummary>,
    functionIndex: Map<string, CovdbFunctionSummary[]>,
    asRelativePath: (p: string) => string,
): TreeNode {
    const root: TreeNode = {
        name: "",
        fullPath: "",
        children: new Map(),
        aggCovered: 0,
        aggTotal: 0,
    };

    for (const s of fileIndex.values()) {
        const display = asRelativePath(s.filePath);
        const parts = display.replace(/\\/g, "/").split("/");
        let node = root;
        // Walk / create folder nodes
        for (let i = 0; i < parts.length - 1; i++) {
            const seg = parts[i];
            let child = node.children.get(seg);
            if (!child) {
                child = {
                    name: seg,
                    fullPath: parts.slice(0, i + 1).join("/"),
                    children: new Map(),
                    aggCovered: 0,
                    aggTotal: 0,
                };
                node.children.set(seg, child);
            }
            node = child;
        }
        // Leaf = file
        const fileName = parts[parts.length - 1];
        const fileNode: TreeNode = {
            name: fileName,
            fullPath: display,
            children: new Map(),
            file: {
                absPath: s.filePath,
                display,
                covered: s.coveredLines,
                total: s.totalLines,
                pct: s.coveragePercent,
            },
            functions: functionIndex.get(s.filePath),
            aggCovered: s.coveredLines,
            aggTotal: s.totalLines,
        };
        node.children.set(fileName, fileNode);
    }

    // Aggregate stats up
    function aggregate(n: TreeNode): void {
        if (n.file) {
            return;
        } // leaf
        n.aggCovered = 0;
        n.aggTotal = 0;
        for (const c of n.children.values()) {
            aggregate(c);
            n.aggCovered += c.aggCovered;
            n.aggTotal += c.aggTotal;
        }
    }
    aggregate(root);

    // Collapse single-child folders  (src/Shared -> src/Shared)
    function collapse(n: TreeNode): TreeNode {
        if (n.file) {
            return n;
        }
        // Recurse first
        const newChildren = new Map<string, TreeNode>();
        for (const [k, c] of n.children) {
            newChildren.set(k, collapse(c));
        }
        n.children = newChildren;
        // If single child that is also a folder, merge
        if (n.children.size === 1 && n.name !== "") {
            const only = n.children.values().next().value!;
            if (!only.file) {
                const mergedName = n.name + "/" + only.name;
                only.name = mergedName;
                only.fullPath = mergedName;
                return only;
            }
        }
        return n;
    }
    // The root is never merged into its child: only named folders are.
    collapse(root);

    return root;
}

// ---------------------------------------------------------------------------
// HTML rendering helpers
// ---------------------------------------------------------------------------

export function pctCssVar(pct: number): string {
    return pct >= 80 ? "var(--cov-good)" : pct >= 50 ? "var(--cov-warn)" : "var(--cov-bad)";
}

function barHtml(pct: number, color: string): string {
    const w = Math.min(100, Math.round(pct));
    return `<span class="bar"><span class="bar-bg"><span class="bar-fill" style="width:${w}%;background:${color}"></span></span></span>`;
}

/**
 * HTML-escape a string for safe interpolation into HTML.
 * IMPORTANT: All user-derived strings (file paths, function names, etc.)
 * MUST be passed through this function before embedding in HTML output.
 */
export function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Tree → HTML
// ---------------------------------------------------------------------------

export function renderTreeHtml(node: TreeNode, depth: number = 0): string {
    // Sort: folders first, then files, alphabetically
    const sorted = Array.from(node.children.values()).sort((a, b) => {
        const aIsDir = !a.file ? 0 : 1;
        const bIsDir = !b.file ? 0 : 1;
        if (aIsDir !== bIsDir) {
            return aIsDir - bIsDir;
        }
        return a.name.localeCompare(b.name);
    });

    let html = "";
    for (const child of sorted) {
        if (child.file) {
            // File node
            const f = child.file;
            const p = f.pct.toFixed(1);
            const c = pctCssVar(f.pct);
            const fns = child.functions ?? [];
            const hasFns = fns.length > 0;
            const fnHitCount = fns.filter((fn) => fn.hitCount > 0).length;
            html += `<div class="tree-item file depth-${depth}" data-path="${esc(f.absPath)}">`;
            html += `<span class="indent" style="width:${depth * 16}px"></span>`;
            html += hasFns
                ? `<span class="toggle collapsed"></span>`
                : `<span class="toggle-placeholder"></span>`;
            html += `<span class="icon file-icon"></span>`;
            html += `<span class="label">${esc(child.name)}</span>`;
            html += `<span class="stats">${f.covered}/${f.total}</span>`;
            html += barHtml(f.pct, c);
            html += `<span class="pct" style="color:${c}">${p}%</span>`;
            html += `</div>`;
            // Function children (hidden by default)
            if (hasFns) {
                html += `<div class="fn-group collapsed">`;
                // Function summary header
                html += `<div class="fn-summary depth-${depth + 1}">`;
                html += `<span class="indent" style="width:${(depth + 1) * 16}px"></span>`;
                html += `<span class="icon function-icon"></span>`;
                html += `<span class="label dim">${fnHitCount}/${fns.length} functions hit</span>`;
                html += `</div>`;
                for (const fn of fns) {
                    const hit = fn.hitCount > 0;
                    const fnColor = hit ? "var(--cov-good)" : "var(--cov-bad)";
                    html += `<div class="tree-item fn depth-${depth + 1}" data-path="${esc(f.absPath)}" data-line="${fn.startLine}">`;
                    html += `<span class="indent" style="width:${(depth + 1) * 16}px"></span>`;
                    html += `<span class="toggle-placeholder"></span>`;
                    html += `<span class="icon function-icon"></span>`;
                    html += `<span class="label fn-name">${esc(fn.functionName)}</span>`;
                    html += `<span class="stats dim">L${fn.startLine}–${fn.endLine}</span>`;
                    html += `<span class="fn-hit" style="color:${fnColor}">${hit ? `${fn.hitCount}x` : "miss"}</span>`;
                    html += `</div>`;
                }
                html += `</div>`;
            }
        } else {
            // Folder node
            const aggPct = child.aggTotal > 0 ? (child.aggCovered / child.aggTotal) * 100 : 0;
            const c = pctCssVar(aggPct);
            html += `<div class="tree-item folder depth-${depth}">`;
            html += `<span class="indent" style="width:${depth * 16}px"></span>`;
            html += `<span class="toggle expanded"></span>`;
            html += `<span class="icon folder-icon"></span>`;
            html += `<span class="label folder-name">${esc(child.name)}</span>`;
            html += `<span class="stats">${child.aggCovered}/${child.aggTotal}</span>`;
            html += barHtml(aggPct, c);
            html += `<span class="pct" style="color:${c}">${aggPct.toFixed(1)}%</span>`;
            html += `</div>`;
            html += `<div class="folder-children">`;
            html += renderTreeHtml(child, depth + 1);
            html += `</div>`;
        }
    }
    return html;
}

// ---------------------------------------------------------------------------
// Full report HTML page
// ---------------------------------------------------------------------------

export interface ReportData {
    fileIndex: Map<string, CovdbFileSummary>;
    functionIndex: Map<string, CovdbFunctionSummary[]>;
    asRelativePath: (p: string) => string;
}

export function generateReportHtml(data: ReportData): string {
    const { fileIndex, functionIndex, asRelativePath } = data;
    const tree = buildTree(fileIndex, functionIndex, asRelativePath);
    const totalPct = tree.aggTotal > 0 ? (tree.aggCovered / tree.aggTotal) * 100 : 0;
    const totalFns = Array.from(functionIndex.values()).reduce((s, a) => s + a.length, 0);
    const hitFns = Array.from(functionIndex.values()).reduce(
        (s, a) => s + a.filter((f) => f.hitCount > 0).length,
        0,
    );
    const treeHtml = renderTreeHtml(tree);

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
:root{--cov-good:#4caf50;--cov-warn:#ff9800;--cov-bad:#f44336;--row-h:24px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);
  color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:12px 16px;overflow-x:hidden}

/* Summary */
.summary{display:flex;gap:20px;align-items:center;padding:10px 14px;margin-bottom:10px;
  background:var(--vscode-editor-inactiveSelectionBackground);border-radius:6px}
.summary-pct{font-size:1.8em;font-weight:700;letter-spacing:-0.5px}
.summary-detail{opacity:.85;line-height:1.5}

/* Filter */
input[type="text"]{width:100%;padding:5px 10px;margin-bottom:6px;
  background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border,transparent);border-radius:4px;outline:none;font-size:inherit}
input[type="text"]:focus{border-color:var(--vscode-focusBorder)}

/* Tree rows */
.tree-item{display:flex;align-items:center;height:var(--row-h);padding:0 4px;cursor:pointer;
  border-radius:3px;gap:4px;white-space:nowrap}
.tree-item:hover{background:var(--vscode-list-hoverBackground)}
.indent{flex-shrink:0;display:inline-block}
.toggle{flex-shrink:0;width:16px;text-align:center;font-size:12px;cursor:pointer;opacity:.7}
.toggle:hover{opacity:1}
.toggle::before{display:inline-block;width:100%}
.toggle.collapsed::before{content:'▸'}
.toggle.expanded::before{content:'▾'}
.toggle-placeholder{flex-shrink:0;width:16px}
.icon{flex-shrink:0;width:16px;text-align:center;font-size:14px;opacity:.8}
.file-icon::before{content:'□'}
.folder-icon::before{content:'▣'}
.function-icon::before{content:'ƒ'}
.label{flex:1;overflow:hidden;text-overflow:ellipsis}
.folder-name{font-weight:600}
.fn-name{font-family:var(--vscode-editor-font-family,monospace);font-size:0.92em}
.stats{flex-shrink:0;text-align:right;min-width:60px;opacity:.8;font-size:0.9em}
.dim{opacity:.6}
.pct{flex-shrink:0;text-align:right;min-width:48px;font-weight:700;font-size:0.9em}
.fn-hit{flex-shrink:0;text-align:right;min-width:42px;font-weight:600;font-size:0.85em}

/* Bar */
.bar{flex-shrink:0;width:80px;display:inline-flex;align-items:center}
.bar-bg{height:6px;border-radius:3px;width:100%;background:var(--vscode-editor-inactiveSelectionBackground)}
.bar-fill{height:100%;border-radius:3px;transition:width .15s}

/* Collapsible */
.folder-children{}
.folder.collapsed + .folder-children{display:none}
.fn-group.collapsed .tree-item.fn,
.fn-group.collapsed .fn-summary{display:none}

.hidden{display:none!important}
</style>
</head><body>

<div class="summary">
  <span class="summary-pct" style="color:${pctCssVar(totalPct)}">${totalPct.toFixed(1)}%</span>
  <span class="summary-detail">
    ${tree.aggCovered} / ${tree.aggTotal} lines &bull; ${fileIndex.size} files<br>
    ${hitFns} / ${totalFns} functions hit
  </span>
</div>

<input type="text" id="filter" placeholder="Filter files…" />

<div id="tree">${treeHtml}</div>

${generateReportScript()}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Embedded JavaScript for the webview
// ---------------------------------------------------------------------------

function generateReportScript(): string {
    return `<script>
const vscode = acquireVsCodeApi();

// Click file/function → open in editor
document.querySelectorAll('.tree-item.file, .tree-item.fn').forEach(el => {
    el.addEventListener('click', e => {
        if (e.target.closest('.toggle')) return; // let toggle handler run
        const p = el.dataset.path;
        const l = parseInt(el.dataset.line || '0', 10);
        if (p) vscode.postMessage({ command: 'openFile', filePath: p, line: l });
    });
});

// Folder collapse/expand
document.querySelectorAll('.tree-item.folder').forEach(el => {
    el.addEventListener('click', () => {
        el.classList.toggle('collapsed');
        const chev = el.querySelector('.toggle');
        if (chev) {
            chev.classList.toggle('expanded');
            chev.classList.toggle('collapsed');
        }
    });
});

// File → expand/collapse function list
document.querySelectorAll('.tree-item.file .toggle').forEach(el => {
    el.addEventListener('click', e => {
        e.stopPropagation();
        const fileEl = el.closest('.tree-item.file');
        const fnGroup = fileEl?.nextElementSibling;
        if (fnGroup?.classList.contains('fn-group')) {
            fnGroup.classList.toggle('collapsed');
            el.classList.toggle('expanded');
            el.classList.toggle('collapsed');
        }
    });
});

// Filter
const fi = document.getElementById('filter');
fi.addEventListener('input', () => {
    const q = fi.value.toLowerCase();
    if (!q) {
        document.querySelectorAll('.hidden').forEach(e => e.classList.remove('hidden'));
        return;
    }
    // Show/hide file rows and their function groups
    document.querySelectorAll('.tree-item.file').forEach(el => {
        const name = el.querySelector('.label')?.textContent?.toLowerCase() || '';
        const match = name.includes(q);
        el.classList.toggle('hidden', !match);
        const fnGroup = el.nextElementSibling;
        if (fnGroup?.classList.contains('fn-group')) {
            fnGroup.classList.toggle('hidden', !match);
        }
    });
    // Also filter function names
    document.querySelectorAll('.tree-item.fn').forEach(el => {
        const name = el.querySelector('.fn-name')?.textContent?.toLowerCase() || '';
        if (name.includes(q)) {
            el.classList.remove('hidden');
            const group = el.closest('.fn-group');
            if (group) { group.classList.remove('hidden'); group.classList.remove('collapsed'); }
            const prev = group?.previousElementSibling;
            if (prev) prev.classList.remove('hidden');
        }
    });
    // Show parent folders that have visible children
    document.querySelectorAll('.folder-children').forEach(fc => {
        const hasVisible = fc.querySelector('.tree-item:not(.hidden)');
        const folder = fc.previousElementSibling;
        if (folder?.classList.contains('folder')) {
            folder.classList.toggle('hidden', !hasVisible);
        }
    });
});
</script>`;
}
