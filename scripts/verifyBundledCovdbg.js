const { execFileSync } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const ZIP_PATH = path.join(__dirname, "..", "assets", "portable", "covdbg-portable.zip");

// The PE machine type each VSIX target must bundle.
const MACHINES = {
    universal: { name: "x64", value: 0x8664 },
    "win32-arm64": { name: "ARM64", value: 0xaa64 },
};

async function main() {
    const target = process.argv[2] || "universal";
    const machine = MACHINES[target];
    if (!machine) {
        throw new Error(
            `Unknown target ${target}; expected one of ${Object.keys(MACHINES).join(", ")}.`,
        );
    }

    const packageJsonPath = path.join(__dirname, "..", "package.json");
    const expected = JSON.parse(await fs.readFile(packageJsonPath, "utf8")).covdbgBundledVersion;
    if (typeof expected !== "string" || expected.length === 0) {
        throw new Error("package.json does not contain covdbgBundledVersion.");
    }

    const extractPath = await fs.mkdtemp(path.join(os.tmpdir(), "covdbg-bundled-"));
    try {
        execFileSync("powershell.exe", [
            "-NoLogo",
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${ZIP_PATH}' -DestinationPath '${extractPath}' -Force`,
        ]);
        const exe = (await fs.readdir(extractPath, { recursive: true })).find(
            (entry) => path.basename(entry).toLowerCase() === "covdbg.exe",
        );
        if (!exe) {
            throw new Error(`${ZIP_PATH} does not contain covdbg.exe.`);
        }
        const exePath = path.join(extractPath, exe);

        const actualMachine = readPeMachine(await fs.readFile(exePath));
        if (actualMachine !== machine.value) {
            throw new Error(
                `The bundled covdbg is built for machine 0x${actualMachine.toString(16)}, but the ${target} VSIX needs ${machine.name}.`,
            );
        }

        // Read from the version resource rather than running covdbg, so an ARM64 build can be
        // checked on an x64 machine.
        const actual = execFileSync(
            "powershell.exe",
            [
                "-NoLogo",
                "-NoProfile",
                "-Command",
                `(Get-Item -LiteralPath '${exePath}').VersionInfo.ProductVersion`,
            ],
            { encoding: "utf8" },
        ).trim();
        if (actual !== expected) {
            throw new Error(
                `The bundled covdbg reports ${actual || "no version"}, but covdbgBundledVersion is ${expected}.`,
            );
        }
        console.log(`The bundled covdbg is ${machine.name} ${actual}, as expected for ${target}.`);
    } finally {
        await fs.rm(extractPath, { recursive: true, force: true });
    }
}

function readPeMachine(image) {
    const peOffset = image.readUInt32LE(0x3c);
    if (image.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0") {
        throw new Error("The bundled covdbg.exe is not a PE image.");
    }
    return image.readUInt16LE(peOffset + 4);
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
});
