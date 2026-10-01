---
name: repaper-init
description: Initialize a local paper directory for re:paper, adopt existing LaTeX sources and historical experiment evidence, and maintain AGENTS.md entry points for manuscript, experiment, and submission work. Use when linking or refreshing a paper workspace.
metadata:
  version: "1.4.0"
---

# Initialize a re:paper workspace

Work in the paper folder selected by the user. Inspect its contents before making changes. The `repaper` CLI is available in re:paper sessions; outside the app, use the sibling `repaper-experiments/scripts/repaper.cjs` with Node.js or pass `--paper <folder>` to an installed launcher.

Initialization is idempotent even when the project marker already exists. Use `repaper init` to refresh the generated instructions as well as to prepare a new project.

## Generated AGENTS.md guidance

After initialization, confirm that the managed section gives future sessions these task entry points:

- Manuscript: read and edit the active sources in `.paper/`, starting at `manuscript.tex` and following included files, bibliography, and figures. Use the Git repository inside `.paper/` for manuscript versions. `repaper-init` handles source adoption; routine manuscript edits use file tools or a writing skill available in that session.
- Experiments: use `repaper-experiments` to inspect current records with `repaper list experiments --json` and `repaper show <group>/<experiment> --json`, then maintain them through the experiment and run CLI commands.
- Submissions: use `repaper-submissions`, start with `repaper submission timeline --json`, and read complete events and sources with `repaper submission show <submission-id> --json`. Add or update attempts and events through the CLI, retain original review wording and ratings, and check the actual submitted manuscript version.

The managed section describes supported interfaces and storage locations; mutable manuscript text, results, and submission history stay in their own stores. Refresh only the re:paper block and preserve other instructions. If an older launcher cannot generate these entry points, update the installed re:paper Skills and CLI from the app's settings and rerun initialization; report the limitation if that update is unavailable.

## Empty folder

Treat a folder with no research content as empty even if it has `.git` or an existing `AGENTS.md`. Run `repaper init --paper <folder>`. This creates `.repaper/project.json`, the experiment store, and an idempotent re:paper section in `AGENTS.md`. Stop there: do not create `.paper/`, a manuscript template, experiment groups, or synthetic runs. The user can start writing or experimenting later.

## Existing research folder

1. Run `repaper init --paper <folder>` so the project marker exists and `AGENTS.md` contains re:paper guidance. The command preserves other instructions already in that file. If `CLAUDE.md` already exists, its managed re:paper block is updated too; initialization does not create it in an empty directory. Never replace an existing instruction file wholesale.
2. Inspect manuscript candidates and their references. Prefer an explicit final or newest version marker, then dated names or Git history, then file modification time. Choose the latest complete, editable LaTeX source tree; a compiled PDF alone is not editable source. Explain the chosen version briefly in the final report. If `.paper/manuscript.tex` already exists, keep it and do not import over it. Otherwise run `repaper writing import <path-to-selected-main.tex> --paper <folder>`. This copies the selected main file and nearby LaTeX sources and assets into `.paper/`, names the active entry `manuscript.tex`, and initializes its Git history. Original files stay in place. If no LaTeX source exists, leave `.paper/` absent and report the format limitation; do not invent a manuscript or silently choose an older source.
3. Find existing evaluation results, tables, logs, and descriptions in the folder. Relate each evidence file to its actual objective and condition. Use `repaper group ensure` and `repaper experiment ensure` for those groups and experiments, then `repaper run import <group>/<experiment> --source <existing-file> --summary <what-the-file-supports>` for each distinct historical result. Repeat `--source` to keep related files together and add `--metric name=value` only after checking the file. The CLI reads top-level numeric values from JSON evidence, records source paths and file times, labels the entry as historical, and avoids duplicates for unchanged evidence. Inspect old fields as raw records; publish a complete, evidence-backed overview with `repaper experiment overview <group>/<experiment> --file <JSON>` using the `repaper-experiments` skill. Keep progress and operational notes out of Results and Conclusion. Revise the overview as more runs or sources are collected; do not mechanically rename old fields. Do not execute old experiment commands just to populate history, infer success from a filename, or record a metric without an inspectable source.
4. Inspect `repaper status --json` and the writing and experiment directories. Report the adopted manuscript, imported evidence, and any unresolved source or provenance gaps.

Use the `repaper-experiments` skill for subsequent experiment execution and updates.
