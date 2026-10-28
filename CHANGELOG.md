# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased]

### Changed

- The bundled portable covdbg is 1.5.1. Its coverage databases (schema version 9) show in the editor like earlier ones.

### Fixed

- With covdbg 1.5.1, the Coverage view no longer shows how the test program exited (`test_app.exe exited with code 0`) as a warning after every run. That line, and the reason a run measured nothing, stay in the covdbg output log.

## [1.1.0] - 2026-10-24

### Changed

- The bundled portable covdbg is 1.5.0. covdbg 1.4 is still the oldest version the extension drives.
- On Windows on ARM, the extension now bundles the native ARM64 covdbg, so it measures ARM64 test programs without a separate covdbg install. It ships as its own win32-arm64 package, which VS Code picks on its own; everywhere else the extension still bundles the x64 covdbg.

## [1.0.1] - 2026-10-09

### Fixed

- The repository moved to `liasoft/covdbg-vscode`. The README, the Marketplace page and the package links point there, and the demo animation on the Marketplace page loads again.

## [1.0.0] - 2026-10-08

### Breaking

- Requires covdbg 1.4 or newer. Older versions are no longer used, and an older covdbg named by
  `covdbg.executablePath` is reported as too old instead of being run. covdbg 1.4.0 carries the
  team-scoped sign-in (`covdbg login --team`, `covdbg whoami --json`) that the editor shows as
  `Signed in as <email> for <team>`. The bundled portable covdbg is 1.4.0.
- The `covdbg.runner.licenseServerUrl` and `covdbg.runner.appDataPath` settings are removed.
  covdbg 1.4 has neither a license server to point at nor an app-data option, and rejects runs
  that pass them.
- `COVDBG_LICENSE*` variables and the 30-day demo license are no longer used. Runs are licensed by
  the machine's sign-in or by `COVDBG_PROJECT_TOKEN` in `covdbg.runner.env`.

### Added

- The Coverage view and the output log show the account and the team a sign-in is for, for example
  `Signed in as a@acme.com for Acme`. The extension reads them from `covdbg whoami --json` and the
  `covdbg login` line.
- Sign-in from the editor. **covdbg: Sign In** opens the browser with the code to confirm, and
  pressing ▶ while signed out signs in first and then continues the same run. **covdbg: Sign Out**
  ends the session. The sign-in is the one `covdbg login` uses, so an existing one is picked up.
- What the license service says about a run is shown once per run: a refused run, a new personal
  lock, gated reporting or a sign-in that has ended, each with the action that helps.
- **Choose Executable…** picks the test executables ▶ runs, from the discovered ones or any other
  through Browse…. The choice is remembered for the workspace.
- One-click re-run: ▶ runs the last chosen executables, or the only discovered one, without asking.
- A run in a folder without `.covdbg.yaml` offers, once, to create a starter config and run.
- covdbg's MCP server is offered to VS Code through `contributes.mcpServerDefinitionProviders`, so
  AI agents can run coverage, inspect uncovered code, query a coverage database and merge results.
  It is offered only where a run could succeed: Windows, a trusted local workspace and covdbg 1.4
  or newer. Runs with no output path of their own write where `covdbg.runner.outputPath` points,
  so their results load into the editor.
- Coverage databases written by something other than this extension are now noticed. A watcher per
  workspace folder over the discovery glob picks up a `.covdb` that has never been loaded, which
  previously went unseen until the window was reloaded.

### Changed

- The setting and view texts no longer promise a free tier or seats the editor cannot see or choose.
  Teams, seats and the personal lock are managed at app.covdbg.com.
- An installed covdbg is preferred over the bundled one: the `covdbg.executablePath` setting, then
  `PATH`, then the known install folders (now including `%LOCALAPPDATA%\Programs\Liasoft\covdbg`),
  and only then the bundled portable copy.
- The Coverage view replaces the webview dashboard. It shows the coverage summary, the files with
  the lowest coverage, the last run's notice and who is signed in, and says what is missing before
  the first run. The status bar shows the line coverage, a spinner while running, or a sign-in
  prompt when a run needs one, and is hidden otherwise.
- Silent startup: no toasts, no notification progress and no Output panel. Problems with a
  `.covdb` loaded on its own show in the Coverage view; run problems go to Test Results, with a
  Show Log button.
- Narrower activation: the extension starts only in workspaces with `.covdbg.yaml`, `.covdb`,
  `CMakeLists.txt`, `.sln` or `.vcxproj` files, or when VS Code asks for its MCP server.
- `covdbg.runner.binaryDiscoveryPattern` now also finds MSBuild `x64` and CLion `cmake-build-*`
  trees, and `covdbg.runner.binaryDiscoveryExcludePattern` skips Release and RelWithDebInfo trees
  by default, so optimized binaries are not offered beside the debug ones.
- `covdbg.runner.outputPath` is empty by default and means covdbg's own default,
  `.covdbg/coverage.covdb` under the run's working directory.
- covdbg keeps its logs in `.covdbg` under the run's working directory, and **Open covdbg.log**
  follows that.
- The starter `.covdbg.yaml` names no source files, so covdbg counts every file the debug
  information names, less the Windows SDK, the MSVC toolchain and runtime sources and vendored
  dependencies.
- Reloads triggered by a coverage database changing on disk are debounced, so a file still being
  written is no longer read as a malformed database or an empty index.
- Bundled portable runtime updated to covdbg 1.3.0.

### Fixed

- Runs against covdbg 1.3 failed with `program: File does not exist`, because the extension passed
  arguments covdbg 1.3 no longer accepts.
- A folder opened by its short 8.3 name (for example under `%TEMP%`) showed no coverage after a
  successful run, because every file was taken for one outside the workspace.

### Removed

- The four language-model tools (`covdbg_run`, `covdbg_explore`, `covdbg_files`, `covdbg_code`).
  The MCP server replaces them, and it works with any MCP client rather than only VS Code chat.
- The **covdbg: Get Uncovered Code** command. It returned a result that was never rendered, so
  running it from the palette did nothing visible.
- The dashboard commands: **Refresh** replaces the dashboard and test-binary refresh commands,
  **Load .covdb…** now offers the discovered databases, and **Open AppData Folder** is gone.

## [0.8.1] - 2026-06-08

### Removed

- Proactive "No `.covdbg.yaml` found in this workspace. Create one now?" prompt. It appeared in any workspace without a config — including immediately after deleting one — and was intrusive in projects that do not use covdbg. Create a starter config on demand with the **covdbg: Create .covdbg.yaml** command or the sidebar entry instead.

## [0.8.0] - 2026-04-25

### Changed

- Active `.covdb` files now reload from event-driven file watchers instead of timestamp polling, and external changes are deferred until coverage workflows are idle so background refreshes do not interfere with active test execution.
- Bundled portable runtime updated to embedded `covdbg` 1.2.0.
- Removed the deprecated VS Code-side analyze-inputs workflow and related settings now that covdbg can resolve analysis directly from `.conf` / `.covdbg.yaml` configuration.

## [0.7.0] - 2026-04-15

### Added

- Optional `covdbg.runner.binaryDiscoveryExcludePattern` setting so projects can hide copied or post-build duplicated test executables from Testing API discovery.
- Optional `covdbg.runner.analyzeInputs` setting so VS Code coverage runs can build baseline symbol `.covdb` files with `covdbg analyze` and merge them into the active workspace result.
- Optional `covdbg.runner.analyzeInputsByTarget` setting so different test executables can choose different analyze baselines or opt out of baseline analysis entirely.

### Changed

- Test binary discovery now refreshes from explicit Testing API resolve/refresh flows instead of filesystem watchers.
- Discovered test binary search now applies user exclude globs after the include glob, so excluded paths win even when they still match `covdbg.runner.binaryDiscoveryPattern`.
- Coverage finalization now also runs for single-executable workflows when baseline analyze inputs are configured, so the final `.covdb` can include uncovered lines from application binaries.


## [0.6.0] - 2026-04-14

### Added

- AI/chat tool integration for `exploreUncoveredFiles_covdbg`, exposing the active workspace coverage summary and the highest-priority uncovered files without requiring a `.covdb` path.
- Batched coverage runs for `runTestWithCoverage_covdbg`, allowing multiple real test executables to be run in one workflow and merged into a single active workspace coverage result.
- Richer uncovered-code payload metadata, including file identity details and reusable coverage summaries for downstream chat workflows.

### Changed

- Tool guidance for coverage exploration and reruns now assumes the extension-managed active workspace coverage result instead of asking chat clients to thread `.covdb` paths through each step.
- Sidebar onboarding now refreshes immediately when `.covdbg.yaml` files are created, updated, or deleted, and surfaces an explicit runtime-checking state while the active workspace is still being resolved.

### Fixed

- Deleting a `.covdbg.yaml` file now clears matching stale `covdbg.runner.configPath` settings automatically.
- Sidebar quick actions no longer appear blocked while covdbg runtime detection is still in progress.

## [0.5.0] - 2026-04-09

### Added

- AI/chat tool integration for `getUncoveredCode_covdbg`, exposing grouped uncovered segments, surrounding context, truncation metadata, and LLM guidance from native `.covdb` coverage data.
- AI/chat tool integration for `runTestWithCoverage_covdbg`, allowing an LLM to trigger a coverage run for a chosen executable and reload coverage results into the extension.
- LLM-oriented guidance in tool responses so iterative fix, rebuild, re-run, and re-query workflows can be chained from chat.

### Changed

- Uncovered code responses now cap segment volume, truncate oversized snippets, and round `coveragePercent` to two decimals for more stable chat payloads.

### Fixed

- Coverage decorations and uncovered-code queries now suppress stale results when the source file is dirty or newer than the loaded `.covdb` snapshot.

## [0.4.0] - 2026-04-09

### Added

- Always-on startup activation so the covdbg status bar entry is available immediately after VS Code finishes starting.
- In-product setup flow and command for creating a starter `.covdbg.yaml` in the selected workspace folder.
- Coverage key matching regression tests for ambiguous multi-workspace file paths.

### Changed

- Workspace discovery now searches `.covdbg.yaml` and `.covdb` files per workspace folder in multi-root workspaces.
- Runner and test executable resolution now honor workspace-folder scoped settings instead of always binding to the first workspace folder.
- Coverage loading, caching, invalidation, report state, and editor rendering are now tracked per workspace folder so duplicated project layouts do not share coverage overlays.

### Fixed

- Coverage rendering no longer cross-applies results between similarly named files such as duplicated `src/main.cpp` files opened from different workspace folders.

## [0.3.0] - 2026-04-09

### Added

- Pull request validation workflow for changes targeting `main`, covering lint, build, automated tests, and VSIX artifact upload.
- Release automation now publishes the generated VSIX to the VS Code Marketplace when the `VSCE_PAT` secret is configured.

### Changed

- Local F5 development now uses a one-shot build flow that prepares the bundled portable `covdbg` archive when it is missing.
- Release automation now serializes runs per tag and explicitly validates lint, build, and tests before packaging the VSIX.

## [0.2.0] - 2026-03-18

### Added

- Apache License 2.0 metadata and repository license file.
- Clear licensing documentation for the open-source VS Code extension and the separately licensed proprietary `covdbg` runtime.
- Build-time download of the portable `covdbg` runtime for packaging instead of storing the ZIP in the repository.
- Tag-based GitHub Actions release workflow for building the VSIX and publishing GitHub Release assets.
- Release tag validation script to enforce `vX.Y.Z` tags matching `package.json`.

### Changed

- VSIX packaging now prepares the bundled portable runtime automatically.
- Release packaging now includes a reproducible CI/CD path with checksum generation.

### Fixed

- Repository packaging no longer depends on a checked-in `assets/portable/covdbg-portable.zip`.

## [0.1.0]

### Added

- Initial extension development baseline.
- Coverage viewer integration for `.covdb` files.
- Inline coverage decorations, report views, status bar integration, and basic runner support.
