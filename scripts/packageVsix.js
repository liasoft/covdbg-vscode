const { execFileSync } = require("child_process");
const path = require("path");

// The universal VSIX bundles the x64 covdbg and serves every platform without a VSIX of its own;
// the Marketplace serves the win32-arm64 one on Windows on ARM.
const TARGETS = ["universal", "win32-arm64"];

function main() {
    const targets = process.argv.length > 2 ? process.argv.slice(2) : TARGETS;
    for (const target of targets) {
        if (!TARGETS.includes(target)) {
            throw new Error(`Unknown target ${target}; expected one of ${TARGETS.join(", ")}.`);
        }
    }

    for (const target of targets) {
        node(path.join(__dirname, "downloadPortable.js"), target);
        // The check runs the Windows PowerShell, so it is skipped where there is none.
        if (process.platform === "win32") {
            node(path.join(__dirname, "verifyBundledCovdbg.js"), target);
        } else {
            console.log(`Skipping the bundled covdbg check for ${target}: it needs Windows.`);
        }
        const targetArgs = target === "universal" ? [] : ["--target", target];
        node(require.resolve("@vscode/vsce/vsce"), "package", ...targetArgs, "--skip-license");
    }
}

function node(script, ...args) {
    execFileSync(process.execPath, [script, ...args], { stdio: "inherit" });
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to package the VSIX: ${message}`);
    process.exitCode = 1;
}
