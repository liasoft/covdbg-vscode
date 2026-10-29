# Development Guide

This document covers building, testing, packaging, and releasing the covdbg VS Code extension.

## Repository Layout

- `src/` contains the extension source.
- `src/views/` contains the Coverage view, the status bar and the report.
- `scripts/` contains bundling, portable download, and release validation scripts.
- `assets/portable/` is used for the portable covdbg runtime archive during local packaging.

## Prerequisites

- Windows
- Node.js and npm
- VS Code

For full runner testing, install a covdbg runtime locally or use the bundled portable flow described below.

## Install Dependencies

```bash
npm install
```

## Build

```bash
npm run build
```

The build performs two steps:

1. `npm run prepare:portable`
2. `npm run compile`

Every build downloads a fresh `assets/portable/covdbg-portable.zip`, so the bundled covdbg is never a leftover from an earlier build.

## Development Loop

Use the standard build for a one-shot compile:

```bash
npm run build
```

Use the watch bundler when iterating on source changes:

```bash
npm run watch
```

Press `F5` in VS Code to launch the Extension Development Host.

## Local Development With Bundled covdbg

If you want the Extension Development Host to resolve the bundled `covdbg.exe` instead of relying on a system install or a manual path setting:

```bash
npm install
npm run build
```

Then start the `Run Extension` launch configuration or press `F5`.

Notes:

- The downloaded archive stays local because it is ignored by git.
- `npm run build` bundles the x64 covdbg. `node ./scripts/downloadPortable.js win32-arm64` fetches the ARM64 one instead.
- Set `COVDBG_PORTABLE_URL` to test with a different portable artifact.

## Tests And Validation

Run type checking:

```bash
npm run typecheck
```

Compile test files:

```bash
npm run compile:tests
```

Run the test suite:

```bash
npm test
```

Run the test suite with coverage:

```bash
npm run test:coverage
```

The coverage command measures every compiled extension module under `test-out/`, including those no test loads, and leaves out the tests, their helpers and the end-to-end suite. It prints a text summary and writes `coverage/lcov.info` for Codecov.

Run the end-to-end tests (Windows only, run locally, not in CI):

```bash
npm run test:e2e             # every scenario
npm run test:e2e -- signIn   # one scenario: plainFolder, firstRun or signIn
npm run test:e2e -- docsShots  # the screenshots for the covdbg.com page, light theme, 1024 × 640
```

They launch VS Code with the extension against a fresh copy of the [quick-start](https://github.com/liasoft/covdbg-quick-start) sample. That copy is built with CMake, then run with the real covdbg, so they need:

- covdbg 1.4+ on `PATH`, signed in;
- CMake with MSVC;
- quick-start checked out next to this repository (or at `COVDBG_E2E_QUICKSTART`).

The sign-in scenario uses a covdbg stand-in (`src/e2e/fakeCovdbg`), so the machine's own sign-in is never touched. Set `COVDBG_E2E_VSCODE` to an installed `Code.exe` to skip downloading VS Code into `.vscode-test/`. Scratch folders, and the screenshots under `shots`, go to `%TEMP%\covdbg-e2e`, or to `COVDBG_E2E_WORK`. The screenshots show that folder's path, so `docsShots` is best run with a short neutral one, such as `C:\e2e`.

Run linting:

```bash
npm run lint
```

## Packaging

Build the VSIXs locally:

```bash
npm run package
```

This builds two VSIXs, each bundling its own covdbg:

- `covdbg-X.Y.Z.vsix`, the universal one, with the x64 covdbg from `https://covdbg.com/download/latest/portable.zip`. The x64 covdbg measures x64 and 32-bit x86 programs.
- `covdbg-win32-arm64-X.Y.Z.vsix`, with the ARM64 covdbg from `https://covdbg.com/download/latest/portable-arm64.zip`. Only the ARM64 covdbg measures ARM64 programs.

The Marketplace serves the win32-arm64 VSIX on Windows on ARM and the universal one everywhere else. Each package downloads its covdbg afresh and, on Windows, checks that it reports `covdbgBundledVersion` and is built for the right architecture.

To build one of them, name its target: `npm run package -- win32-arm64`. `COVDBG_PORTABLE_URL` replaces the download for every target being packaged, so name one target when you set it.

## Release Process

Create and push a Git tag in the form `vX.Y.Z` that matches the version in `package.json`.

```bash
git tag v1.0.0
git push origin v1.0.0
```

The release workflow then:

- validates that the tag matches `package.json`
- installs dependencies
- runs lint and tests
- packages the universal and the win32-arm64 VSIX, each with its own portable covdbg, and checks each covdbg's version and architecture
- publishes both VSIXs to the VS Code Marketplace
- creates a GitHub Release and uploads both `.vsix` files plus `SHA256SUMS.txt`

Before using the workflow for a real release, configure this repository secret:

- `VSCE_PAT`: Azure DevOps Personal Access Token for the Marketplace publisher in `package.json`, created with `Organization: All accessible organizations` and `Marketplace: Manage` scope.

Marketplace prerequisites:

- the `publisher` field in `package.json` must already exist in the Visual Studio Marketplace
- the PAT must belong to an account that can publish for that publisher

Once the secret is present, a `vX.Y.Z` tag will both publish the extension to the VS Code Marketplace and attach the same VSIXs to the GitHub release.

Use this check locally, on Windows, before tagging:

```bash
npm run build
npm run release:check -- vX.Y.Z
```

It fails unless the VS Code engine matches `@types/vscode`, the bundled covdbg reports `covdbgBundledVersion` from `package.json`, the tag matches the package version, and `CHANGELOG.md` has a dated section for that version.

## Notes

- Coverage viewing works independently from coverage execution.
- Coverage execution requires covdbg 1.4 or newer, and a sign-in or a project token for the license service.
- Repository-facing end-user documentation belongs in `README.md`; contributor workflow documentation belongs in this file.
