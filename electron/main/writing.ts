import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  LatexEngine, WritingChange, WritingChangeSummary, WritingCompileResult, WritingFile, WritingHistoryEntry,
  WritingReviewFile, WritingTemplate, WritingWorkspace
} from '../../shared/writing'

const execFileAsync = promisify(execFile)
const editableExtensions = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md', '.json', '.yaml', '.yml'])
const dependencyExtensions = new Set(['.bib', '.bst', '.sty', '.cls', '.bbx', '.cbx'])
const importExtensions = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.tikz', '.pgf', '.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg', '.csv', '.dat', '.txt'])
const importIgnoredDirectories = new Set(['.git', '.paper', '.repaper', '.build', 'node_modules', '.venv', '__pycache__'])
const maxTextBytes = 5 * 1024 * 1024
const maxPdfBytes = 50 * 1024 * 1024
const maxLogBytes = 256 * 1024

async function statOrNull(path: string) {
  try { return await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function rootFor(folderPath: string): string {
  return join(folderPath, '.paper')
}

async function existingRoot(folderPath: string): Promise<string | null> {
  const root = rootFor(folderPath)
  const info = await statOrNull(root)
  if (!info) return null
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('.paper 必须是普通文件夹。')
  return root
}

async function requireRoot(folderPath: string): Promise<string> {
  const root = await existingRoot(folderPath)
  if (!root) throw new Error('请先创建写作目录。')
  return root
}

async function sourcePath(root: string, relativePath: string, mustExist = true): Promise<string> {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 512 || isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error('文件路径无效。')
  }
  const segments = relativePath.replace(/\\/g, '/').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git' || segment.toLowerCase() === '.build')) {
    throw new Error('文件路径无效。')
  }
  const target = resolve(root, ...segments)
  if (!target.startsWith(`${root}${sep}`)) throw new Error('文件必须位于 .paper 目录内。')
  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index])
    const info = await statOrNull(current)
    if (info?.isSymbolicLink()) throw new Error('不能通过符号链接访问写作文件。')
    if (index < segments.length - 1 && !info?.isDirectory()) throw new Error('上级文件夹不存在。')
    if (index === segments.length - 1 && mustExist && !info?.isFile()) throw new Error('文件不存在。')
    if (index === segments.length - 1 && !mustExist && info) throw new Error('同名文件已存在。')
  }
  return target
}

async function listTree(root: string, directory = root, prefix = '', depth = 0, limit = { count: 0 }): Promise<WritingFile[]> {
  if (depth > 10 || limit.count >= 600) return []
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name, 'zh-CN'))
  const files: WritingFile[] = []
  for (const entry of entries) {
    if (limit.count >= 600) break
    if (entry.name === '.git' || entry.name === '.build' || entry.isSymbolicLink()) continue
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      limit.count += 1
      files.push({ path, name: entry.name, kind: 'directory', children: await listTree(root, join(directory, entry.name), path, depth + 1, limit) })
    } else if (entry.isFile()) {
      limit.count += 1
      files.push({ path, name: entry.name, kind: 'file' })
    }
  }
  return files
}

function templateFiles(template: WritingTemplate): Record<string, string> {
  if (template === 'blank') return {
    'manuscript.tex': String.raw`\documentclass{article}

\begin{document}
\null

\end{document}
`
  }
  const options = template === 'ieee-single' ? '12pt,onecolumn,draftclsnofoot' : 'journal'
  return {
    'manuscript.tex': String.raw`\documentclass[${options}]{IEEEtran}
\usepackage{cite}
\usepackage{graphicx}

\begin{document}

\title{Your Paper Title}
\author{Author Name}
\maketitle

\begin{abstract}
Write the abstract here.
\end{abstract}

\begin{IEEEkeywords}
keyword one, keyword two
\end{IEEEkeywords}

\section{Introduction}
Start writing here.

% \bibliographystyle{IEEEtran}
% \bibliography{references}

\end{document}
`,
    'references.bib': ''
  }
}

async function command(executable: string, args: string[], cwd: string, timeout = 120_000): Promise<string> {
  try {
    const result = await execFileAsync(executable, args, {
      cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8'
    })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    const detail = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.slice(-6000)
    throw new Error(detail || failure.message)
  }
}

async function git(root: string, args: string[]): Promise<string> {
  return command('git', args, root, 30_000)
}

function parseNumstat(output: string, changes: Map<string, Pick<WritingChange, 'additions' | 'deletions' | 'binary'>>): void {
  for (const record of output.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record)
    if (!match) continue
    const previous = changes.get(match[3])
    changes.set(match[3], {
      additions: (previous?.additions ?? 0) + (Number(match[1]) || 0),
      deletions: (previous?.deletions ?? 0) + (Number(match[2]) || 0),
      binary: previous?.binary === true || match[1] === '-' || match[2] === '-'
    })
  }
}

async function untrackedStats(root: string, relativePath: string): Promise<Pick<WritingChange, 'additions' | 'deletions' | 'binary'>> {
  const target = join(root, relativePath)
  const info = await statOrNull(target)
  if (!info?.isFile() || info.size > maxTextBytes) return { additions: 0, deletions: 0, binary: true }
  const data = await readFile(target)
  if (data.includes(0)) return { additions: 0, deletions: 0, binary: true }
  try { new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { return { additions: 0, deletions: 0, binary: true } }
  let lines = 0
  for (const byte of data) if (byte === 10) lines += 1
  if (data.length && data[data.length - 1] !== 10) lines += 1
  return { additions: lines, deletions: 0, binary: false }
}

function reviewablePath(path: string): boolean {
  if (!path || path.length > 512 || isAbsolute(path) || path.includes('\0')) return false
  return path.replace(/\\/g, '/').split('/').every((segment) => segment && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git' && segment.toLowerCase() !== '.build')
}

function textOrNull(data: Buffer): string | null {
  if (data.length > maxTextBytes || data.includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n/g, '\n') }
  catch { return null }
}

async function hasGit(root: string): Promise<boolean> {
  return (await statOrNull(join(root, '.git'))) !== null
}

async function initGit(root: string): Promise<void> {
  if (!await hasGit(root)) await git(root, ['init', '--quiet'])
  const excludePath = resolve(root, (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).trim())
  await mkdir(dirname(excludePath), { recursive: true })
  const existing = await readFile(excludePath, 'utf8').catch(() => '')
  if (!existing.includes('.build/')) await writeFile(excludePath, `${existing}\n.build/\n`, 'utf8')
}

async function allSourcePaths(root: string, directory = root, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.build' || entry.isSymbolicLink()) continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) paths.push(...await allSourcePaths(root, join(directory, entry.name), relative))
    else if (entry.isFile()) paths.push(relative)
  }
  return paths
}

async function dependencyState(root: string, engine: LatexEngine): Promise<{ fingerprint: string; hasBib: boolean }> {
  const paths = await allSourcePaths(root)
  paths.sort()
  const hash = createHash('sha256').update(engine)
  let hasBib = false
  for (const relative of paths) {
    const extension = extname(relative).toLowerCase()
    if (dependencyExtensions.has(extension)) {
      hash.update(relative)
      hash.update(await readFile(join(root, relative)))
    }
    if (extension === '.tex') {
      const source = await readFile(join(root, relative), 'utf8')
      const uncommented = source.split(/\r?\n/).map((line) => line.replace(/(?<!\\)%.*/, '')).join('\n')
      if (/\\bibliography\s*\{/.test(uncommented)) hasBib = true
      const references = uncommented.match(/\\(?:cite\w*|nocite|bibliography|bibliographystyle|documentclass|usepackage|input|include|label|ref|pageref|eqref)\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g)
      if (references?.length) hash.update(relative).update(references.join('\n'))
    }
  }
  return { fingerprint: hash.digest('hex'), hasBib }
}

export class WritingWorkspaceManager {
  private saves = new Map<string, Promise<void>>()
  private compiles = new Map<string, Promise<WritingCompileResult>>()

  async getState(folderPath: string): Promise<WritingWorkspace> {
    const rootPath = rootFor(folderPath)
    const root = await existingRoot(folderPath)
    if (!root) return { initialized: false, rootPath, gitReady: false, files: [], pdfAvailable: false }
    const files = await listTree(root)
    return {
      initialized: files.length > 0,
      rootPath,
      gitReady: await hasGit(root),
      files,
      pdfAvailable: (await statOrNull(join(root, '.build', 'manuscript.pdf')))?.isFile() === true
    }
  }

  async initialize(folderPath: string, template: WritingTemplate): Promise<WritingWorkspace> {
    if (template !== 'blank' && template !== 'ieee-single' && template !== 'ieee-double') throw new Error('未知的写作模板。')
    await command('git', ['--version'], folderPath, 10_000)
    const root = rootFor(folderPath)
    const existing = await existingRoot(folderPath)
    if (existing && (await listTree(root)).length) throw new Error('写作目录已存在，请直接打开。')
    if (!existing) await mkdir(root)
    await initGit(root)
    for (const [name, content] of Object.entries(templateFiles(template))) {
      await writeFile(join(root, name), content, { encoding: 'utf8', flag: 'wx' })
    }
    return this.getState(folderPath)
  }

  async importSource(folderPath: string, mainFile: string): Promise<WritingWorkspace> {
    const project = await realpath(folderPath)
    const main = await realpath(mainFile)
    const sourceRelative = relative(project, main)
    if (!sourceRelative || sourceRelative === '..' || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative) || sourceRelative.split(sep).some((segment) => segment.toLowerCase() === '.paper')) {
      throw new Error('LaTeX 主文件必须位于论文工作目录内、.paper/ 外。')
    }
    if (extname(main).toLowerCase() !== '.tex' || !(await stat(main)).isFile()) throw new Error('请选择一个 LaTeX 主文件。')
    const root = rootFor(folderPath)
    const existing = await existingRoot(folderPath)
    if (existing && (await readdir(root)).some((name) => name !== '.git' && name !== '.build')) {
      throw new Error('写作目录已有文件，请直接使用或先手动整理。')
    }
    await command('git', ['--version'], folderPath, 10_000)

    const sourceDirectory = dirname(main)
    const files: { source: string; path: string; size: number }[] = []
    let totalBytes = 0
    const collect = async (directory: string, prefix = '', depth = 0): Promise<void> => {
      if (depth > 12) throw new Error('LaTeX 源目录层级过深，请选择更小的源目录。')
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          if (!extname(entry.name) || importExtensions.has(extname(entry.name).toLowerCase())) {
            throw new Error(`LaTeX 源目录引用了符号链接，请先整理源文件：${join(prefix, entry.name)}`)
          }
          continue
        }
        if (entry.isDirectory()) {
          if (!importIgnoredDirectories.has(entry.name)) await collect(join(directory, entry.name), join(prefix, entry.name), depth + 1)
        } else if (entry.isFile() && importExtensions.has(extname(entry.name).toLowerCase())) {
          const source = join(directory, entry.name)
          const path = join(prefix, entry.name)
          const size = (await stat(source)).size
          files.push({ source, path, size })
          totalBytes += size
          if (files.length > 2000 || totalBytes > 250 * 1024 * 1024) {
            throw new Error('LaTeX 源目录过大，请选择更小的源目录。')
          }
        }
      }
    }
    await collect(sourceDirectory)
    if (!files.some((file) => file.source === main)) throw new Error('未找到所选 LaTeX 主文件。')
    if (files.some((file) => file.path === 'manuscript.tex' && file.source !== main)) {
      throw new Error('源目录中已有另一份 manuscript.tex，请先确定要采用的版本。')
    }
    for (const file of files) {
      if (await statOrNull(join(root, file.path))) throw new Error(`写作目录中已有同名文件：${file.path}`)
    }
    if (await statOrNull(join(root, 'manuscript.tex'))) throw new Error('写作目录中已有 manuscript.tex。')
    await mkdir(root, { recursive: true })
    for (const file of files) {
      const target = join(root, file.path)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(file.source, target, constants.COPYFILE_EXCL)
    }
    if (main !== join(sourceDirectory, 'manuscript.tex')) {
      await copyFile(main, join(root, 'manuscript.tex'), constants.COPYFILE_EXCL)
    }
    await initGit(root)
    return this.getState(folderPath)
  }

  async ensureGit(folderPath: string): Promise<WritingWorkspace> {
    const root = await requireRoot(folderPath)
    await initGit(root)
    return this.getState(folderPath)
  }

  async readSource(folderPath: string, relativePath: string): Promise<string> {
    const root = await requireRoot(folderPath)
    const target = await sourcePath(root, relativePath)
    if (!editableExtensions.has(extname(target).toLowerCase())) throw new Error('这个文件不能在编辑器中打开。')
    const info = await stat(target)
    if (info.size > maxTextBytes) throw new Error('文件过大，无法在编辑器中打开。')
    return readFile(target, 'utf8')
  }

  async saveSource(folderPath: string, relativePath: string, content: string): Promise<void> {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > maxTextBytes) throw new Error('文件内容过大。')
    const root = await requireRoot(folderPath)
    const target = await sourcePath(root, relativePath)
    if (!editableExtensions.has(extname(target).toLowerCase())) throw new Error('这个文件不能在编辑器中修改。')
    const previous = this.saves.get(target) ?? Promise.resolve()
    const pending = previous.catch(() => undefined).then(() => writeFile(target, content, 'utf8'))
    this.saves.set(target, pending)
    try { await pending }
    finally { if (this.saves.get(target) === pending) this.saves.delete(target) }
  }

  async createSource(folderPath: string, relativePath: string): Promise<WritingWorkspace> {
    const root = await requireRoot(folderPath)
    const target = await sourcePath(root, relativePath, false)
    if (!editableExtensions.has(extname(target).toLowerCase())) throw new Error('只能新建 TeX、BibTeX 或文本文件。')
    await writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
    return this.getState(folderPath)
  }

  async readPdf(folderPath: string): Promise<Uint8Array> {
    const root = await requireRoot(folderPath)
    const target = join(root, '.build', 'manuscript.pdf')
    const info = await stat(target)
    if (!info.isFile() || info.size > maxPdfBytes) throw new Error('PDF 文件不存在或过大。')
    return new Uint8Array(await readFile(target))
  }

  async readCompileLog(folderPath: string): Promise<string | null> {
    const root = await requireRoot(folderPath)
    for (const name of ['last-compile.log', 'manuscript.log']) {
      const target = join(root, '.build', name)
      const info = await statOrNull(target)
      if (info?.isFile()) return (await readFile(target, 'utf8')).slice(-maxLogBytes)
    }
    return null
  }

  async compile(folderPath: string, engine: LatexEngine): Promise<WritingCompileResult> {
    if (engine !== 'pdflatex' && engine !== 'xelatex') throw new Error('未知的 TeX 编译器。')
    const root = await requireRoot(folderPath)
    const existing = this.compiles.get(root)
    if (existing) return existing
    const running = this.compileNow(root, engine)
    this.compiles.set(root, running)
    try { return await running }
    finally { if (this.compiles.get(root) === running) this.compiles.delete(root) }
  }

  private async compileNow(root: string, engine: LatexEngine): Promise<WritingCompileResult> {
    const steps: string[] = []
    const logs: string[] = []
    let mode: 'quick' | 'full' = 'full'
    try {
      await sourcePath(root, 'manuscript.tex')
      await mkdir(join(root, '.build'), { recursive: true })
      const dependency = await dependencyState(root, engine)
      const previous = await readFile(join(root, '.build', 'compile-state.json'), 'utf8').then((value) => JSON.parse(value) as { fingerprint?: string; hasBib?: boolean }).catch(() => null)
      const pdfExists = (await statOrNull(join(root, '.build', 'manuscript.pdf')))?.isFile() === true
      mode = pdfExists && previous?.fingerprint === dependency.fingerprint && previous.hasBib === dependency.hasBib ? 'quick' : 'full'
      const latexArgs = ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', '-output-directory=.build', 'manuscript.tex']
      const runLatex = async () => { steps.push(engine); logs.push(await command(engine, latexArgs, root)) }
      await runLatex()
      if (mode === 'full') {
        if (dependency.hasBib) {
          steps.push('bibtex')
          logs.push(await command('bibtex', ['.build/manuscript'], root))
        }
        await runLatex()
        if (dependency.hasBib) await runLatex()
      }
      if (!(await statOrNull(join(root, '.build', 'manuscript.pdf')))?.isFile() || logs.some((log) => log.includes('No pages of output.'))) {
        throw new Error('TeX 没有生成 PDF。请在文稿中加入可排版的内容后重试。')
      }
      await writeFile(join(root, '.build', 'compile-state.json'), JSON.stringify(dependency), 'utf8')
      const result = { success: true, engine, mode, steps, log: logs.join('\n').slice(-6000) } satisfies WritingCompileResult
      await this.saveCompileLog(root, result, logs)
      return result
    } catch (error) {
      const result = {
        success: false, engine, mode, steps,
        log: logs.join('\n').slice(-4000),
        error: error instanceof Error ? error.message.slice(-6000) : '编译失败。'
      } satisfies WritingCompileResult
      await this.saveCompileLog(root, result, logs)
      return result
    }
  }

  private async saveCompileLog(root: string, result: WritingCompileResult, logs: string[]): Promise<void> {
    const header = [
      `时间：${new Date().toLocaleString('zh-CN')}`,
      `编译器：${result.engine}`,
      `方式：${result.mode === 'quick' ? '快速编译' : '完整编译'}`,
      `结果：${result.success ? '成功' : '失败'}`,
      `步骤：${result.steps.join(' → ') || '未开始'}`
    ].join('\n')
    const content = `${header}\n\n${logs.join('\n\n')}\n${result.error ?? ''}`.slice(-maxLogBytes)
    try {
      await mkdir(join(root, '.build'), { recursive: true })
      await writeFile(join(root, '.build', 'last-compile.log'), content, 'utf8')
    } catch { /* The compile result still reaches the editor if logging fails. */ }
  }

  async changes(folderPath: string): Promise<WritingChangeSummary> {
    const root = await requireRoot(folderPath)
    if (!await hasGit(root)) throw new Error('请先初始化写作目录的 Git。')
    await initGit(root)
    const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.'])
    if (!status) return { files: [], totalFiles: 0, additions: 0, deletions: 0 }
    const hasHead = Boolean((await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim())
    const diffCommands = hasHead
      ? [['diff', '--numstat', '-z', '--no-renames', 'HEAD', '--', '.']]
      : [
        ['diff', '--numstat', '-z', '--no-renames', '--', '.'],
        ['diff', '--cached', '--numstat', '-z', '--no-renames', '--', '.']
      ]
    const stats = new Map<string, Pick<WritingChange, 'additions' | 'deletions' | 'binary'>>()
    for (const args of diffCommands) parseNumstat(await git(root, args), stats)
    const files: WritingChange[] = []
    for (const record of status.split('\0')) {
      if (!record) continue
      const code = record.slice(0, 2)
      const path = record.slice(3)
      if (!path) continue
      const kind: WritingChange['status'] = code === '??' || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified'
      const numbers = code === '??' ? await untrackedStats(root, path) : stats.get(path) ?? { additions: 0, deletions: 0, binary: false }
      files.push({ path, status: kind, ...numbers })
    }
    files.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
    return {
      files,
      totalFiles: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0)
    }
  }

  private async reviewCommit(root: string, hash: string): Promise<void> {
    if (typeof hash !== 'string' || !/^[\da-f]{40}(?:[\da-f]{24})?$/i.test(hash)) throw new Error('历史版本无效。')
    if ((await git(root, ['cat-file', '-t', hash]).catch(() => '')).trim() !== 'commit') throw new Error('历史版本不存在。')
  }

  async review(folderPath: string, hash: string): Promise<WritingChangeSummary> {
    const root = await requireRoot(folderPath)
    await this.reviewCommit(root, hash)
    const [statuses, numbers, untracked] = await Promise.all([
      git(root, ['diff', '--name-status', '-z', '--no-renames', hash, '--', '.']),
      git(root, ['diff', '--numstat', '-z', '--no-renames', hash, '--', '.']),
      git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])
    ])
    const stats = new Map<string, Pick<WritingChange, 'additions' | 'deletions' | 'binary'>>()
    parseNumstat(numbers, stats)
    const files: WritingChange[] = []
    const records = statuses.split('\0')
    for (let index = 0; index + 1 < records.length; index += 2) {
      const code = records[index]
      const path = records[index + 1]
      if (!reviewablePath(path)) continue
      files.push({
        path,
        status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
        ...(stats.get(path) ?? { additions: 0, deletions: 0, binary: false })
      })
    }
    for (const path of untracked.split('\0')) {
      if (!reviewablePath(path)) continue
      files.push({ path, status: 'added', ...await untrackedStats(root, path) })
    }
    files.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
    return {
      files,
      totalFiles: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0)
    }
  }

  async reviewFile(folderPath: string, hash: string, relativePath: string): Promise<WritingReviewFile> {
    const root = await requireRoot(folderPath)
    if (typeof relativePath !== 'string' || !reviewablePath(relativePath)) throw new Error('文件路径无效。')
    const change = (await this.review(folderPath, hash)).files.find((file) => file.path === relativePath)
    if (!change) throw new Error('此文件与所选版本没有差异。请刷新对比列表。')
    if (change.binary || !editableExtensions.has(extname(relativePath).toLowerCase())) return { original: '', current: '', binary: true }

    let original = ''
    if (change.status !== 'added') {
      const blob = `${hash}:${relativePath}`
      const size = Number((await git(root, ['cat-file', '-s', blob])).trim())
      if (!Number.isFinite(size) || size > maxTextBytes) return { original: '', current: '', binary: true }
      const { stdout } = await execFileAsync('git', ['show', blob], { cwd: root, windowsHide: true, encoding: 'buffer', maxBuffer: maxTextBytes + 1024 })
      const decoded = textOrNull(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      if (decoded === null) return { original: '', current: '', binary: true }
      original = decoded
    }

    let current = ''
    if (change.status !== 'deleted') {
      const target = await sourcePath(root, relativePath)
      const info = await stat(target)
      if (info.size > maxTextBytes) return { original: '', current: '', binary: true }
      const decoded = textOrNull(await readFile(target))
      if (decoded === null) return { original: '', current: '', binary: true }
      current = decoded
    }
    return { original, current, binary: false }
  }

  async history(folderPath: string): Promise<WritingHistoryEntry[]> {
    const root = await requireRoot(folderPath)
    if (!await hasGit(root)) return []
    const output = await git(root, ['log', '-n', '60', '--format=%x1e%H%x1f%s%x1f%cI', '--numstat', '--no-renames']).catch((error) => {
      if (String(error).includes('does not have any commits yet') || String(error).includes('your current branch')) return ''
      throw error
    })
    return output.split('\x1e').slice(1).map((block) => {
      const [header, ...lines] = block.trim().split(/\r?\n/)
      const [hash, message, committedAt] = header.split('\x1f')
      let files = 0
      let additions = 0
      let deletions = 0
      for (const line of lines) {
        const match = /^(\d+|-)\t(\d+|-)\t/.exec(line)
        if (!match) continue
        files += 1
        additions += Number(match[1]) || 0
        deletions += Number(match[2]) || 0
      }
      return { hash, message, committedAt, files, additions, deletions }
    }).filter((item) => Boolean(item.hash))
  }

  async commit(folderPath: string, message: string): Promise<WritingHistoryEntry> {
    const title = typeof message === 'string' ? message.trim() : ''
    if (!title || title.length > 120 || /[\r\n]/.test(title)) throw new Error('请输入 1 至 120 字的一行版本说明。')
    const root = await requireRoot(folderPath)
    if (!await hasGit(root)) throw new Error('请先初始化写作目录的 Git。')
    await initGit(root)
    await git(root, ['add', '--all', '--', '.'])
    if (!(await git(root, ['status', '--porcelain'])).trim()) throw new Error('没有需要记录的改动。')
    const name = (await git(root, ['config', 'user.name']).catch(() => '')).trim()
    const email = (await git(root, ['config', 'user.email']).catch(() => '')).trim()
    const identity = name && email ? [] : ['-c', 'user.name=re:paper', '-c', 'user.email=repaper@local']
    await git(root, [...identity, 'commit', '--quiet', '-m', title])
    const latest = (await this.history(folderPath))[0]
    if (!latest) throw new Error('版本已记录，但无法读取提交历史。')
    return latest
  }
}
