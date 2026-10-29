import { vscodeStub } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import { getKnownInstallPaths } from "../runner/installPaths";
import {
    RuntimeCandidate,
    describeRuntimeProblem,
    getRuntimeCandidates,
    pickRuntime,
    resolveBundledPortable,
    resolveCovdbgRuntime,
} from "../runner/executableResolver";
import type { RunnerSettings } from "../runner/runnerTypes";
import { FakeProcess, stubSpawn } from "./fakeCovdbg";
import { tempFolder, writeFile } from "./fixtures";

const context = {
    extensionUri: { fsPath: os.tmpdir() },
    globalStorageUri: { fsPath: os.tmpdir() },
} as unknown as vscode.ExtensionContext;

function settingsWith(executablePath = ""): RunnerSettings {
    return {
        executablePath,
        portableCachePath: "",
        binaryDiscoveryPattern: "",
        binaryDiscoveryExcludePattern: "",
        targetArgs: [],
        configPath: "",
        outputPath: "",
        workingDirectory: "",
        env: {},
    };
}

/** A candidate at `exePath`, recording in `located` that it was looked for. */
function candidate(
    source: RuntimeCandidate["source"],
    exePath: string | undefined,
    located: string[] = [],
): RuntimeCandidate {
    return {
        source,
        locate: async () => {
            located.push(source);
            return exePath;
        },
    };
}

const versions = new Map([
    ["old.exe", "0.0.1-debug"],
    ["new.exe", "1.4.0"],
    ["newer.exe", "1.4.2"],
]);
const probe = async (exePath: string) => versions.get(exePath);

test("known install paths include covdbg executable candidates", () => {
    const candidates = getKnownInstallPaths();
    assert.ok(candidates.length >= 2);
    for (const candidate of candidates) {
        assert.ok(candidate.toLowerCase().endsWith("covdbg.exe"));
    }
});

/** Runs `body` with the environment variables set as given, undefined ones removed. */
async function withEnv(
    vars: Record<string, string | undefined>,
    body: () => void | Promise<void>,
): Promise<void> {
    const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
    const apply = (values: Record<string, string | undefined>) => {
        for (const [name, value] of Object.entries(values)) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    };
    apply(vars);
    try {
        await body();
    } finally {
        apply(saved);
    }
}

test("known install paths include the per-user Liasoft install", async () => {
    await withEnv({ LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" }, () => {
        assert.ok(
            getKnownInstallPaths().includes(
                path.join(
                    "C:\\Users\\dev\\AppData\\Local",
                    "Programs",
                    "Liasoft",
                    "covdbg",
                    "covdbg.exe",
                ),
            ),
        );
    });
});

test("without the usual environment the install paths are the default Program Files ones", async () => {
    await withEnv(
        { ProgramFiles: undefined, "ProgramFiles(x86)": undefined, LOCALAPPDATA: undefined },
        () => {
            assert.deepEqual(getKnownInstallPaths(), [
                path.join("C:\\Program Files", "Liasoft", "covdbg", "covdbg.exe"),
                path.join("C:\\Program Files (x86)", "Liasoft", "covdbg", "covdbg.exe"),
            ]);
        },
    );
});

test("covdbg is looked for in the setting, PATH, installs, the bundled copy, then the cache", () => {
    const sources = getRuntimeCandidates(context, settingsWith("covdbg.exe"), os.tmpdir()).map(
        (c) => c.source,
    );
    const installs = getKnownInstallPaths().map(() => "install");
    assert.deepEqual(sources, ["setting", "path", ...installs, "bundled", "cache"]);
});

test("without covdbg.executablePath there is no setting candidate", () => {
    const sources = getRuntimeCandidates(context, settingsWith(), os.tmpdir()).map((c) => c.source);
    assert.equal(sources[0], "path");
});

test("the first covdbg 1.4 or newer wins, and nothing after it is looked for", async () => {
    const located: string[] = [];
    const state = await pickRuntime(
        [
            candidate("path", undefined, located),
            candidate("install", "new.exe", located),
            candidate("bundled", "newer.exe", located),
        ],
        probe,
    );
    assert.deepEqual(state, { kind: "ok", path: "new.exe", version: "1.4.0", source: "install" });
    assert.deepEqual(located, ["path", "install"]);
});

test("a covdbg older than 1.4, such as the 0.0.1-debug build, is passed over", async () => {
    const state = await pickRuntime(
        [candidate("bundled", "old.exe"), candidate("cache", "newer.exe")],
        probe,
    );
    assert.deepEqual(state, { kind: "ok", path: "newer.exe", version: "1.4.2", source: "cache" });
});

test("a too-old covdbg.executablePath is reported, not replaced by another covdbg", async () => {
    const located: string[] = [];
    const state = await pickRuntime(
        [candidate("setting", "old.exe", located), candidate("path", "new.exe", located)],
        probe,
    );
    assert.deepEqual(state, {
        kind: "tooOld",
        path: "old.exe",
        version: "0.0.1-debug",
        fromSetting: true,
    });
    assert.deepEqual(located, ["setting"]);
});

test("when every covdbg found is too old the first one is reported", async () => {
    const state = await pickRuntime(
        [candidate("path", "old.exe"), candidate("bundled", "broken.exe")],
        probe,
    );
    assert.deepEqual(state, {
        kind: "tooOld",
        path: "old.exe",
        version: "0.0.1-debug",
        fromSetting: false,
    });
});

test("a covdbg that reports no version is not called too old", () => {
    const message = describeRuntimeProblem({
        kind: "tooOld",
        path: "broken.exe",
        fromSetting: false,
    });
    assert.match(message, /broken\.exe, but it did not report its version/);
});

test("when no covdbg is found at all the runtime is missing", async () => {
    const state = await pickRuntime([candidate("path", undefined)], probe);
    assert.deepEqual(state, { kind: "missing" });
});

test(
    "overlapping calls share one expansion of the bundled archive",
    { skip: process.platform !== "win32" && "the archive is expanded with PowerShell" },
    async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covdbg-resolver-"));
        const portableDir = path.join(dir, "extension", "assets", "portable");
        fs.mkdirSync(portableDir, { recursive: true });
        fs.writeFileSync(path.join(dir, "covdbg.exe"), "");
        execFileSync("powershell.exe", [
            "-NoLogo",
            "-NoProfile",
            "-Command",
            `Compress-Archive -LiteralPath '${path.join(dir, "covdbg.exe")}' -DestinationPath '${path.join(portableDir, "covdbg-portable.zip")}'`,
        ]);
        const bundledContext = {
            extensionUri: { fsPath: path.join(dir, "extension") },
        } as unknown as vscode.ExtensionContext;
        const settings = { ...settingsWith(), portableCachePath: path.join(dir, "cache") };
        try {
            const first = resolveBundledPortable(bundledContext, settings);
            const second = resolveBundledPortable(bundledContext, settings);
            assert.equal(first, second);
            assert.equal(await first, path.join(dir, "cache", "bundled", "covdbg.exe"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    },
);

test("an untrusted workspace resolves to unsupported without looking for covdbg", async () => {
    vscodeStub.workspace.isTrusted = false;
    try {
        const state = await resolveCovdbgRuntime(context, settingsWith(), os.tmpdir());
        assert.deepEqual(
            state,
            process.platform === "win32"
                ? { kind: "unsupported", reason: "untrusted" }
                : { kind: "unsupported", reason: "platform" },
        );
    } finally {
        vscodeStub.workspace.isTrusted = true;
    }
});

/** The candidate for `source`, among those for `settings`. */
function locator(
    source: RuntimeCandidate["source"],
    settings: RunnerSettings,
    root = os.tmpdir(),
    candidateContext = context,
): RuntimeCandidate {
    return getRuntimeCandidates(candidateContext, settings, root).find((c) => c.source === source)!;
}

test("covdbg.executablePath is resolved against the folder, and a missing one is logged", async () => {
    const root = tempFolder();
    const exe = writeFile(path.join(root, "tools", "covdbg.exe"));
    assert.equal(await locator("setting", settingsWith("tools/covdbg.exe"), root).locate(), exe);

    vscodeStub.window.log = [];
    assert.equal(await locator("setting", settingsWith("gone.exe"), root).locate(), undefined);
    assert.match(
        vscodeStub.window.log.join("\n"),
        /ERROR: Configured covdbg.executablePath not found: .*gone\.exe/,
    );
});

test("on PATH the first folder holding covdbg.exe wins, blank entries skipped", async () => {
    const without = tempFolder();
    const first = tempFolder();
    const second = tempFolder();
    writeFile(path.join(first, "covdbg.exe"));
    writeFile(path.join(second, "covdbg.exe"));
    const pathCandidate = locator("path", settingsWith());

    await withEnv({ PATH: ["", "  ", without, first, second].join(path.delimiter) }, async () => {
        assert.equal(await pathCandidate.locate(), path.join(first, "covdbg.exe"));
    });
    await withEnv({ PATH: without }, async () => {
        assert.equal(await pathCandidate.locate(), undefined);
    });
    await withEnv({ PATH: undefined }, async () => {
        assert.equal(await pathCandidate.locate(), undefined);
    });
});

test("an install is found where the installer puts it", async () => {
    const programFiles = tempFolder();
    const exe = writeFile(path.join(programFiles, "Liasoft", "covdbg", "covdbg.exe"));
    await withEnv(
        {
            ProgramFiles: programFiles,
            "ProgramFiles(x86)": tempFolder(),
            LOCALAPPDATA: tempFolder(),
        },
        async () => {
            const installs = getRuntimeCandidates(context, settingsWith(), os.tmpdir()).filter(
                (c) => c.source === "install",
            );
            const found = await Promise.all(installs.map((c) => c.locate()));
            assert.deepEqual(found, [exe, undefined, undefined, undefined]);
        },
    );
});

test("the portable cache is searched in covdbg.portableCachePath, or in the extension's storage", async () => {
    const cache = tempFolder();
    const cached = writeFile(path.join(cache, "1.5.1", "bin", "covdbg.exe"));
    assert.equal(
        await locator("cache", { ...settingsWith(), portableCachePath: cache }).locate(),
        cached,
    );

    const storage = tempFolder();
    const storageContext = {
        globalStorageUri: { fsPath: storage },
    } as unknown as vscode.ExtensionContext;
    const fromStorage = locator("cache", settingsWith(), os.tmpdir(), storageContext);
    assert.equal(await fromStorage.locate(), undefined);
    const stored = writeFile(path.join(storage, "portable", "x", "covdbg.exe"));
    assert.equal(await fromStorage.locate(), stored);
});

test("a covdbg buried deeper than the search goes is not found", async () => {
    const cache = tempFolder();
    writeFile(path.join(cache, "1", "2", "3", "4", "5", "covdbg.exe"));
    assert.equal(
        await locator("cache", { ...settingsWith(), portableCachePath: cache }).locate(),
        undefined,
    );
});

/** An extension folder holding the bundled covdbg as the archive, with its own portable cache. */
function bundled() {
    const dir = tempFolder();
    const extension = path.join(dir, "extension");
    const zip = writeFile(path.join(extension, "assets", "portable", "covdbg-portable.zip"), "zip");
    const settings = { ...settingsWith(), portableCachePath: path.join(dir, "cache") };
    const bundledContext = {
        extensionUri: { fsPath: extension },
    } as unknown as vscode.ExtensionContext;
    const extracted = path.join(dir, "cache", "bundled");
    return { extension, zip, settings, bundledContext, extracted };
}

test("a bundled covdbg that ships unpacked is used as it is", async () => {
    const { extension, settings, bundledContext } = bundled();
    const exe = writeFile(path.join(extension, "assets", "portable", "win-x64", "covdbg.exe"));
    assert.equal(await locator("bundled", settings, os.tmpdir(), bundledContext).locate(), exe);
});

test("without a bundled archive there is no bundled covdbg", async () => {
    const { zip, settings, bundledContext } = bundled();
    fs.rmSync(zip);
    assert.equal(await resolveBundledPortable(bundledContext, settings), undefined);
});

test("the bundled archive is expanded once, and again only when it changes", async (t) => {
    const { zip, settings, bundledContext, extracted } = bundled();
    const spawned = stubSpawn((process) => {
        writeFile(path.join(extracted, "covdbg.exe"));
        process.exit(0);
    });
    t.after(spawned.restore);
    const exe = path.join(extracted, "covdbg.exe");

    assert.equal(await resolveBundledPortable(bundledContext, settings), exe);
    assert.equal(spawned.started[0].command, "powershell.exe");
    assert.match(
        spawned.started[0].args.join(" "),
        /Expand-Archive -LiteralPath '.*covdbg-portable\.zip' -DestinationPath '.*bundled' -Force/,
    );
    assert.equal(await resolveBundledPortable(bundledContext, settings), exe);
    assert.equal(spawned.started.length, 1);

    fs.writeFileSync(zip, "a newer zip");
    assert.equal(await resolveBundledPortable(bundledContext, settings), exe);
    assert.equal(spawned.started.length, 2);
});

test("a bundled archive that cannot be expanded, or holds no covdbg, gives none", async (t) => {
    const outcomes: ((process: FakeProcess) => void)[] = [
        (process) => process.exit(0),
        (process) => {
            process.stderr.emit("data", Buffer.from("Archive is corrupt.\r\n"));
            process.exit(1);
        },
        (process) => process.emit("error", new Error("spawn powershell.exe ENOENT")),
    ];
    const spawned = stubSpawn((process) => outcomes[spawned.started.indexOf(process)](process));
    t.after(spawned.restore);
    vscodeStub.window.log = [];

    for (let i = 0; i < outcomes.length; i++) {
        const { settings, bundledContext } = bundled();
        assert.equal(await resolveBundledPortable(bundledContext, settings), undefined);
    }
    const errors = vscodeStub.window.log.filter((line) => line.includes("ERROR"));
    assert.equal(errors.length, 3);
    assert.match(errors[0], /Bundled portable zip does not contain covdbg\.exe/);
    assert.match(errors[1], /Expand-Archive failed \(exit 1\): Archive is corrupt\./);
    assert.match(errors[2], /Failed to extract bundled portable: spawn powershell\.exe ENOENT/);
});

test("in a trusted local Windows window the first usable covdbg is resolved", async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    const spawned = stubSpawn((process) => {
        process.print("covdbg 1.5.1\n");
        process.exit(0);
    });
    t.after(() => {
        spawned.restore();
        Object.defineProperty(process, "platform", platform);
    });
    const exe = writeFile(path.join(tempFolder(), "covdbg.exe"));

    assert.deepEqual(await resolveCovdbgRuntime(context, settingsWith(exe), os.tmpdir()), {
        kind: "ok",
        path: exe,
        version: "1.5.1",
        source: "setting",
    });
});

test("every reason there is no covdbg reads as one sentence", () => {
    assert.match(describeRuntimeProblem({ kind: "missing" }), /1\.4\.0 or newer was not found/);
    assert.match(
        describeRuntimeProblem({ kind: "tooOld", path: "x.exe", fromSetting: true }),
        /covdbg.executablePath points at x\.exe, which did not report its version/,
    );
    assert.match(
        describeRuntimeProblem({
            kind: "tooOld",
            path: "x.exe",
            version: "1.2.0",
            fromSetting: true,
        }),
        /covdbg.executablePath points at covdbg 1\.2\.0/,
    );
    assert.match(
        describeRuntimeProblem({
            kind: "tooOld",
            path: "x.exe",
            version: "1.2.0",
            fromSetting: false,
        }),
        /^Found covdbg 1\.2\.0, but/,
    );
    assert.equal(
        describeRuntimeProblem({ kind: "unsupported", reason: "platform" }),
        "covdbg runs only on Windows.",
    );
    assert.equal(
        describeRuntimeProblem({ kind: "unsupported", reason: "remote" }),
        "covdbg runs only in a local window, not a remote one.",
    );
    assert.equal(
        describeRuntimeProblem({ kind: "unsupported", reason: "untrusted" }),
        "covdbg runs executables only in a trusted workspace.",
    );
});
