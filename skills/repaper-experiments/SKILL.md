---
name: repaper-experiments
description: Record and maintain experiments for a re:paper project while running research code. Use when a paper workspace has .repaper/project.json and work involves evaluations, benchmarks, ablations, or result comparisons.
metadata:
  version: "1.3.0"
---

# re:paper experiments

Keep the project's experiment page accurate while doing research work. The CLI writes local records; the desktop app reads those files. Use the project's existing Codex or Claude Code session for the actual work.

## CLI

Run `repaper` in a re:paper session. If it is unavailable outside the app, run the installed skill's `scripts/repaper.cjs` with Node.js. `repaper status` shows the current project; `repaper help` lists options. For code outside the paper folder, use `--paper <paper-folder>` or set `REPAPER_ROOT`.

Before creating records, inspect `repaper status` and `repaper list experiments`. Use stable lowercase keys for groups and experiments. `ensure` updates an existing record with the same key.

Create a group for a shared objective and one experiment per meaningful comparison, ablation, dataset, or search. Repeat executions belong to that experiment as separate runs. Keep the experiment overview useful to a reader of the paper:

- Title and one-line subtitle: identify the experiment and its question.
- Design reason: explain why this comparison or search matters, what changes, and what stays comparable. Do not paste operational notes here.
- Key settings: select roughly 3–6 decisive settings such as data range, module count, search interval, or controlled parameters. Keep full configurations in their source files and run records.
- Results: show only findings supported by inspected files and completed runs. Use one to three short paragraphs for a simple outcome, a table for comparisons, or a PNG/JPEG/WebP/GIF figure for trends. Mark incomplete evidence as preliminary.
- Conclusion: in one to three sentences, explain what this experiment contributes to the paper and what remains uncertain. Revise it when later runs change the evidence.

```text
repaper group ensure benchmark --title "跨数据集评测" --goal "检验泛化能力" --metric accuracy:max
repaper experiment ensure benchmark/data-a --title "A 数据集" --subtitle "检验 A 上是否优于基线" --design "在同一训练预算下比较方法与基线的泛化表现" --setting "数据集=A" --setting "训练预算=140 轮" --setting "主指标=accuracy"
repaper run benchmark/data-a --label "A 数据集 · seed 1" --metrics results/a.json --artifact results/a.json -- python eval.py --dataset A
```

Use `repaper run ... -- <program> [args]` for meaningful experiment executions. It streams output and records the command, timestamps, exit status, Git snapshot, log, and linked session. Prefer a structured JSON metrics file with top-level numeric values. For commands with shell syntax or several steps, put the steps in a script and wrap that script. A launch command that merely queues a remote job does not prove the job completed; inspect its finished output before reporting success.

After reviewing the evidence, add a short factual run summary with `repaper run annotate <run-id> --summary "..."`. If needed, use `--metric name=value --source <result-file-or-log>` and `--artifact <path>`. A run's exit code only describes process execution; inspect its outputs before making a research claim. Keep launch progress and operational constraints out of Results and Conclusion.

The experiment page displays only a published overview. Old `question`, `description`, `factor`, `result`, and `conclusion` remain under a collapsed 原始记录 section; they are not promoted to findings by renaming them. After a finished run changes the evidence, publish a coherent revision containing the current key settings, all still-supported results, their run IDs, and a newly considered conclusion. Revisions are preserved locally; `repaper experiment revisions <group>/<experiment>` lists them. A new run alone does not erase an older valid result.

For a short update, use `repaper experiment update <group>/<experiment> --paragraph "..." --source-run <run-id> --conclusion "..."`. Repeat `--paragraph` for several short paragraphs supported by the same run IDs. This replaces the displayed results. If results change and `--conclusion` is omitted, the previous published conclusion is cleared so the page cannot combine new results with an old interpretation. Changing key settings after results exist requires a complete overview update.

For a complete update, write a JSON object in the paper folder and run `repaper experiment overview <group>/<experiment> --file <path>`. Include all five fields, even when a result or conclusion is still empty. For tables, figures, or paragraphs with different evidence sources, use result blocks such as:

```json
{
  "subtitle": "Does the method exceed the baseline on A?",
  "designReason": "Compare both methods under the same training budget and data split.",
  "keySettings": [{"label":"Data","value":"A"},{"label":"Budget","value":"140 epochs"}],
  "results": [
    {"type":"table","title":"Main comparison","columns":["Method","Accuracy"],"rows":[["Baseline","0.81"],["Ours","0.84"]],"sourceRunIds":["r_example"]},
    {"type":"figure","title":"Parameter sweep","path":"figures/sweep.png","caption":"Accuracy over the search range.","sourceRunIds":["r_example"]}
  ],
  "conclusion": "The comparison supports the paper's claim on A; other datasets remain untested."
}
```

Replace `r_example` with real completed run IDs, use project-relative image paths, and verify every displayed value. Every published result block must cite at least one completed or imported run; import historical files first when needed. A conclusion requires such a result. When older records only have legacy fields, inspect their source files and runs before publishing the first overview. If the final evaluation has not run, leave `results` empty or limit it to evidence that has actually completed, and leave `conclusion` empty when no paper-level inference is supported.

Use `repaper show <id> --json` and `repaper show <run-id> --log` to inspect records. Records are stored under `.repaper/experiments/` in the paper folder. Avoid editing those JSON files directly; use the CLI so IDs and history stay consistent.

For results produced before re:paper was used, follow the `repaper-init` skill and use `repaper run import` to label them as historical evidence. Do not rerun experiments solely to fill the record.
