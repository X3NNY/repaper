import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { WritingChange, WritingChangeSummary, WritingTemplateInfo, WritingTemplateSwitchPreview, WritingTemplateSwitchResult } from '../../shared/writing'

const execFileAsync = promisify(execFile)
const configName = '.repaper-writing.json'
const templatePreambleBegin = '% re:paper template preamble begin\n'
const templatePreambleEnd = '% re:paper template preamble end'
const maxBytes = 500 * 1024 * 1024
const maxFileBytes = 50 * 1024 * 1024
const maxTextBytes = 5 * 1024 * 1024
const textExtensions = new Set(['.tex', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.def', '.clo', '.cfg', '.fd', '.tikz', '.pgf', '.txt', '.md', '.json', '.yaml', '.yml', '.bib'])
const dependencyTextExtensions = new Set(['.tex', '.sty', '.cls', '.bbx', '.cbx', '.def', '.clo', '.cfg', '.fd', '.tikz', '.pgf'])

interface Snapshot {
  fingerprint: string
  contentFingerprint: string
  files: string[]
  directories: string[]
  fileHashes: Map<string, string>
}

interface PendingSwitch {
  project: string
  root: string
  stage: string
  preview: WritingTemplateSwitchPreview
  paths: string[]
  snapshot: Snapshot
  config: Buffer | null
  createdAt: number
}

interface CommandSpan {
  name: string
  start: number
  end: number
  options: string
  argument: string
  argumentStart: number
  argumentEnd: number
}

function safeRelative(path: string): string {
  const clean = path.replace(/\\/g, '/')
  if (!clean || clean.length > 512 || isAbsolute(path) || clean.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || ['.git', '.build'].includes(part.toLowerCase()))) throw new Error('模板切换包含不安全的文件路径：' + path)
  return clean
}

async function infoOrNull(path: string) {
  try { return await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function checkedPath(root: string, path: string, allowMissing = false): Promise<string> {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('模板切换的根目录不再是普通文件夹。')
  const clean = safeRelative(path)
  let target = root
  const parts = clean.split('/')
  for (let index = 0; index < parts.length; index += 1) {
    target = join(target, parts[index])
    const info = await infoOrNull(target)
    if (info?.isSymbolicLink()) throw new Error('模板切换不能通过符号链接访问文件：' + path)
    if (info && index < parts.length - 1 && !info.isDirectory()) throw new Error('模板切换的上级路径不是文件夹：' + path)
    if (!info && !allowMissing) throw new Error('模板切换的文件已不存在：' + path)
    if (index === parts.length - 1 && info && !info.isFile()) throw new Error('模板切换的目标不是普通文件：' + path)
  }
  return target
}

async function git(root: string, args: string[], hooks?: string): Promise<string> {
  try {
    const result = await execFileAsync('git', ['--literal-pathspecs', ...(hooks ? ['-c', 'core.hooksPath=' + hooks, '-c', 'commit.gpgsign=false'] : []), ...args], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
    return result.stdout ?? ''
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    throw new Error((failure.stderr || failure.stdout || failure.message).trim().slice(-3000))
  }
}

async function assertRepository(root: string): Promise<boolean> {
  const info = await infoOrNull(join(root, '.git'))
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('模板切换需要 .paper 内独立的 Git 仓库，不能使用链接或外部工作树。')
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  if (await realpath(top) !== await realpath(root)) throw new Error('模板切换需要 .paper 内独立的 Git 仓库。')
  const common = resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim())
  if (await realpath(common) !== await realpath(join(root, '.git'))) throw new Error('模板切换不能使用共享 Git 工作树。')
  const verify = async (directory: string, depth = 0): Promise<void> => {
    if (depth > 20) throw new Error('写作 Git 仓库层级过深。')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const child = await lstat(path)
      if (child.isSymbolicLink()) throw new Error('写作 Git 仓库包含链接，请先整理仓库：' + entry.name)
      if (child.isDirectory()) await verify(path, depth + 1)
    }
  }
  await verify(join(root, '.git'))
  if (await infoOrNull(join(root, '.git', 'objects', 'info', 'alternates'))) throw new Error('模板切换不能使用依赖外部对象的 Git 仓库，请先整理为独立仓库。')
  return true
}

async function snapshot(root: string): Promise<Snapshot> {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('.paper 必须是普通文件夹。')
  const hash = createHash('sha256')
  const files: string[] = []
  const directories: string[] = []
  const fileHashes = new Map<string, string>()
  let bytes = 0
  const seen = new Set<string>()
  const walk = async (folder: string, prefix = '', depth = 0): Promise<void> => {
    if (depth > 16) throw new Error('写作目录层级过深，请先整理后再切换模板。')
    const entries = await readdir(folder, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = prefix ? prefix + '/' + entry.name : entry.name
      const info = await lstat(join(folder, entry.name))
      if (info.isSymbolicLink()) throw new Error('写作目录包含符号链接，请先整理实际文件：' + path)
      if (!prefix && ['.git', '.build'].includes(entry.name.toLowerCase())) continue
      safeRelative(path)
      if (seen.has(path.toLowerCase())) throw new Error('写作目录包含仅大小写不同的路径：' + path)
      seen.add(path.toLowerCase())
      if (info.isDirectory()) {
        directories.push(path)
        hash.update('directory\0' + path + '\0')
        await walk(join(folder, entry.name), path, depth + 1)
      } else if (info.isFile()) {
        bytes += info.size
        if (files.length >= 5000 || info.size > maxFileBytes || bytes > maxBytes) throw new Error('写作目录超过切换模板的限制：5000 个文件、单文件 50 MB、总计 500 MB。')
        files.push(path)
        const data = await readFile(await checkedPath(root, path))
        const digest = createHash('sha256').update(data).digest('hex')
        fileHashes.set(path, digest)
        hash.update('file\0' + path + '\0' + digest + '\0')
      } else throw new Error('写作目录包含非普通文件：' + path)
    }
  }
  await walk(root)
  const contentFingerprint = hash.copy().digest('hex')
  if (await assertRepository(root)) {
    hash.update((await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim())
    hash.update((await git(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim())
    if ((await git(root, ['ls-files', '--unmerged'])).trim()) throw new Error('写作目录还有未解决的 Git 冲突，请先处理后再切换模板。')
  }
  return { fingerprint: hash.digest('hex'), contentFingerprint, files, directories, fileHashes }
}

function withoutComments(text: string): string {
  let result = ''
  let comment = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\n' || character === '\r') comment = false
    if (!comment && character === '%') {
      let escapes = 0
      for (let before = index - 1; before >= 0 && text[before] === '\\'; before -= 1) escapes += 1
      if (escapes % 2 === 0) comment = true
    }
    result += comment ? ' ' : character
  }
  return result
}

function spans(text: string, names: string[]): CommandSpan[] {
  const clean = withoutComments(text)
  const pattern = new RegExp('\\\\(' + names.join('|') + ')(?![A-Za-z@])', 'g')
  const result: CommandSpan[] = []
  for (const match of clean.matchAll(pattern)) {
    let cursor = (match.index ?? 0) + match[0].length
    while (/\s/.test(clean[cursor] ?? '') && cursor < clean.length) cursor += 1
    let options = ''
    if (clean[cursor] === '[') {
      const end = clean.indexOf(']', cursor + 1)
      if (end < 0) continue
      options = text.slice(cursor + 1, end)
      cursor = end + 1
      while (/\s/.test(clean[cursor] ?? '') && cursor < clean.length) cursor += 1
    }
    if (clean[cursor] !== '{') continue
    const start = cursor + 1
    let depth = 1
    cursor += 1
    for (; cursor < clean.length && depth; cursor += 1) {
      if (clean[cursor] === '{' && clean[cursor - 1] !== '\\') depth += 1
      if (clean[cursor] === '}' && clean[cursor - 1] !== '\\') depth -= 1
    }
    if (depth) continue
    result.push({ name: match[1], start: match.index ?? 0, end: cursor, options, argument: text.slice(start, cursor - 1), argumentStart: start, argumentEnd: cursor - 1 })
  }
  return result
}

function replaceSpans(text: string, replacements: { start: number; end: number; value: string }[]): string {
  let result = ''
  let cursor = 0
  for (const replacement of replacements.sort((left, right) => left.start - right.start || right.end - left.end)) {
    if (replacement.start < cursor) {
      if (replacement.end <= cursor) continue
      throw new Error('模板导言区包含交叉嵌套的声明，请先整理后再切换。')
    }
    result += text.slice(cursor, replacement.start) + replacement.value
    cursor = replacement.end
  }
  return result + text.slice(cursor)
}

function documentParts(text: string, label: string): { preamble: string; body: string; suffix: string } {
  const clean = withoutComments(text)
  const begins = [...clean.matchAll(/\\begin\s*\{document\}/g)]
  const ends = [...clean.matchAll(/\\end\s*\{document\}/g)]
  if (begins.length !== 1 || ends.length !== 1 || (begins[0].index ?? 0) >= (ends[0].index ?? 0)) throw new Error(label + '需要在主文件中有唯一的 document 环境。请先将分散的导言区整理到主文件再切换。')
  const begin = begins[0]
  const end = ends[0]
  const preamble = text.slice(0, begin.index)
  if (spans(preamble, ['documentclass']).length !== 1) throw new Error(label + '需要在主文件中有唯一、可解析的 documentclass 声明。')
  if (/\\(?:endinput|catcode|makeatletter)\b/.test(withoutComments(preamble)) && /\\catcode\b/.test(withoutComments(preamble))) throw new Error(label + '包含自定义字符解析规则，请手动合并导言区后再切换模板。')
  return { preamble, body: text.slice((begin.index ?? 0) + begin[0].length, end.index), suffix: text.slice((end.index ?? 0) + end[0].length) }
}

function macroNames(text: string): Set<string> {
  const result = new Set<string>()
  const clean = withoutComments(text)
  for (const match of clean.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment|newtheorem)\*?\s*(?:\{\s*)?(\\[A-Za-z@]+|[A-Za-z@]+)\b/g)) result.add(match[1])
  for (const match of clean.matchAll(/\\(?:def|gdef|edef|xdef)\s*(\\[A-Za-z@]+)/g)) result.add(match[1])
  return result
}

function mergePreamble(source: string, target: string, warnings: string[]): string {
  const targetClass = spans(target, ['documentclass'])[0]
  const original = replaceSpans(source, spans(source, ['documentclass']).map(span => ({ start: span.start, end: span.end, value: '' })))
  let targetRest = replaceSpans(target, [...spans(target, ['documentclass', 'title', 'author', 'date', 'thanks', 'bibliography', 'bibliographystyle', 'addbibresource'])].map(span => ({ start: span.start, end: span.end, value: '' })))
  const sourcePackages = new Map<string, string>()
  for (const span of spans(original, ['usepackage', 'RequirePackage'])) for (const name of span.argument.split(',').map(value => value.trim())) sourcePackages.set(name, span.options.trim())
  const replacements: { start: number; end: number; value: string }[] = []
  for (const span of spans(targetRest, ['usepackage', 'RequirePackage'])) {
    const remaining: string[] = []
    for (const name of span.argument.split(',').map(value => value.trim())) {
      const previous = sourcePackages.get(name)
      if (previous === undefined) { remaining.push(name); continue }
      if (span.options.trim() && span.options.trim() !== previous) throw new Error('原稿与模板对宏包 ' + name + ' 使用了不同选项，请先手动统一这些选项再切换。')
    }
    if (remaining.length !== span.argument.split(',').length) replacements.push({ start: span.start, end: span.end, value: remaining.length ? '\\' + span.name + (span.options ? '[' + span.options + ']' : '') + '{' + remaining.join(',') + '}' : '' })
  }
  targetRest = replaceSpans(targetRest, replacements)
  const sourceMacros = macroNames(original)
  const duplicates = [...macroNames(targetRest)].filter(name => sourceMacros.has(name))
  if (duplicates.length) throw new Error('原稿与模板重复定义了宏或环境：' + duplicates.slice(0, 8).join('、') + '。请先手动决定采用哪份定义。')
  if (sourceMacros.size) warnings.push('已保留原稿的自定义宏和环境；新文档类的兼容性需要通过编译确认。')
  if (/\\(?:bibliography|bibliographystyle|addbibresource)\b/.test(withoutComments(source))) warnings.push('参考文献资源和原稿中的样式声明会保留，请检查是否符合目标模板要求。')
  return target.slice(targetClass.start, targetClass.end) + '\n\n% 原稿导言区（文档类已替换）\n' + original.trim() + '\n\n' + templatePreambleBegin + targetRest.trim() + '\n' + templatePreambleEnd + '\n'
}

function generatedPreambleBlock(preamble: string): string {
  const begin = preamble.indexOf(templatePreambleBegin)
  const end = preamble.indexOf(templatePreambleEnd, begin + templatePreambleBegin.length)
  if (begin < 0 || end < begin || preamble.lastIndexOf(templatePreambleBegin) !== begin || preamble.lastIndexOf(templatePreambleEnd) !== end) throw new Error('文稿中的模板导言区标记存在歧义，请先手动整理后再切换。')
  return preamble.slice(begin, end + templatePreambleEnd.length)
}

function lineStats(data: Buffer): Pick<WritingChange, 'additions' | 'deletions' | 'binary'> {
  if (data.includes(0) || data.length > maxTextBytes) return { additions: 0, deletions: 0, binary: true }
  try { new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { return { additions: 0, deletions: 0, binary: true } }
  return { additions: data.length ? data.toString('utf8').split('\n').length - (data[data.length - 1] === 10 ? 1 : 0) : 0, deletions: 0, binary: false }
}

export class WritingTemplateSwitcher {
  private pending = new Map<string, PendingSwitch>()

  private async removeStage(project: string, stage: string): Promise<void> {
    if (dirname(resolve(stage)) !== project || await realpath(project) !== project || !basename(stage).startsWith('.repaper-template-switch-') || (await infoOrNull(stage))?.isSymbolicLink()) throw new Error('模板预览暂存路径无效。')
    await rm(stage, { recursive: true, force: true })
  }

  async preview(folder: string, sourceMainFile: string, template: WritingTemplateInfo, templateRoot: string | null, builtinFiles: Record<string, string>): Promise<WritingTemplateSwitchPreview> {
    const project = await realpath(folder)
    const root = join(project, '.paper')
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('.paper 必须是普通文件夹。')
    for (const [token, item] of this.pending) {
      if (item.project === project || Date.now() - item.createdAt > 60 * 60 * 1000) {
        await this.removeStage(item.project, item.stage)
        this.pending.delete(token)
      }
    }
    const before = await snapshot(root)
    const source = await readFile(await checkedPath(root, sourceMainFile))
    if (source.length > maxTextBytes) throw new Error('主文件超过 5 MB，请先拆分后再切换模板。')
    let original: string
    try { original = new TextDecoder('utf-8', { fatal: true }).decode(source) }
    catch { throw new Error('主文件需要 UTF-8 编码，请先另存为 UTF-8。') }
    const token = randomUUID()
    const stage = await mkdtemp(join(project, '.repaper-template-switch-'))
    const assetRoot = '.repaper-templates/' + token
    const targetMainFile = (dirname(sourceMainFile) === '.' ? '' : dirname(sourceMainFile).replace(/\\/g, '/') + '/') + basename(sourceMainFile, extname(sourceMainFile)) + '.template-' + token.slice(0, 8) + '.tex'
    safeRelative(targetMainFile)
    const warnings = ['原主文件、目录、图片和参考文献会保留，模板示例正文不会写入你的文稿。', '预览仅显示源码差异；应用后请编译确认排版和文档类兼容性。']
    const preview: WritingTemplateSwitchPreview = { token, templateId: template.id, templateName: template.name, sourceMainFile, mainFile: targetMainFile, sourceFingerprint: before.fingerprint, canApply: true, warnings, summary: '', changes: { files: [], totalFiles: 0, additions: 0, deletions: 0 }, original, current: '' }
    const paths: string[] = []
    try {
      await mkdir(join(stage, 'files'), { recursive: true })
      await mkdir(join(stage, 'hooks'))
      const assets = new Map<string, Buffer>()
      let totalBytes = 0
      const accept = (path: string, data: Buffer) => {
        safeRelative(path)
        if (path === configName || [...assets.keys()].some(name => name.toLowerCase() === path.toLowerCase())) throw new Error('模板中存在重复或保留路径：' + path)
        totalBytes += data.length
        if (assets.size >= 2000 || data.length > maxFileBytes || totalBytes > 250 * 1024 * 1024) throw new Error('模板超过切换限制：2000 个文件、单文件 50 MB、总计 250 MB。')
        assets.set(path, data)
      }
      if (templateRoot) {
        const templateInfo = await lstat(templateRoot)
        if (!templateInfo.isDirectory() || templateInfo.isSymbolicLink()) throw new Error('模板源文件夹无效。')
        const walk = async (directory: string, prefix = '', depth = 0): Promise<void> => {
          if (depth > 12) throw new Error('模板目录层级过深。')
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = prefix ? prefix + '/' + entry.name : entry.name
            const info = await lstat(join(directory, entry.name))
            if (info.isSymbolicLink()) throw new Error('模板包含符号链接：' + path)
            if (info.isDirectory()) { safeRelative(path); await walk(join(directory, entry.name), path, depth + 1) }
            else if (info.isFile()) accept(path, await readFile(await checkedPath(templateRoot, path)))
            else throw new Error('模板包含非普通文件：' + path)
          }
        }
        await walk(templateRoot)
      } else for (const [path, value] of Object.entries(builtinFiles)) accept(path, Buffer.from(value, 'utf8'))
      let templateMain = safeRelative(template.mainFile)
      const mainData = assets.get(templateMain)
      if (!mainData) throw new Error('模板主文件已不存在，请重新导入模板。')
      if (['.cls', '.sty'].includes(extname(templateMain).toLowerCase())) {
        const extension = extname(templateMain).toLowerCase()
        const stem = basename(templateMain, extname(templateMain))
        if (!/^[\p{L}\p{N}_.-]+$/u.test(stem)) throw new Error('文档类或样式文件名称无法安全写入 LaTeX，请选用 .tex 模板主文件。')
        const wrapper = (dirname(templateMain) === '.' ? '' : dirname(templateMain) + '/') + 'repaper-template-main.tex'
        if (assets.has(wrapper)) throw new Error('模板包含保留的包装主文件名，请先改名：' + wrapper)
        assets.set(wrapper, Buffer.from((extension === '.cls' ? '\\documentclass{' + stem + '}' : '\\documentclass{article}\n\\usepackage{' + stem + '}') + '\n\\begin{document}\n\\end{document}\n'))
        templateMain = wrapper
      }
      let current = ''
      let templatePreambleHash = ''
      try {
        const sourceParts = documentParts(original, '原稿')
        if (before.files.includes(configName)) {
          const oldConfig = JSON.parse((await readFile(await checkedPath(root, configName))).toString('utf8')) as { templatePreambleHash?: unknown }
          if (typeof oldConfig.templatePreambleHash === 'string') {
            const oldBlock = generatedPreambleBlock(sourceParts.preamble)
            if (createHash('sha256').update(oldBlock).digest('hex') !== oldConfig.templatePreambleHash) throw new Error('上次模板注入的导言区已被修改，请先把需要保留的自定义声明移到模板标记之外，再重新预览。')
            sourceParts.preamble = sourceParts.preamble.replace(oldBlock, '')
          }
        }
        const targetData = assets.get(templateMain)!
        if (targetData.length > maxTextBytes) throw new Error('模板主文件超过 5 MB，请使用更小的模板。')
        const targetParts = documentParts(new TextDecoder('utf-8', { fatal: true }).decode(targetData), '目标模板')
        // Only the template preamble and its dependencies are used; example body assets stay isolated.
        const templatePreamble = replaceSpans(targetParts.preamble, spans(targetParts.preamble, ['title', 'author', 'date', 'thanks', 'bibliography', 'bibliographystyle', 'addbibresource']).map(span => ({ start: span.start, end: span.end, value: '' })))
        const rewritten = await this.rewriteTemplateAssets(root, sourceMainFile, templateMain, assetRoot, assets, templatePreamble, before.files)
        const cleanedPreamble = replaceSpans(rewritten, spans(rewritten, ['graphicspath']).map(span => ({ start: span.start, end: span.end, value: '' })))
        const preamble = mergePreamble(sourceParts.preamble, cleanedPreamble, warnings)
        templatePreambleHash = createHash('sha256').update(generatedPreambleBlock(preamble)).digest('hex')
        current = preamble + '\n\\begin{document}' + sourceParts.body + '\\end{document}' + sourceParts.suffix
        if (Buffer.byteLength(current, 'utf8') > maxTextBytes) throw new Error('迁移后的主文件超过 5 MB，请先拆分原稿。')
      } catch (error) {
        preview.canApply = false
        warnings.push(error instanceof Error ? error.message : '无法可靠迁移这份模板，请手动整理主文件和导言区。')
      }
      preview.current = current
      if (preview.canApply) {
        const save = async (path: string, data: Buffer): Promise<void> => {
          const target = join(stage, 'files', safeRelative(path))
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, data, { flag: 'wx' })
          paths.push(path)
          const numbers = textExtensions.has(extname(path).toLowerCase()) ? lineStats(data) : { additions: 0, deletions: 0, binary: true }
          if (path === configName && before.files.includes(configName)) numbers.deletions = lineStats(await readFile(await checkedPath(root, configName))).additions
          preview.changes.files.push({ path, status: path === configName && before.files.includes(configName) ? 'modified' : 'added', ...numbers })
        }
        for (const [path, data] of assets) await save(assetRoot + '/' + path, data)
        await save(targetMainFile, Buffer.from(current, 'utf8'))
        const oldConfig = await infoOrNull(join(root, configName)) ? await readFile(await checkedPath(root, configName)) : null
        let config: Record<string, unknown> = {}
        if (oldConfig) {
          try { config = JSON.parse(oldConfig.toString('utf8')) as Record<string, unknown> }
          catch { throw new Error('写作配置无法解析，请先整理 .repaper-writing.json。') }
        }
        const nextConfig = Buffer.from(JSON.stringify({ ...config, schemaVersion: 1, mainFile: targetMainFile, templateId: template.id, templateName: template.name, templateAssetRoot: assetRoot, templatePreambleHash, pdfInvalidated: true, previousMainFile: sourceMainFile }, null, 2) + '\n')
        if (nextConfig.length > 4096) throw new Error('切换后的写作配置超过 4 KB，请先整理 .repaper-writing.json 中的额外字段。')
        await save(configName, nextConfig)
      }
      const after = await snapshot(root)
      if (before.fingerprint !== after.fingerprint) throw new Error('预览期间文稿发生了变化，请重新预览。')
      preview.changes.files.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
      preview.changes = { files: preview.changes.files, totalFiles: preview.changes.files.length, additions: preview.changes.files.reduce((sum, file) => sum + file.additions, 0), deletions: preview.changes.files.reduce((sum, file) => sum + file.deletions, 0) }
      preview.summary = preview.canApply ? '正文原样迁移到“' + template.name + '”，保留全部原文件；应用时保存原稿版本并创建模板分支。' : '这份模板需要先手动整理后才能安全应用，请查看下方建议。'
      const config = before.files.includes(configName) ? await readFile(await checkedPath(root, configName)) : null
      this.pending.set(token, { project, root, stage, preview, paths, snapshot: before, config, createdAt: Date.now() })
      return preview
    } catch (error) { await this.removeStage(project, stage); throw error }
  }

  private async rewriteTemplateAssets(root: string, sourceMain: string, templateMain: string, assetRoot: string, assets: Map<string, Buffer>, preamble: string, sourceFiles: string[]): Promise<string> {
    const mainDirectory = dirname(templateMain)
    const sourceDirectory = dirname(sourceMain)
    const texPath = (path: string, stripExtension = false) => {
      const full = relative(sourceDirectory, assetRoot + '/' + path).replace(/\\/g, '/')
      const target = stripExtension ? full.slice(0, -extname(full).length) : full
      if (!/^[\p{L}\p{N}_./-]+$/u.test(target)) throw new Error('模板资源路径包含空格或特殊字符，请先改名再切换：' + path)
      return target
    }
    const processed = new Set<string>()
    const pending: string[] = []
    const find = (name: string, file: string, extensions: string[]): string | null => {
      if (!name || /[\\#$%{}]/.test(name) || isAbsolute(name)) throw new Error('模板包含动态或外部资源路径，请先改成模板内的普通相对路径：' + name)
      const candidates = new Set<string>()
      for (const folder of [mainDirectory, dirname(file), '.']) {
        const base = join(folder, name).replace(/\\/g, '/')
        if (base === '..' || base.startsWith('../')) throw new Error('模板引用了模板目录外的资源：' + name)
        for (const candidate of [base, ...extensions.map(extension => base + extension)]) if (assets.has(candidate)) candidates.add(candidate)
      }
      if (candidates.size > 1) throw new Error('模板资源引用存在多份候选，请先明确路径：' + name)
      return [...candidates][0] ?? null
    }
    const rewrite = (text: string, file: string): string => {
      const clean = withoutComments(text)
      if (/\\(?:setmainfont|setsansfont|setmonofont|newfontfamily|newfontface|defaultfontfeatures|fontspec)\b/.test(clean) && (/\bPath\s*=|\.(?:otf|ttf|ttc)\b/i.test(clean) || spans(text, ['setmainfont', 'setsansfont', 'setmonofont', 'fontspec']).some(span => /[/\\]/.test(span.argument)))) throw new Error('模板使用 fontspec 本地字体路径，自动切换暂不迁移这些路径。请先安装模板字体，并把字体声明改为已安装的字体名称，或手动迁移字体资源。')
      if (/\\(?:import|subimport|includefrom|inputfrom|subincludefrom|subinputfrom|includeonly|openin|openout|write18)\b/.test(clean)) throw new Error('模板使用了需手动处理的导入或文件操作命令，请先整理为 input/include 和模板内的相对路径。')
      const commands = ['documentclass', 'usepackage', 'RequirePackage', 'RequirePackageWithOptions', 'input', 'include', 'includegraphics', 'bibliography', 'bibliographystyle', 'addbibresource', 'lstinputlisting', 'verbatiminput', 'InputIfFileExists', 'IfFileExists', 'LoadClass', 'LoadClassWithOptions']
      const calls = spans(text, commands)
      for (const span of spans(text, ['graphicspath'])) if (!/^\s*(?:\{[^{}]*\}\s*)+$/.test(span.argument) || /[\\#$%]/.test(span.argument)) throw new Error('模板 graphicspath 包含动态路径，请先改为普通相对目录。')
      const recognized = new Set(calls.map(span => span.start))
      for (const match of clean.matchAll(/\\(?:input|include|includegraphics|InputIfFileExists|IfFileExists|LoadClass|LoadClassWithOptions|RequirePackage|RequirePackageWithOptions)\b/g)) if (!recognized.has(match.index ?? 0)) throw new Error('模板包含无法解析的资源引用，请使用带花括号的普通相对路径。')
      const replacements: { start: number; end: number; value: string }[] = []
      for (const span of calls) {
        const packageCommand = ['documentclass', 'usepackage', 'RequirePackage', 'RequirePackageWithOptions', 'LoadClass', 'LoadClassWithOptions'].includes(span.name)
        const extensions = ['documentclass', 'LoadClass', 'LoadClassWithOptions'].includes(span.name) ? ['.cls'] : ['usepackage', 'RequirePackage', 'RequirePackageWithOptions'].includes(span.name) ? ['.sty'] : span.name === 'bibliographystyle' ? ['.bst'] : ['bibliography', 'addbibresource'].includes(span.name) ? ['.bib'] : span.name === 'includegraphics' ? ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg'] : ['.tex']
        const names = ['usepackage', 'RequirePackage', 'RequirePackageWithOptions', 'bibliography'].includes(span.name) ? span.argument.split(',') : [span.argument]
        const values = names.map(value => {
          const name = value.trim()
          const local = find(name, file, extensions)
          if (!local) {
            if (!packageCommand && !['IfFileExists', 'InputIfFileExists'].includes(span.name)) throw new Error('模板引用的资源未包含在模板中：' + name + '。请补齐文件后重新导入。')
            return name
          }
          if (dependencyTextExtensions.has(extname(local).toLowerCase()) && !processed.has(local)) pending.push(local)
          return texPath(local, packageCommand || ['include', 'bibliography', 'bibliographystyle'].includes(span.name))
        })
        replacements.push({ start: span.argumentStart, end: span.argumentEnd, value: values.join(',') })
      }
      for (const match of clean.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/g)) {
        const value = match[1].replace(/\{([^{}]*)\}/g, (_whole, folder: string) => {
          if (/[\\#$%{}]/.test(folder) || isAbsolute(folder)) throw new Error('模板 graphicspath 需要普通相对路径。')
          const directory = join(mainDirectory, folder).replace(/\\/g, '/').replace(/\/$/, '')
          if (directory === '..' || directory.startsWith('../')) throw new Error('模板 graphicspath 不能引用模板外的目录。')
          if (![...assets.keys()].some(path => path.startsWith(directory === '.' ? '' : directory + '/'))) throw new Error('模板 graphicspath 引用的目录不存在：' + folder)
          return '{' + texPath(directory === '.' ? '' : directory) + '/}'
        })
        replacements.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, value: '\\graphicspath{' + value + '}' })
      }
      return replaceSpans(text, replacements)
    }
    const result = rewrite(preamble, templateMain)
    while (pending.length) {
      const file = pending.shift()!
      if (processed.has(file) || file === templateMain) continue
      processed.add(file)
      const data = assets.get(file)!
      if (data.length > maxTextBytes) throw new Error('模板依赖文件超过 5 MB：' + file)
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) }
      catch { throw new Error('模板依赖文件需要 UTF-8 编码：' + file) }
      // Bare dependencies inside classes are ambiguous when the original project has its own copy.
      const originalConflicts = sourceFiles.filter(path => !path.replace(/\\/g, '/').startsWith('.repaper-templates/') && basename(path).toLowerCase() === basename(file).toLowerCase() && path !== sourceMain)
      if (originalConflicts.length) {
        const same = await Promise.all(originalConflicts.map(async path => (await readFile(await checkedPath(root, path))).equals(data)))
        if (same.some(value => !value)) throw new Error('原稿和模板含有不同的同名依赖：' + basename(file) + '。请先给依赖改名或手动合并。')
      }
      assets.set(file, Buffer.from(rewrite(text, file), 'utf8'))
    }
    return result
  }

  async cancel(folder: string, token: string): Promise<void> {
    const item = this.pending.get(token)
    if (!item) return
    if (await realpath(folder) !== item.project) throw new Error('模板预览属于另一个写作目录。')
    await this.removeStage(item.project, item.stage)
    this.pending.delete(token)
  }

  private async verifyOriginal(item: PendingSwitch, installed: string[] = [], madeDirectories: string[] = []): Promise<void> {
    const current = await snapshot(item.root)
    const additions = new Set(installed)
    const newDirectories = new Set(madeDirectories.map(path => relative(item.root, path).replace(/\\/g, '/')))
    const currentPaths = current.files.filter(path => !additions.has(path) && path !== configName)
    const oldPaths = item.snapshot.files.filter(path => path !== configName)
    if (currentPaths.length !== oldPaths.length || currentPaths.some(path => !item.snapshot.fileHashes.has(path) || current.fileHashes.get(path) !== item.snapshot.fileHashes.get(path))) throw new Error('应用期间原稿文件发生了外部修改，已停止切换，请重新预览。')
    const directories = current.directories.filter(path => !newDirectories.has(path))
    if (directories.length !== item.snapshot.directories.length || directories.some(path => !item.snapshot.directories.includes(path))) throw new Error('应用期间原稿目录发生了外部修改，已停止切换，请重新预览。')
    const expectedConfig = additions.has(configName) ? await readFile(await checkedPath(join(item.stage, 'files'), configName)) : item.config
    const actualConfig = current.files.includes(configName) ? await readFile(await checkedPath(item.root, configName)) : null
    if (expectedConfig ? !actualConfig?.equals(expectedConfig) : actualConfig !== null) throw new Error('应用期间写作配置发生了外部修改，已停止切换，请重新预览。')
  }

  async apply(folder: string, token: string): Promise<Omit<WritingTemplateSwitchResult, 'workspace'>> {
    const item = this.pending.get(token)
    if (!item || await realpath(folder) !== item.project) throw new Error('模板预览已失效，请重新预览。')
    if (!item.preview.canApply) throw new Error('这份模板需要先手动整理，请查看预览建议。')
    if (Date.now() - item.createdAt > 60 * 60 * 1000 || (await snapshot(item.root)).fingerprint !== item.snapshot.fingerprint) {
      await this.cancel(folder, token)
      throw new Error('预览后文稿或 Git 版本发生了变化，请重新预览再应用。')
    }
    const { root, stage } = item
    const hooks = join(stage, 'hooks')
    await git(root, ['--version'])
    const hadRepository = await assertRepository(root)
    if (!hadRepository) await git(root, ['init', '--quiet'], hooks)
    const startingBranch = (await git(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim()
    const startingHead = (await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim()
    const indexPath = join(root, '.git', 'index')
    const initialIndex = await infoOrNull(indexPath) ? await readFile(indexPath) : null
    const suffix = token.slice(0, 8)
    const originalBranch = 'repaper/original-' + suffix
    const templateBranch = 'repaper/template-' + suffix
    let originalCommit = ''
    const installed: string[] = []
    const madeDirectories: string[] = []
    let configInstalled = false
    try {
      for (const path of item.paths) {
        const target = await checkedPath(root, path, true)
        if (path !== configName && await infoOrNull(target)) throw new Error('模板目标路径已经存在，请重新预览：' + path)
      }
      // Force-add source files so ignored figures and bibliography are also recoverable from the baseline.
      for (let index = 0; index < item.snapshot.files.length; index += 100) await git(root, ['add', '--force', '--', ...item.snapshot.files.slice(index, index + 100)], hooks)
      await git(root, ['add', '--update', '--', '.'], hooks)
      await this.verifyOriginal(item)
      const identity = ['-c', 'user.name=re:paper', '-c', 'user.email=repaper@local']
      await git(root, [...identity, 'commit', '--quiet', '--allow-empty', '-m', '保存模板切换前的原稿：' + item.preview.templateName], hooks)
      originalCommit = (await git(root, ['rev-parse', 'HEAD'])).trim()
      await git(root, ['branch', originalBranch, originalCommit], hooks)
      await git(root, ['switch', '--create', templateBranch, originalCommit], hooks)
      const createDirectories = async (target: string): Promise<void> => {
        const parent = dirname(target)
        if (parent === root) return
        const info = await infoOrNull(parent)
        if (info) { if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('模板目标目录已发生变化。'); return }
        await createDirectories(parent)
        await mkdir(parent)
        madeDirectories.push(parent)
      }
      for (const path of item.paths.filter(path => path !== configName)) {
        const target = await checkedPath(root, path, true)
        await createDirectories(target)
        await copyFile(await checkedPath(join(stage, 'files'), path), target, constants.COPYFILE_EXCL)
        installed.push(path)
      }
      await this.verifyOriginal(item, installed, madeDirectories)
      const configTarget = await checkedPath(root, configName, true)
      const configTemporary = join(root, '.repaper-writing-' + token + '.tmp')
      await copyFile(await checkedPath(join(stage, 'files'), configName), configTemporary, constants.COPYFILE_EXCL)
      try { await rename(configTemporary, configTarget); configInstalled = true }
      finally { await rm(configTemporary, { force: true }) }
      await this.verifyOriginal(item, [...installed, configName], madeDirectories)
      for (let index = 0; index < item.paths.length; index += 100) await git(root, ['add', '--force', '--', ...item.paths.slice(index, index + 100)], hooks)
      await this.verifyOriginal(item, [...installed, configName], madeDirectories)
      await git(root, [...identity, 'commit', '--quiet', '-m', '切换写作模板：' + item.preview.templateName], hooks)
      const templateCommit = (await git(root, ['rev-parse', 'HEAD'])).trim()
      await this.removeStage(item.project, stage).then(() => this.pending.delete(token), () => undefined)
      return { originalBranch, templateBranch, originalCommit, templateCommit }
    } catch (error) {
      const rollbackErrors: string[] = []
      for (const path of installed.reverse()) {
        try {
          const target = await checkedPath(root, path)
          if (!(await readFile(target)).equals(await readFile(await checkedPath(join(stage, 'files'), path)))) throw new Error('新文件已被外部修改，保留文件：' + path)
          await rm(target)
        } catch (rollbackError) { rollbackErrors.push(String(rollbackError)) }
      }
      if (configInstalled) {
        try {
          const target = await checkedPath(root, configName)
          if (!(await readFile(target)).equals(await readFile(await checkedPath(join(stage, 'files'), configName)))) throw new Error('写作配置已被外部修改，保留现状。')
          if (item.config) await writeFile(target, item.config)
          else await rm(target)
        } catch (rollbackError) { rollbackErrors.push(String(rollbackError)) }
      }
      for (const directory of madeDirectories.reverse()) await rmdir(directory).catch(() => undefined)
      try {
        await assertRepository(root)
        if (startingBranch) {
          await git(root, ['symbolic-ref', 'HEAD', startingBranch], hooks)
          if (startingHead) await git(root, ['update-ref', startingBranch, startingHead], hooks)
          else await git(root, ['update-ref', '--delete', startingBranch], hooks)
        } else if (startingHead) await git(root, ['update-ref', '--no-deref', 'HEAD', startingHead], hooks)
        if (initialIndex) await writeFile(indexPath, initialIndex)
        else await rm(indexPath, { force: true })
        await git(root, ['branch', '--delete', '--force', templateBranch], hooks).catch(() => undefined)
      } catch (rollbackError) { rollbackErrors.push(String(rollbackError)) }
      await this.cancel(folder, token).catch(rollbackError => rollbackErrors.push(String(rollbackError)))
      const message = error instanceof Error ? error.message : '模板切换失败。'
      throw new Error(message + (rollbackErrors.length ? '\n部分自动恢复未完成，原稿基线保留在 ' + (originalBranch || originalCommit) + '：\n' + rollbackErrors.join('\n') : '\n已保留原稿文件，请重新预览后再试。'))
    }
  }
}
