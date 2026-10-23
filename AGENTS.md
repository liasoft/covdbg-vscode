# Project guidance for Codex

Read [DEVELOPMENT.md](./DEVELOPMENT.md) before working in this checkout. It describes the contributor workflow; [README.md](./README.md) describes end-user behavior. Keep contributor documentation in DEVELOPMENT.md and user-facing documentation in README.md.

## Project layout

- This is the TypeScript covdbg VS Code extension for native Windows C++ coverage.
- `src/` contains extension code, including `src/runner/`, `src/mcp/`, `src/views/`, and `src/test/`.
- `scripts/` contains bundling, portable runtime download, and release validation scripts.
- `out/`, `test-out/`, and `coverage/` are generated outputs. The portable runtime archive lives in `assets/portable/`.
- Before editing a subdirectory, read any applicable nested AGENTS.md, AGENTS.override.md, or CLAUDE.md instructions.

## Development and validation

Use the Node.js version in `.nvmrc` and npm scripts in `package.json` as the source of truth. Follow `.editorconfig`, `.prettierrc.json`, and `eslint.config.cjs` for style.

- Install dependencies with `npm ci`.
- `npm run compile` checks VS Code manifest versions, typechecks, and bundles the extension.
- `npm run build` additionally prepares the portable runtime, downloading a fresh portable archive on every build.
- `npm run watch` runs the watch bundler; F5 launches the VS Code Extension Development Host.
- For code changes, run relevant checks: `npm run typecheck`, `npm run lint`, and `npm test`. The test lifecycle compiles the extension and tests automatically.
- `npm run test:coverage` runs tests with coverage; `npm run format:check` checks formatting.
- PR validation also checks VS Code manifest versions, builds, and packages with `npm run package`. See `.github/workflows/pr.yml` for the full workflow.

Coverage viewing is independent of coverage execution. Full runner testing requires Windows and the covdbg runtime and license flow described in DEVELOPMENT.md.
