/**
 * End-to-end tests: real VS Code, the real extension, real covdbg runs against a copy of the
 * quick-start sample. Sign-in goes through a covdbg stand-in (src/e2e/fakeCovdbg) so the tests
 * never touch the machine's own sign-in; every run it is asked for goes to the real covdbg.
 *
 *   npm run test:e2e              all scenarios
 *   npm run test:e2e -- signIn    one scenario
 *   npm run test:e2e -- realSignIn  signs the machine out, then in through app.covdbg.com
 *
 * Needs Windows, covdbg 1.4+ on PATH (signed in), CMake with MSVC, git, and the quick-start sample
 * next to this repo (or COVDBG_E2E_QUICKSTART).
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

const repoRoot = path.resolve(__dirname, "..", "..");
const work = path.join(os.tmpdir(), "covdbg-e2e");
const quickStart = process.env.COVDBG_E2E_QUICKSTART ?? path.resolve(repoRoot, "..", "quick-start");

function run(file: string, args: string[], cwd?: string): string {
    return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function realCovdbg(): string {
    return run("where.exe", ["covdbg"]).split(/\r?\n/)[0].trim();
}

function buildFakeCovdbg(): string {
    const build = path.join(work, "fake-build");
    run("cmake", ["-S", path.join(repoRoot, "src", "e2e", "fakeCovdbg"), "-B", build]);
    run("cmake", ["--build", build, "--config", "Release"]);
    return path.join(build, "Release", "covdbg.exe");
}

/**
 * quick-start with its git history (covdbg licenses by repository, and quick-start's is public)
 * but without its .covdbg.yaml or a coverage database of an earlier run, built fresh so the debug
 * info names the copy's sources.
 */
function prepareQuickStart(name: string, settings: Record<string, unknown>): string {
    const folder = path.join(work, name);
    fs.rmSync(folder, { recursive: true, force: true });
    fs.cpSync(quickStart, folder, {
        recursive: true,
        filter: (source) => !["build", ".covdbg"].includes(path.basename(source)),
    });
    fs.rmSync(path.join(folder, ".covdbg.yaml"), { force: true });
    run("cmake", ["-S", folder, "-B", path.join(folder, "build")]);
    run("cmake", ["--build", path.join(folder, "build"), "--config", "Debug"]);
    writeSettings(folder, settings);
    return folder;
}

function preparePlainFolder(name: string): string {
    const folder = path.join(work, name);
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "package.json"), '{ "name": "not-cpp" }\n');
    fs.writeFileSync(path.join(folder, "index.js"), "console.log('hello');\n");
    return folder;
}

function writeSettings(folder: string, settings: Record<string, unknown>): void {
    fs.mkdirSync(path.join(folder, ".vscode"), { recursive: true });
    fs.writeFileSync(
        path.join(folder, ".vscode", "settings.json"),
        JSON.stringify(settings, null, 4),
    );
}

/**
 * The window opens on an empty folder, so nothing activates the extension before the test's spies
 * are in; the test then swaps `folder` in, which activates it the way opening that folder would.
 * The folder to swap in reaches the test as COVDBG_E2E_FOLDER.
 */
function prepareWorkspaceFile(name: string): string {
    const empty = path.join(work, "empty");
    fs.mkdirSync(empty, { recursive: true });
    const file = path.join(work, `${name}.code-workspace`);
    fs.writeFileSync(file, JSON.stringify({ folders: [{ path: empty }] }, null, 4));
    return file;
}

interface Scenario {
    name: string;
    /** The folder the scenario opens, or, when `swapIn`, swaps in after the spies are installed. */
    folder: () => string;
    swapIn?: boolean;
    env?: Record<string, string>;
    /** Runs only when named: it changes the machine's own covdbg sign-in. */
    onlyByName?: boolean;
}

async function main(): Promise<void> {
    fs.mkdirSync(work, { recursive: true });
    const real = realCovdbg();
    const fake = buildFakeCovdbg();
    const fakeState = path.join(work, "fake-state");

    const scenarios: Scenario[] = [
        { name: "plainFolder", folder: () => preparePlainFolder("plain") },
        { name: "firstRun", folder: () => prepareQuickStart("first-run", {}), swapIn: true },
        {
            name: "signIn",
            folder: () => prepareQuickStart("sign-in", { "covdbg.executablePath": fake }),
            swapIn: true,
            env: { FAKE_COVDBG_STATE: fakeState, FAKE_COVDBG_REAL: real },
        },
        {
            name: "realSignIn",
            folder: () => prepareQuickStart("real-sign-in", {}),
            swapIn: true,
            env: { COVDBG_E2E_SIGN_IN_URL: path.join(work, "sign-in-url.txt") },
            onlyByName: true,
        },
    ];

    const only = process.argv.slice(2);
    const vscodeExecutablePath = process.env.COVDBG_E2E_VSCODE;
    let failed = 0;
    for (const scenario of scenarios.filter((s) =>
        only.length === 0 ? !s.onlyByName : only.includes(s.name),
    )) {
        console.log(`\n=== ${scenario.name} ===`);
        fs.rmSync(fakeState, { recursive: true, force: true });
        const profile = path.join(work, "profile", scenario.name);
        fs.rmSync(profile, { recursive: true, force: true });
        const folder = scenario.folder();
        try {
            await runTests({
                vscodeExecutablePath,
                extensionDevelopmentPath: repoRoot,
                extensionTestsPath: path.join(__dirname, "suite", scenario.name),
                extensionTestsEnv: {
                    ...scenario.env,
                    COVDBG_E2E_REAL: real,
                    COVDBG_E2E_FOLDER: folder,
                    COVDBG_E2E_SHOTS: path.join(work, "shots"),
                },
                launchArgs: [
                    scenario.swapIn ? prepareWorkspaceFile(scenario.name) : folder,
                    "--disable-workspace-trust",
                    "--skip-welcome",
                    "--skip-release-notes",
                    `--user-data-dir=${path.join(profile, "data")}`,
                    `--extensions-dir=${path.join(profile, "extensions")}`,
                ],
            });
        } catch (error) {
            failed++;
            console.error(`${scenario.name} failed: ${String(error)}`);
        }
    }
    if (failed > 0) {
        process.exitCode = 1;
    }
}

void main();
