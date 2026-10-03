import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { unzip } from 'fflate'
import { Parser, type ReadEntry } from 'tar'
import { builtinWritingTemplates, type WritingTemplate, type WritingTemplateDraft, type WritingTemplateImport, type WritingTemplateInfo, type WritingTemplateLibrary } from '../../shared/writing'
import type { WritingWorkspaceManager } from './writing'

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const maxFiles = 2000
const maxBytes = 250 * 1024 * 1024
const maxFileBytes = 50 * 1024 * 1024
const maxArchiveBytes = 100 * 1024 * 1024
const sourceExtensions = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.dbx', '.clo', '.def', '.cfg', '.fd', '.bbl', '.tikz', '.pgf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.eps', '.svg', '.csv', '.dat', '.txt', '.md', '.json', '.yaml', '.yml', '.otf', '.ttf', '.ttc', '.pfb', '.tfm', '.vf', '.map', '.enc'])
const ignoredDirectories = new Set(['.git', '.paper', '.repaper', '.build', 'node_modules', '.venv', '__pycache__', '__macosx'])

interface TemplateDocument {
  schemaVersion: 1
  defaultTemplate: WritingTemplate | ''
  templates: WritingTemplateInfo[]
}
interface PendingTemplate {
  details: WritingTemplateImport
  path: string
}

function sourcePath(name: string): string | null {
  const path = name.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  const segments = path.split('/')
  if (!path || path.length > 512 || isAbsolute(path) || segments.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('模板中存在不支持的文件路径：' + name)
  if (segments.some(part => ignoredDirectories.has(part.toLowerCase())) || segments.some(part => part.startsWith('._')) || basename(path).toLowerCase() === '.repaper-writing.json') return null
  return sourceExtensions.has(extname(path).toLowerCase()) ? path : null
}

function cleanDraft(draft: WritingTemplateDraft, candidates: string[]): WritingTemplateDraft {
  if (!draft || typeof draft.name !== 'string' || !draft.name.trim() || draft.name.trim().length > 100) throw new Error('模板名称需要 1–100 个字符。')
  if (typeof draft.description !== 'string' || draft.description.length > 1000) throw new Error('模板说明最多 1000 个字符。')
  if (typeof draft.mainFile !== 'string' || !candidates.includes(draft.mainFile)) throw new Error('请选择模板中的主文件。')
  return { name: draft.name.trim(), description: draft.description.trim(), mainFile: draft.mainFile }
}

export class WritingTemplateManager {
  private ready: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()
  private drafts = new Map<string, PendingTemplate>()

  constructor(private directory: () => string) {}

  private root(): string { return resolve(this.directory()) }
  private itemPath(category: 'items' | 'staging', id: string): string {
    if (!idPattern.test(id)) throw new Error('模板标识无效。')
    return join(this.root(), category, id)
  }
  private async verifyManaged(path: string): Promise<void> {
    const rel = relative(this.root(), resolve(path))
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('模板库路径无效。')
    const parent = await realpath(dirname(path))
    const canonicalRoot = await realpath(this.root())
    const parentRelative = relative(canonicalRoot, parent)
    if (parentRelative === '..' || parentRelative.startsWith('..' + sep) || isAbsolute(parentRelative) || (await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error('模板库不能通过链接访问文件。')
  }
  private async removeManaged(path: string): Promise<void> {
    await this.verifyManaged(path)
    await rm(path, { recursive: true, force: true })
  }
  private ensureStore(): Promise<void> {
    if (!this.ready) this.ready = (async () => {
      await mkdir(this.root(), { recursive: true })
      if ((await lstat(this.root())).isSymbolicLink()) throw new Error('模板库不能是符号链接。')
      for (const name of ['items', 'staging']) {
        const folder = join(this.root(), name)
        await mkdir(folder, { recursive: true })
        if ((await lstat(folder)).isSymbolicLink()) throw new Error('模板库不能通过链接访问文件。')
      }
      for (const name of await readdir(join(this.root(), 'staging'))) {
        if (!idPattern.test(name)) continue
        const path = this.itemPath('staging', name)
        const info = await lstat(path)
        if (info.isDirectory() && !info.isSymbolicLink() && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) await this.removeManaged(path)
      }
    })().catch(error => { this.ready = null; throw error })
    return this.ready
  }
  private async read(): Promise<TemplateDocument> {
    await this.ensureStore()
    const path = join(this.root(), 'library.json')
    if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error('模板库索引不能是符号链接。')
    let data: TemplateDocument
    try { data = JSON.parse(await readFile(path, 'utf8')) as TemplateDocument }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, defaultTemplate: '', templates: [] }
      throw error
    }
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.templates) || typeof data.defaultTemplate !== 'string' || data.templates.some(item => !item || typeof item.id !== 'string' || !item.id.startsWith('custom:') || !idPattern.test(item.id.slice(7)) || typeof item.name !== 'string' || typeof item.mainFile !== 'string' || !Array.isArray(item.candidates) || !item.candidates.includes(item.mainFile))) throw new Error('模板库索引格式无效。')
    return data
  }
  private async write(data: TemplateDocument): Promise<void> {
    const temporary = join(this.root(), randomUUID() + '.tmp')
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    try { await rename(temporary, join(this.root(), 'library.json')) }
    catch (error) { await this.removeManaged(temporary); throw error }
  }
  private change<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action)
    this.queue = pending.then(() => undefined, () => undefined)
    return pending
  }
  private view(data: TemplateDocument): WritingTemplateLibrary {
    const templates = [...builtinWritingTemplates.map(item => ({ ...item })), ...data.templates]
    return { templates, defaultTemplate: templates.some(item => item.id === data.defaultTemplate) ? data.defaultTemplate : '' }
  }
  async list(): Promise<WritingTemplateLibrary> {
    await this.queue
    return this.view(await this.read())
  }

  async beginImport(source: string): Promise<WritingTemplateImport> {
    await this.ensureStore()
    const input = resolve(source)
    const info = await lstat(input)
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('请选择普通文件夹、LaTeX 文件或压缩包。')
    const sourceKind = info.isDirectory() ? 'folder' : /\.(zip|tar|tar\.gz|tgz)$/i.test(input) ? 'archive' : 'file'
    if (sourceKind === 'file' && !/\.(tex|cls|sty)$/i.test(input)) throw new Error('单文件模板支持 .tex、.cls 和 .sty。')
    if (sourceKind === 'archive' && info.size > maxArchiveBytes) throw new Error('压缩包超过 100 MB，请选用较小的模板。')
    const managedRelative = relative(input, this.root())
    if (sourceKind === 'folder' && (!managedRelative || managedRelative !== '..' && !managedRelative.startsWith('..' + sep) && !isAbsolute(managedRelative))) throw new Error('请选择独立的模板源目录，不能导入模板库或包含模板库的上级目录。')
    const token = randomUUID()
    const path = this.itemPath('staging', token)
    await mkdir(join(path, 'files'), { recursive: true })
    const files: { path: string; size: number }[] = []
    const seen = new Set<string>()
    let totalBytes = 0
    const accept = (name: string, size: number): string | null => {
      const file = sourcePath(name)
      if (!file) return null
      if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes || files.length >= maxFiles || totalBytes + size > maxBytes) throw new Error('模板超过文件限制：最多 2000 个文件、单文件 50 MB、总计 250 MB。')
      const key = file.toLowerCase()
      if (seen.has(key)) throw new Error('模板中存在重复或仅大小写不同的文件：' + file)
      seen.add(key); totalBytes += size; files.push({ path: file, size })
      return file
    }
    const saveFile = async (name: string, data: Uint8Array): Promise<void> => {
      if (data.byteLength !== files.find(file => file.path === name)?.size) throw new Error('导入期间模板文件发生了变化，请重试。')
      const target = join(path, 'files', name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data, { flag: 'wx' })
    }
    try {
      if (sourceKind === 'folder') {
        let entryCount = 0
        const walk = async (folder: string, prefix = '', depth = 0): Promise<void> => {
          if (depth > 12) throw new Error('模板文件夹层级过深。')
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            if (++entryCount > 10_000) throw new Error('模板文件夹包含过多条目。')
            const name = prefix ? prefix + '/' + entry.name : entry.name
            if (entry.isDirectory()) {
              if (!ignoredDirectories.has(entry.name.toLowerCase())) await walk(join(folder, entry.name), name, depth + 1)
            } else if (entry.isSymbolicLink()) {
              if (sourcePath(name)) throw new Error('模板包含链接，请将实际文件放入模板文件夹：' + name)
            } else if (entry.isFile()) {
              const origin = join(folder, entry.name)
              const file = accept(name, (await stat(origin)).size)
              if (file) {
                const target = join(path, 'files', file)
                await mkdir(dirname(target), { recursive: true })
                await copyFile(origin, target)
                if ((await stat(target)).size !== files[files.length - 1].size) throw new Error('导入期间模板文件发生了变化，请重试。')
              }
            }
          }
        }
        await walk(input)
      } else if (sourceKind === 'file') {
        const file = accept(basename(input), info.size)
        if (file) await saveFile(file, await readFile(input))
      } else if (/\.zip$/i.test(input)) {
        const extracted = await new Promise<Record<string, Uint8Array>>((done, reject) => {
          let terminate = () => {}
          let entryCount = 0
          const timeout = setTimeout(() => { terminate(); reject(new Error('模板解压超时，请选用较小的压缩包。')) }, 60_000)
          void readFile(input).then(data => {
            try {
              terminate = unzip(data, { filter: file => {
                if (++entryCount > 10_000) throw new Error('压缩包包含过多条目。')
                return !file.name.endsWith('/') && accept(file.name, file.originalSize) !== null
              } }, (error, contents) => { clearTimeout(timeout); if (error) reject(error); else done(contents) })
            } catch (error) { clearTimeout(timeout); reject(error) }
          }, error => { clearTimeout(timeout); reject(error) })
        })
        for (const [name, data] of Object.entries(extracted)) {
          const file = sourcePath(name)
          const expected = files.find(item => item.path === file)
          if (!file || data.byteLength !== expected?.size) throw new Error('压缩包文件大小不匹配。')
          await saveFile(file, data)
        }
      } else {
        await new Promise<void>((done, reject) => {
          const inputStream = createReadStream(input)
          const parser = new Parser({ strict: true })
          const writes: Promise<void>[] = []
          let settled = false
          let entryCount = 0
          let expandedBytes = 0
          const timeout = setTimeout(() => fail(new Error('模板解压超时，请选用较小的压缩包。')), 60_000)
          const fail = (reason: unknown) => {
            if (settled) return
            const error = reason instanceof Error ? reason : new Error(String(reason))
            settled = true; clearTimeout(timeout); inputStream.destroy(); parser.abort(error)
            void Promise.allSettled(writes).then(() => reject(error))
          }
          inputStream.on('error', fail)
          parser.on('error', fail)
          parser.on('entry', (entry: ReadEntry) => {
            if (settled) { entry.resume(); return }
            try {
              if (++entryCount > 10_000) throw new Error('压缩包包含过多条目。')
              if (entry.type === 'Directory') { entry.resume(); return }
              expandedBytes += entry.size
              if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxFileBytes || expandedBytes > maxBytes) throw new Error('模板压缩包展开后过大。')
              const file = sourcePath(entry.path)
              if (!file) { entry.resume(); return }
              if (!['File', 'OldFile', 'ContiguousFile'].includes(entry.type)) throw new Error('模板压缩包中的文件必须是普通文件：' + entry.path)
              accept(entry.path, entry.size)
              const chunks: Buffer[] = []
              let size = 0
              entry.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > entry.size || size > maxFileBytes) { fail(new Error('压缩包文件大小不匹配。')); return }
                chunks.push(chunk)
              })
              entry.on('error', fail)
              entry.on('end', () => {
                if (settled) return
                if (size !== entry.size) { fail(new Error('压缩包文件大小不匹配。')); return }
                const writing = saveFile(file, Buffer.concat(chunks))
                writes.push(writing)
                void writing.catch(fail)
              })
            } catch (error) { entry.resume(); fail(error instanceof Error ? error : new Error(String(error))) }
          })
          parser.on('end', () => {
            if (settled) return
            void Promise.all(writes).then(() => {
              if (settled) return
              settled = true; clearTimeout(timeout); done()
            }, fail)
          })
          inputStream.pipe(parser)
        })
      }
      if (!files.length) throw new Error('没有找到模板源文件。')
      const texFiles = files.filter(file => extname(file.path).toLowerCase() === '.tex')
      const documents: string[] = []
      for (const file of texFiles) {
        if (file.size > 5 * 1024 * 1024) continue
        const text = (await readFile(join(path, 'files', file.path), 'utf8')).replace(/(?<!\\)%[^\n]*/g, '')
        if (/\\(?:documentclass\s*(?:\[[^\]]*\])?\s*\{|begin\s*\{document\})/.test(text)) documents.push(file.path)
      }
      const candidates = documents.length ? documents : texFiles.length ? texFiles.map(file => file.path) : files.filter(file => extname(file.path).toLowerCase() === '.cls').map(file => file.path)
      if (!candidates.length) candidates.push(...files.filter(file => extname(file.path).toLowerCase() === '.sty').map(file => file.path))
      if (!candidates.length) throw new Error('模板需要包含 .tex 主文件、.cls 文档类或 .sty 样式文件。')
      const rank = (file: string) => (['manuscript.tex', 'main.tex', 'template.tex'].indexOf(basename(file).toLowerCase()) + 1 || 4) + file.split('/').length * 10
      candidates.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right, 'zh-CN'))
      const details: WritingTemplateImport = { token, name: basename(input).replace(/\.(tar\.gz|tgz|zip|tar|tex|cls|sty)$/i, ''), sourceName: basename(input), sourceKind, candidates, mainFile: candidates[0], fileCount: files.length, totalBytes }
      this.drafts.set(token, { details, path })
      return details
    } catch (error) { await this.removeManaged(path); throw error }
  }

  finishImport(token: string, draft: WritingTemplateDraft): Promise<WritingTemplateLibrary> {
    return this.change(async () => {
      const pending = this.drafts.get(token)
      if (!pending) throw new Error('这次模板导入已失效，请重新选择文件。')
      const fields = cleanDraft(draft, pending.details.candidates)
      const data = await this.read()
      const id = randomUUID()
      const target = this.itemPath('items', id)
      const details = pending.details
      const template: WritingTemplateInfo = { id: ('custom:' + id) as WritingTemplate, ...fields, candidates: details.candidates, builtin: false, sourceKind: details.sourceKind, sourceName: details.sourceName, createdAt: new Date().toISOString(), fileCount: details.fileCount, totalBytes: details.totalBytes }
      await this.verifyManaged(pending.path); await this.verifyManaged(target)
      await rename(pending.path, target)
      try { data.templates.push(template); await this.write(data) }
      catch (error) { await rename(target, pending.path); throw error }
      this.drafts.delete(token)
      return this.view(data)
    })
  }
  cancelImport(token: string): Promise<void> {
    return this.change(async () => {
      const pending = this.drafts.get(token)
      if (!pending) return
      this.drafts.delete(token)
      await this.removeManaged(pending.path)
    })
  }
  update(id: WritingTemplate, draft: WritingTemplateDraft): Promise<WritingTemplateLibrary> {
    return this.change(async () => {
      const data = await this.read()
      const item = data.templates.find(template => template.id === id)
      if (!item) throw new Error('只能编辑已导入的模板。')
      Object.assign(item, cleanDraft(draft, item.candidates))
      await this.write(data)
      return this.view(data)
    })
  }
  remove(id: WritingTemplate): Promise<WritingTemplateLibrary> {
    return this.change(async () => {
      const data = await this.read()
      const item = data.templates.find(template => template.id === id)
      if (!item) throw new Error('只能删除已导入的模板。')
      data.templates = data.templates.filter(template => template.id !== id)
      if (data.defaultTemplate === id) data.defaultTemplate = ''
      await this.write(data)
      await this.removeManaged(this.itemPath('items', id.slice(7)))
      return this.view(data)
    })
  }
  setDefault(id: WritingTemplate | ''): Promise<WritingTemplateLibrary> {
    return this.change(async () => {
      const data = await this.read()
      if (typeof id !== 'string') throw new Error('请选择写作模板。')
      if (id && !this.view(data).templates.some(template => template.id === id)) throw new Error('所选模板已不存在。')
      data.defaultTemplate = id
      await this.write(data)
      return this.view(data)
    })
  }
  initializeWriting(folder: string, id: WritingTemplate, writing: WritingWorkspaceManager) {
    return this.change(async () => {
      if (typeof id !== 'string') throw new Error('请选择写作模板。')
      if (!id.startsWith('custom:')) return writing.initialize(folder, id)
      const data = await this.read()
      const item = data.templates.find(template => template.id === id)
      if (!item) throw new Error('写作模板已不存在，请重新选择。')
      const path = this.itemPath('items', id.slice(7))
      await this.verifyManaged(path)
      return writing.initializeTemplate(folder, join(path, 'files'), item)
    })
  }

  previewSwitch(folder: string, id: WritingTemplate, writing: WritingWorkspaceManager) {
    return this.change(async () => {
      if (typeof id !== 'string') throw new Error('请选择写作模板。')
      if (!id.startsWith('custom:')) {
        const template = builtinWritingTemplates.find(item => item.id === id)
        if (!template) throw new Error('写作模板已不存在，请重新选择。')
        return writing.previewTemplateSwitch(folder, template)
      }
      const data = await this.read()
      const item = data.templates.find(template => template.id === id)
      if (!item) throw new Error('写作模板已不存在，请重新选择。')
      const path = this.itemPath('items', id.slice(7))
      await this.verifyManaged(path)
      return writing.previewTemplateSwitch(folder, { ...item }, join(path, 'files'))
    })
  }
}
