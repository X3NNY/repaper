# Repository Guidelines

## Project Structure & Module Organization

- `src/`: React renderer, components, styles, and public SVG branding assets.
- `electron/main/`: filesystem operations, AI sessions, terminals, and writing services; `electron/preload/` exposes the renderer bridge.
- `shared/`: types and logic shared across application layers; `cli/`: experiment-management CLI.
- `tests/`: CLI tests and Electron UI smoke scripts.
- `scripts/`: packaging checks, icon generation, and release tooling. `build/` holds packaging assets; `docs/` contains documentation; `skills/` contains the bundled Agent Skill.
- `out/` and `dist/`: generated build output; do not edit or commit them.

## Build, Test, and Development Commands

Use Node.js 22.12+ and install dependencies with `npm ci`.

- `npm run dev`: build the CLI and launch Electron with development tooling.
- `npm run typecheck`: check main-process and renderer TypeScript.
- `npm run build`: typecheck and compile the CLI, main process, preload, and renderer.
- `npm run test:experiments`: build the CLI and run Node's built-in test runner.
- `npm run pack`: generate an unpacked application; follow with `npm run test:package` to verify its CLI and native terminal.
- `npm run dist`: build installers for the host platform; see `docs/releases.md` for architecture options.
- `npm run icons`: regenerate application icons from the SVG branding assets.

## Coding Style & Naming Conventions

Follow existing TypeScript/React style: two-space indentation, single quotes, and no trailing semicolons. Keep strict typing; use PascalCase for React components and camelCase for functions and variables. Tooling scripts use CommonJS `.cjs`. No ESLint or Prettier configuration is currently provided. Keep privileged operations in the main process and expose narrow preload APIs.

## Testing Guidelines

Name automated tests `*.test.cjs` and UI probes `*-smoke.cjs`. After building, run relevant UI checks through Electron, for example `npx electron tests/window-layout-smoke.cjs`. Use isolated fixtures and user-data directories. No numeric coverage threshold is configured; cover changed behavior and regression risks. Packaging changes require native package checks on affected platforms.

## Commit & Pull Request Guidelines

History uses prefixes such as `feat:`, `fix:`, and `docs:` with concise imperative summaries. Keep commits focused. PRs should describe changes, link relevant issues, list verification commands and results, and include screenshots for UI changes. Identify platform-specific limitations.

## Security & Release Configuration

Never commit research data in `.paper/` or `.repaper/`, credentials, or signing certificates. Preserve unrelated working-tree changes. Release tags must match `package.json`; tag builds create drafts. Never overwrite publicly released binaries or move published tags.
