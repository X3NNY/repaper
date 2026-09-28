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
  '- Use the `repaper-init` skill when adopting existing manuscript sources or historical results. Import old evidence with `repaper run import`; initialization must not rerun experiments or present imported evidence as a new execution.',
  endMarker
].join('\n')

export async function ensureProjectInstructions(root: string): Promise<void> {
  const path = join(root, 'AGENTS.md')
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('AGENTS.md 必须是普通文件。')
  let existing = ''
  try { existing = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const newline = existing.includes('\r\n') ? '\r\n' : '\n'
  const block = instructions.replaceAll('\n', newline)
  const start = existing.indexOf(startMarker)
  const end = existing.indexOf(endMarker)
  if ((start < 0) !== (end < 0) || end < start || existing.indexOf(startMarker, start + startMarker.length) >= 0 || existing.indexOf(endMarker, end + endMarker.length) >= 0) {
    throw new Error('AGENTS.md 中的 re:paper 标记不完整或重复，请先检查。')
  }
  const next = start >= 0
    ? `${existing.slice(0, start)}${block}${existing.slice(end + endMarker.length)}`
    : `${existing}${existing && !existing.endsWith(`${newline}${newline}`) ? existing.endsWith(newline) ? newline : `${newline}${newline}` : ''}${block}${newline}`
  if (next !== existing) await writeFile(path, next, 'utf8')
}
