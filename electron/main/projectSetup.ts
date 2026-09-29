import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const startMarker = '<!-- repaper:start -->'
const endMarker = '<!-- repaper:end -->'

const instructions = [
  startMarker,
  '## re:paper workspace',
  '',
  '- Run `repaper init` to prepare this project. It maintains this section of AGENTS.md without changing other instructions.',
  '- The active LaTeX manuscript belongs in `.paper/`; its entry file is `.paper/manuscript.tex`. Keep original drafts and assets when adopting an existing project.',
  '- Experiment records live in `.repaper/experiments/`. Use the `repaper-experiments` skill and `repaper` CLI to maintain them; do not edit record JSON by hand.',
  '- Before discussing submission strategy, review history, or a venue change, run `repaper submission timeline --json` for a compact, current timeline. It links attempts with `previousSubmissionId`; use `repaper submission show <submission-id> --json` to read one attempt\'s complete events, reviews, and source IDs.',
  '- When advice depends on manuscript content, check that attempt\'s `versionLabel` or `gitCommit`. Read the matching `.paper/` Git version if available; otherwise read `.paper/manuscript.tex` and state that it may differ from the submitted version.',
  '- Submission records and original evidence live in `.repaper/submissions/`. A `source.path` from the CLI is relative to that directory. Read the linked source before citing a review or score; keep reviewer text and ratings verbatim, and keep AI interpretation in event-level `summary`.',
  '- Use the `repaper-submissions` skill and `repaper submission` CLI to add or update records; do not edit record JSON by hand. Older submission entries shown only in the app must be brought into the new timeline with “继续记录” before the CLI can read them.',
  '- Use the `repaper-init` skill when adopting existing manuscript sources or historical results. Import old evidence with `repaper run import`; initialization must not rerun experiments or present imported evidence as a new execution.',
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
