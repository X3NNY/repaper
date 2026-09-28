---
name: repaper-experiments
description: Record and maintain experiments for a re:paper project while running research code. Use when a paper workspace has .repaper/project.json and work involves evaluations, benchmarks, ablations, or result comparisons.
metadata:
  version: "1.0.0"
---

# re:paper experiments

Keep the project's experiment page accurate while doing research work. The CLI writes local records; the desktop app reads those files. Use the project's existing Codex or Claude Code session for the actual work.

## CLI

Run `repaper` in a re:paper session. If it is unavailable outside the app, run the installed skill's `scripts/repaper.cjs` with Node.js. `repaper status` shows the current project; `repaper help` lists options. For code outside the paper folder, use `--paper <paper-folder>` or set `REPAPER_ROOT`.

Before creating records, inspect `repaper status` and `repaper list experiments`. Use stable lowercase keys for groups and experiments. `ensure` updates an existing record with the same key.

Create a group for a shared experimental objective, and one experiment per meaningful condition such as a dataset, baseline, or ablation. Repeat executions belong to that experiment as separate runs. Keep descriptions about the question and changed condition; summarize observed results only after evidence exists.

```text
repaper group ensure benchmark --title "跨数据集评测" --goal "检验泛化能力" --metric accuracy:max
repaper experiment ensure benchmark/data-a --title "A 数据集" --question "是否优于基线？" --factor "dataset=A"
repaper run benchmark/data-a --metrics results/a.json --artifact results/a.json -- python eval.py --dataset A
```

Use `repaper run ... -- <program> [args]` for meaningful experiment executions. It streams output and records the command, timestamps, exit status, Git snapshot, log, and linked session. Prefer a structured JSON metrics file with top-level numeric values. For commands with shell syntax or several steps, put the steps in a script and wrap that script. A launch command that merely queues a remote job does not prove the job completed; inspect its finished output before reporting success.

After reviewing the evidence, add a short factual run summary with `repaper run annotate <run-id> --summary "..."`. If needed, use `--metric name=value --source <result-file-or-log>` and `--artifact <path>`. Then update the experiment's synthesis with `repaper experiment update <group>/<experiment> --result "..." --conclusion "..."`. Distinguish observed numbers from interpretation; do not invent metrics or treat a failed run as a positive result.

Use `repaper show <id> --json` and `repaper show <run-id> --log` to inspect records. Records are stored under `.repaper/experiments/` in the paper folder. Avoid editing those JSON files directly; use the CLI so IDs and history stay consistent.
