---
name: repaper-init
description: Initialize a local paper directory for re:paper, including adoption of existing LaTeX sources and historical experiment evidence. Use when a user links a new or populated research folder to re:paper, not for ordinary experiment runs.
metadata:
  version: "1.3.0"
---

# Initialize a re:paper workspace

Work in the paper folder selected by the user. Inspect its contents before making changes. The `repaper` CLI is available in re:paper sessions; outside the app, use the sibling `repaper-experiments/scripts/repaper.cjs` with Node.js or pass `--paper <folder>` to an installed launcher.

## Empty folder

Treat a folder with no research content as empty even if it has `.git` or an existing `AGENTS.md`. Run `repaper init --paper <folder>`. This creates `.repaper/project.json`, the experiment store, and an idempotent re:paper section in `AGENTS.md`. Stop there: do not create `.paper/`, a manuscript template, experiment groups, or synthetic runs. The user can start writing or experimenting later.

## Existing research folder

1. Run `repaper init --paper <folder>` so the project marker exists and `AGENTS.md` contains re:paper guidance. The command preserves other instructions already in that file. Never replace an existing `AGENTS.md` wholesale.
2. Inspect manuscript candidates and their references. Prefer an explicit final or newest version marker, then dated names or Git history, then file modification time. Choose the latest complete, editable LaTeX source tree; a compiled PDF alone is not editable source. Explain the chosen version briefly in the final report. If `.paper/manuscript.tex` already exists, keep it and do not import over it. Otherwise run `repaper writing import <path-to-selected-main.tex> --paper <folder>`. This copies the selected main file and nearby LaTeX sources and assets into `.paper/`, names the active entry `manuscript.tex`, and initializes its Git history. Original files stay in place. If no LaTeX source exists, leave `.paper/` absent and report the format limitation; do not invent a manuscript or silently choose an older source.
3. Find existing evaluation results, tables, logs, and descriptions in the folder. Relate each evidence file to its actual objective and condition. Use `repaper group ensure` and `repaper experiment ensure` for those groups and experiments, then `repaper run import <group>/<experiment> --source <existing-file> --summary <what-the-file-supports>` for each distinct historical result. Repeat `--source` to keep related files together and add `--metric name=value` only after checking the file. The CLI reads top-level numeric values from JSON evidence, records source paths and file times, labels the entry as historical, and avoids duplicates for unchanged evidence. Inspect old fields as raw records; publish a complete, evidence-backed overview with `repaper experiment overview <group>/<experiment> --file <JSON>` using the `repaper-experiments` skill. Keep progress and operational notes out of Results and Conclusion. Revise the overview as more runs or sources are collected; do not mechanically rename old fields. Do not execute old experiment commands just to populate history, infer success from a filename, or record a metric without an inspectable source.
4. Inspect `repaper status --json` and the writing and experiment directories. Report the adopted manuscript, imported evidence, and any unresolved source or provenance gaps.

Use the `repaper-experiments` skill for subsequent experiment execution and updates.
