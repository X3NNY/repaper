import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const startMarker = '<!-- repaper:start -->'
const endMarker = '<!-- repaper:end -->'

const instructions = [
  startMarker,
  '## re:paper workspace',
  '',
  '- Run `repaper init` to prepare this project. It maintains this section of AGENTS.md without changing other instructions.',
  '- Read the relevant skill before using it. Run the commands below from the paper folder, or pass `--paper <folder>` when working elsewhere. Outside the app, an installed `repaper-experiments/scripts/repaper.cjs` can also be run with Node.js.',
  '- Fetch current content from source files or the CLI when the task needs it. This file describes the interfaces; manuscript text, experiment results, and submission history belong in their own stores.',
  '',
  '### Read or edit the manuscript',
  '',
  '- Read and edit the active LaTeX sources directly in `.paper/` with file tools or a manuscript-writing skill available in the session. Read `.paper/.repaper-writing.json` when present to find the `mainFile` selected from a custom template; otherwise start at `.paper/manuscript.tex`. Follow included TeX files, bibliography, and figures from the active main file. Save changes to those active sources so the writing page can display them.',
  '- Manuscript versions use the Git repository inside `.paper/`: inspect `git -C .paper log --oneline` and `git -C .paper diff`. Read a known version with `git -C .paper show <commit>:<main-file>`, using the main file configuration and referenced files at that version. `.paper/.build/` contains generated output.',
  '- Use `repaper-init` when adopting existing manuscript sources or historical results. Import a selected LaTeX main file with `repaper writing import <main.tex>`; keep original drafts and assets. Empty initialization only prepares the project and instructions; create a manuscript when writing is requested.',
  '',
  '### Read or maintain experiments',
  '',
  '- Use `repaper-experiments` for experiment questions, executions, and record updates. Read `repaper list experiments --json`, then `repaper show <group>/<experiment> --json`; inspect runs with `repaper list runs --json` and `repaper show <run-id> --log` when needed.',
  '- Create or update records with `repaper group ensure`, `repaper experiment ensure`, `repaper experiment update`, and `repaper experiment overview <group>/<experiment> --file <draft.json>`. Record new executions with `repaper run <group>/<experiment> -- <program> [args]`; import existing evidence with `repaper run import`. Keep design reasons, key settings, results, and conclusions grounded in the linked runs and source files.',
  '- Experiment importance is important/normal. Read the current importance object with `repaper show <group>/<experiment> --json`; missing importance has revision 0. Agent updates use `repaper experiment importance <group>/<experiment> important|normal --by agent --expected-revision <revision> --reason <paper-specific basis>`. Preserve manual marks, including manual normal; do not use --by manual as an Agent. Importance reflects the role in the paper, including decisive negative findings, and does not replace evidence.',
  '- Experiment records live in `.repaper/experiments/`. Use the CLI to maintain IDs and overview history. Initialization imports historical evidence without rerunning it or presenting it as a new execution.',
  '',
  '### Read or maintain submissions',
  '',
  '- Use `repaper-submissions` to read, compare, add, or update submission attempts, reviews, editorial decisions, rebuttals, and revisions.',
  '- Before discussing submission strategy, review history, or a venue change, run `repaper submission timeline --json` for a compact, current timeline. It links attempts with `previousSubmissionId`; use `repaper submission show <submission-id> --json` to read one attempt\'s complete events, reviews, and source IDs.',
  '- When advice depends on manuscript content, check that attempt\'s `versionLabel` or `gitCommit`. Read the matching `.paper/` Git version if available; otherwise read the configured active main file in `.paper/` and state that it may differ from the submitted version.',
  '- Write a draft JSON in the paper folder and save it with `repaper submission create --file <draft.json>`, `repaper submission update <submission-id> --file <draft.json>`, or `repaper submission event <submission-id> --file <event.json>`. To supplement an existing event, use its `--id <event-id>` and current `revision` as `expectedRevision`; reread and merge after a conflict.',
  '- Submission records and original evidence live in `.repaper/submissions/`. A `source.path` from the CLI is relative to that directory. Read the linked source before citing a review or score; keep reviewer text and ratings verbatim, and keep AI interpretation in event-level `summary`.',
  '- Actual submitted PDFs, sources from a fixed manuscript Git commit, and supplements can be archived through the submission page. Read `repaper submission snapshots <submission-id> --json` and `repaper submission snapshot <snapshot-id> --json`; manifest paths are relative to `.repaper/submissions/snapshots/<snapshot-id>/`. Treat these archives as immutable submission evidence. A snapshot PDF is user-selected and its correspondence to the source commit is not automatically verified; do not assume the current working PDF was submitted.',
  '- Maintain experiment and submission record JSON through the CLI. Older submission entries shown only in the app must be brought into the new timeline with “继续记录” before the CLI can read them.',
  '',
  '### Read or maintain the research journey',
  '',
  '- Use `repaper-overview` for the overview, research reasoning, claims and evidence, stopped routes, and submission-driven revisions. Start with `repaper overview context --json`; it provides the current revision, source IDs and fingerprints, changed records, saved thinking, and manual overrides. Read the referenced manuscripts, experiment evidence, and original reviews when needed.',
  '- Record author thinking with `repaper overview note --text <original-text> [--date YYYY-MM-DD]`. To update a note use `repaper overview note --file <note.json> --id <note-id>` and its revision as `expectedRevision`. A recorded decision can establish motivation; chronological proximity cannot.',
  '- Save incremental, sourced research nodes and relationships with `repaper overview publish --file <draft.json>`. Include the latest `expectedRevision`, inspected `sourceFingerprints`, and node/edge `sourceIds`; reread and merge on conflicts. Keep plans distinct from completed results, preserve earlier claims, negative findings and stopped routes, and retain manual edits.',
  '- Journey records and note materials live in `.repaper/overview/`. Use the CLI to preserve revisions and source snapshots. Original experiment and submission records remain in their own stores; a journey summary never replaces review wording or ratings. The context index does not automatically recover complete historical Agent conversations.',
  endMarker
].join('\n')

async function ensureManagedInstructions(path: string, blockText: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`${path} 必须是普通文件。`)
  let existing = ''
  try { existing = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const newline = existing.includes('\r\n') ? '\r\n' : '\n'
  const block = blockText.replaceAll('\n', newline)
  const start = existing.indexOf(startMarker)
  const end = existing.indexOf(endMarker)
  if ((start < 0) !== (end < 0) || end < start || existing.indexOf(startMarker, start + startMarker.length) >= 0 || existing.indexOf(endMarker, end + endMarker.length) >= 0) {
    throw new Error(`${path} 中的 re:paper 标记不完整或重复，请先检查。`)
  }
  const next = start >= 0
    ? `${existing.slice(0, start)}${block}${existing.slice(end + endMarker.length)}`
    : `${existing}${existing && !existing.endsWith(`${newline}${newline}`) ? existing.endsWith(newline) ? newline : `${newline}${newline}` : ''}${block}${newline}`
  if (next !== existing) await writeFile(path, next, 'utf8')
}

export async function ensureProjectInstructions(root: string): Promise<void> {
  await ensureManagedInstructions(join(root, 'AGENTS.md'), instructions)
  const claudePath = join(root, 'CLAUDE.md')
  const existingClaude = await lstat(claudePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existingClaude) await ensureManagedInstructions(claudePath, instructions.replace('this section of AGENTS.md', 'this section of CLAUDE.md'))
}
