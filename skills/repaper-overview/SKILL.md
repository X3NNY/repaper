---
name: repaper-overview
description: Read and maintain a re:paper project's research journey, claims, evidence, decisions, stopped routes, and submission-driven revisions. Use when organizing the overview or explaining how a paper's ideas and conclusions evolved.
metadata:
  version: "1.5.0"
---

# re:paper research journey

Work in the selected paper folder. The app supplies `repaper` in Agent terminals. Outside the app, use the installed sibling `repaper-experiments/scripts/repaper.cjs` with Node.js and `--paper <folder>`.

## Read the current context

Run `repaper overview context --json`. It returns the current `revision`, `nodes`, `edges`, `notes`, `edits`, `recordImportance`, `sources`, `sourceFingerprints`, and `changedSourceIds`. It also includes project metadata last collected by the overview page. `repaper overview show --json` reads the journey for ordinary questions.

Facts have stable IDs such as `experiment:<group>/<key>`, `experiment-revision:<id>:<revision-id>`, `run:<run-id>`, `submission:<id>`, `event:<id>`, `review:<event-id>:<review-id>`, `manuscript:<commit>`, and `note:<note-id>`. Facts remain owned by their experiment, writing, submission, or note interfaces. A source target locates the relevant record and version. Read source content before drawing a connection; source excerpts are an index, not a replacement for full materials.

Read `.paper/manuscript.tex` and its included sources for current claims. Inspect the internal Git history and specific submitted commits when chronology matters. Use `repaper-experiments` and `repaper-submissions` for their complete records. Review sources preserve original text and scores; keep AI interpretation in journey summaries. `source.path` in submission records is relative to `.repaper/submissions/`. Images in overview notes live at `.repaper/overview/<image.path>`: open the actual image. Read the actual page body for pasted links; an inaccessible URL is not evidence of its content.

The current index does not include complete historical Agent conversations. Use supplied notes, files, and pasted conversation excerpts; do not invent missing research motivations. Dates describe actual occurrence. Unknown occurrence dates stay empty; import or recording timestamps are separate.

## Organize useful research content

Extract questions, scoped claims, key findings, decisions, routes, and plans. Keep titles short and summaries concrete. For a change of direction, record `before`, `after`, `reason`, and the sources that establish the change. Distinguish experimental findings from the author's decision about what to do next.

Relationships have explicit meaning: `supports`, `limits`, `challenges`, `responds`, `motivates`, `supersedes`, `tests`, `contains`, `submitted`, or `revises`. Every semantic node and relationship needs source IDs. Temporal proximity does not establish causation. When motivation is absent, retain the facts in temporal order without a `motivates` edge. A negative result in tested settings does not disprove a method everywhere.

Use `parentId` for branches; avoid cycles. Retain stopped routes and superseded claims with their earlier evidence. Mark future work `planned` and avoid describing planned evaluations as findings. Main items explain the paper's reasoning or current submission and revision; group repeated runs and ordinary commits into detail records. Do not hide meaningful negative findings, failed directions, or unresolved review challenges. `recordImportance` can place fact IDs in `main` or `detail`; user `edits` take precedence.

On subsequent requests, read changed sources and related context, and update the existing stable IDs. A wording change is not a new milestone. A changed claim should keep its predecessor with a `supersedes` relationship. Preserve user notes and edits; do not recreate the whole graph or change original business records as part of overview organization.

## Publish incrementally

Write a JSON draft inside the paper folder, then run:

```text
repaper overview publish --file <draft.json>
```

The draft schema is:

```json
{
  "expectedRevision": 0,
  "sourceFingerprints": { "<read-source-id>": "<fingerprint-from-context>" },
  "summary": {
    "question": "",
    "claim": "",
    "scope": "",
    "next": "",
    "sourceIds": ["<read-source-id>"]
  },
  "nodes": [{
    "id": "decision-budget",
    "kind": "decision",
    "title": "",
    "summary": "",
    "occurredAt": "",
    "status": "current",
    "importance": "main",
    "before": "",
    "after": "",
    "reason": "",
    "parentId": "",
    "sourceIds": ["<read-source-id>"]
  }],
  "edges": [{
    "id": "evidence-to-decision",
    "from": "<fact-or-semantic-node-id>",
    "to": "decision-budget",
    "relation": "motivates",
    "sourceIds": ["<source-establishing-this-relationship>"]
  }],
  "recordImportance": { "<fact-source-id>": "detail" }
}
```

Node `kind`: `question`, `claim`, `finding`, `decision`, `route`, `experiment`, `manuscript`, `submission`, `review`, `note`, or `plan`. Status: `current`, `superseded`, `stopped`, or `planned`. Importance: `main` or `detail`. Use ISO dates or empty strings. Node titles cannot be empty. Node IDs must differ from fact IDs. Summary, nodes, edges, and recordImportance are optional; omit fields that do not need updating.

Copy the current revision and fingerprints of the sources actually inspected. Publishing upserts by ID, snapshots source content and targets, retains previous journey revisions, and preserves user overrides. New source or revision conflicts require rereading and merging; never substitute a new fingerprint without checking the changed material. `removeNodeIds` and `removeEdgeIds` are explicit removal lists for duplicates or incorrect derived items; preserve historical reasoning and do not remove nodes with user edits.

## Record thinking

Save author-supplied notes with `repaper overview note --text <original-text> [--date YYYY-MM-DD]`. The app also accepts pasted images and links. To supplement a note, use `repaper overview note --file <note.json> --id <note-id>` with `text`, `occurredAt`, and the note's `revision` as `expectedRevision`. Keep original user text intact when adding material. OCR transcriptions can be recorded separately with their image note ID identified in the text; mark unreadable characters rather than guessing.

Overview work organizes existing research. Launching experiments, submitting a manuscript, contacting people, or editing unrelated files requires the corresponding user request. Finish by identifying the organized main thread and concrete source gaps.
