const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");

// The universal VSIX bundles the x64 covdbg, which also measures 32-bit x86 programs. Only the
// ARM64 covdbg measures ARM64 programs, so the win32-arm64 VSIX bundles that one.
const PORTABLE_URLS = {
    universal: "https://covdbg.com/download/latest/portable.zip",
    "win32-arm64": "https://covdbg.com/download/latest/portable-arm64.zip",
};
const OUTPUT_PATH = path.join(__dirname, "..", "assets", "portable", "covdbg-portable.zip");
const REDIRECT_LIMIT = 5;

async function main() {
    const target = process.argv[2] || "universal";
    if (!Object.hasOwn(PORTABLE_URLS, target)) {
        throw new Error(
            `Unknown target ${target}; expected one of ${Object.keys(PORTABLE_URLS).join(", ")}.`,
        );
    }
    const downloadUrl = process.env.COVDBG_PORTABLE_URL || PORTABLE_URLS[target];

    // Always downloaded: an archive left over from an earlier build could be any covdbg at all.
    await fsp.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });

    const tempPath = `${OUTPUT_PATH}.download`;
    await safeUnlink(tempPath);

    console.log(`Downloading the ${target} portable runtime from ${downloadUrl}`);
    try {
        await downloadToFile(downloadUrl, tempPath, REDIRECT_LIMIT);
        const { size } = await fsp.stat(tempPath);
        if (size === 0) {
            throw new Error("Downloaded archive is empty.");
        }

        await fsp.rename(tempPath, OUTPUT_PATH);
        console.log(`Portable runtime saved to ${OUTPUT_PATH}`);
    } catch (error) {
        await safeUnlink(tempPath);
        throw error;
    }
}

async function safeUnlink(filePath) {
    try {
        await fsp.unlink(filePath);
    } catch {
        // Ignore missing temp files.
    }
}

function downloadToFile(urlString, destinationPath, redirectsRemaining) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const transport = url.protocol === "https:" ? https : http;

        const request = transport.get(url, (response) => {
            const statusCode = response.statusCode || 0;

            if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                response.resume();

                if (redirectsRemaining <= 0) {
                    reject(new Error("Too many redirects while downloading portable runtime."));
                    return;
                }

                const redirectUrl = new URL(response.headers.location, url).toString();
                downloadToFile(redirectUrl, destinationPath, redirectsRemaining - 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`Portable download failed with HTTP ${statusCode}.`));
                return;
            }

            const file = fs.createWriteStream(destinationPath);
            response.pipe(file);

            file.on("finish", () => {
                file.close(resolve);
            });

            file.on("error", (error) => {
                file.close(() => reject(error));
            });

            response.on("error", (error) => {
                file.close(() => reject(error));
            });
        });

        request.on("error", reject);
    });
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to prepare portable runtime: ${message}`);
    process.exitCode = 1;
});
