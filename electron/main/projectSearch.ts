import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  ProjectSearchField, ProjectSearchKind, ProjectSearchOptions, ProjectSearchProvenance,
  ProjectSearchResponse, ProjectSearchResult, ProjectSearchTarget, ProjectSearchWarning
} from '../../shared/search'
import type { LiteratureAnnotation, LiteratureDocument, LiteratureRect } from '../../shared/literature'

export interface ProjectSearchReadOptions extends ProjectSearchOptions { signal?: AbortSignal }

const kinds: ProjectSearchKind[] = ['manuscript', 'literature', 'experiment', 'submission', 'overview', 'route', 'revision', 'project']
const fields: ProjectSearchField[] = ['title', 'content', 'summary', 'design', 'settings', 'results', 'conclusion', 'original', 'score', 'notes', 'objective', 'task', 'decision', 'url']
const provenances: ProjectSearchProvenance[] = ['original', 'ai_summary', 'record', 'legacy_summary']
const manuscriptExtensions = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md', '.json', '.yaml', '.yml'])
const attachmentExtensions = new Set(['.txt', '.md', '.eml', '.html', '.htm'])
const ignoredDirectories = new Set(['.git', '.build', '.repaper', 'build', 'dist', 'out', 'tmp', 'temp', '.tmp', '.cache', 'cache', 'node_modules', '.venv', 'venv', '__pycache__', 'data', 'dataset', 'datasets', 'checkpoints', 'logs', 'runs', 'artifacts'])
const MiB = 1024 * 1024

type JsonRecord = Record<string, unknown>
type SearchDocument = {
  id: string
  kind: ProjectSearchKind
  title: string
  target: ProjectSearchTarget
  sourcePath?: string
}

const text = (value: unknown): string => typeof value === 'string' ? value : ''
const record = (value: unknown): JsonRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
const records = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(record).filter((item): item is JsonRecord => item !== null) : []
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function integer(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) throw new Error('搜索范围必须使用有效的整数。')
  return Math.min(value, maximum)
}

function filter<T extends string>(value: unknown, allowed: T[]): Set<T> | null {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !allowed.includes(item as T))) throw new Error('搜索筛选条件无效。')
  return new Set(value as T[])
}

function safeRelative(path: string): boolean {
  return Boolean(path && path.length <= 1024 && !isAbsolute(path) && !path.includes('\0') &&
    path.replaceAll('\\', '/').split('/').every(segment => segment && segment !== '.' && segment !== '..' && !segment.includes(':')))
}

/** Lowercase expansion (for example İ) must not shift source/highlight offsets. */
function searchable(content: string, caseSensitive: boolean): {
  value: string
  sourceRange: (start: number, end: number) => { start: number; end: number }
} {
  const value = caseSensitive ? content : content.toLowerCase()
  if (value.length === content.length) return { value, sourceRange: (start, end) => ({ start, end }) }
  let sourceOffset = 0
  let foldedOffset = 0
  // Matches arrive in ascending order. Walk source boundaries lazily without allocating a map per character.
  const offset = (index: number, isEnd: boolean): number => {
    while (sourceOffset < content.length) {
      const character = String.fromCodePoint(content.codePointAt(sourceOffset)!)
      const length = character.toLowerCase().length
      if (foldedOffset + length > index) return sourceOffset + (isEnd && index > foldedOffset ? character.length : 0)
      sourceOffset += character.length
      foldedOffset += length
    }
    return content.length
  }
  return { value, sourceRange: (start, end) => ({ start: offset(start, false), end: offset(end, true) }) }
}

class SearchReader {
  readonly results: ProjectSearchResult[] = []
  readonly warnings: ProjectSearchWarning[] = []
  readonly kindFilter: Set<ProjectSearchKind> | null
  readonly fieldFilter: Set<ProjectSearchField> | null
  readonly provenanceFilter: Set<ProjectSearchProvenance> | null
  readonly offset: number
  readonly limit: number
  readonly maxFiles: number
  readonly maxBytes: number
  readonly maxFileBytes: number
  readonly maxResults: number
  total = 0
  scannedFiles = 0
  scannedBytes = 0
  incomplete = false
  stopped = false
  private directories = 0
  private attemptedFiles = 0
  private warningKeys = new Set<string>()
  private readonly needle: string
  private readonly fingerprint = createHash('sha256')

  constructor(readonly root: string, readonly query: string, readonly options: ProjectSearchReadOptions) {
    this.kindFilter = filter(options.kinds, kinds)
    this.fieldFilter = filter(options.fields, fields)
    this.provenanceFilter = filter(options.provenance, provenances)
    this.offset = integer(options.offset, 0, 4999, 0)
    this.limit = integer(options.limit, 50, 100)
    this.maxFiles = integer(options.limits?.maxFiles, 600, 2000)
    this.maxBytes = integer(options.limits?.maxBytes, 32 * MiB, 64 * MiB)
    this.maxFileBytes = integer(options.limits?.maxFileBytes, 8 * MiB, 8 * MiB)
    this.maxResults = integer(options.limits?.maxResults, 2000, 5000)
    this.needle = options.caseSensitive ? query : query.toLowerCase()
  }

  check(): void { this.options.signal?.throwIfAborted() }
  wants(kind: ProjectSearchKind): boolean { return !this.kindFilter || this.kindFilter.has(kind) }
  accepts(field: ProjectSearchField, provenance: ProjectSearchProvenance): boolean {
    return (!this.fieldFilter || this.fieldFilter.has(field)) && (!this.provenanceFilter || this.provenanceFilter.has(provenance))
  }

  warn(code: ProjectSearchWarning['code'], sourcePath: string, message: string, incomplete = true): void {
    if (incomplete) this.incomplete = true
    const key = `${code}:${sourcePath}`
    if (this.warningKeys.has(key)) return
    this.warningKeys.add(key)
    if (this.warnings.length < 49) this.warnings.push({ code, sourcePath, message })
    else if (this.warnings.length === 49) this.warnings.push({ code: 'limit', sourcePath: '', message: '部分来源警告已省略。' })
  }

  private failure(path: string, error: unknown, optional = false): void {
    this.check()
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (!optional) this.warn('missing', path, '来源不存在，未纳入搜索。')
    }
    else this.warn('unreadable', path, '来源无法读取，未纳入搜索。')
  }

  async entry(path: string, expected: 'file' | 'directory', optional = false): Promise<Stats | null> {
    this.check()
    if (!safeRelative(path)) { this.warn('unsafe', path, '来源路径无效，未纳入搜索。'); return null }
    let current = this.root
    const segments = path.replaceAll('\\', '/').split('/')
    try {
      for (let index = 0; index < segments.length; index += 1) {
        this.check()
        current = join(current, segments[index])
        const info = await lstat(current)
        if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : expected === 'file' ? !info.isFile() : !info.isDirectory())) {
          this.warn('unsafe', path, '来源须为项目内的普通文件或目录，不能使用符号链接。')
          return null
        }
        if (index === segments.length - 1) {
          const actual = relative(this.root, await realpath(current))
          this.check()
          if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) {
            this.warn('unsafe', path, '来源位于项目目录之外，未纳入搜索。')
            return null
          }
          return info
        }
      }
    } catch (error) { this.failure(path, error, optional) }
    return null
  }

  async entries(path: string): Promise<Dirent[]> {
    if (this.stopped || !await this.entry(path, 'directory', true)) return []
    if (this.directories >= 256) { this.warn('limit', path, '目录数量超过搜索上限。'); return [] }
    this.directories += 1
    const entries: Dirent[] = []
    try {
      const directory = await opendir(join(this.root, path))
      for await (const entry of directory) {
        this.check()
        if (entries.length >= 4000) { this.warn('limit', path, '目录条目超过搜索上限。'); break }
        entries.push(entry)
      }
    } catch (error) { this.failure(path, error) }
    return entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  }

  async read(path: string, optional = false): Promise<string | null> {
    if (this.stopped) return null
    const optionalInfo = optional ? await this.entry(path, 'file', true) : undefined
    if (optional && !optionalInfo) return null
    if (this.attemptedFiles >= this.maxFiles) {
      this.warn('limit', path, '搜索已达到文件数量上限。')
      this.stopped = true
      return null
    }
    this.attemptedFiles += 1
    const info = optionalInfo ?? await this.entry(path, 'file')
    if (!info) return null
    if (info.size > this.maxFileBytes) { this.warn('too_large', path, '来源超过单文件搜索字节上限。'); return null }
    if (this.scannedFiles >= this.maxFiles || this.scannedBytes + info.size > this.maxBytes) {
      this.warn('limit', path, '搜索已达到文件数量或总字节上限。')
      this.stopped = true
      return null
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(join(this.root, path), 'r')
      const current = await handle.stat()
      const entry = await this.entry(path, 'file')
      if (!entry) return null
      if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev || current.ino !== entry.ino || current.dev !== entry.dev || current.size !== info.size || current.mtimeMs !== info.mtimeMs) {
        this.warn('unreadable', path, '来源在搜索时已更新，请重新搜索。')
        return null
      }
      const bytes = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < bytes.length) {
        this.check()
        const part = await handle.read(bytes, length, Math.min(64 * 1024, bytes.length - length), length)
        if (!part.bytesRead) break
        length += part.bytesRead
      }
      this.check()
      this.scannedFiles += 1
      this.scannedBytes += length
      const after = await handle.stat()
      if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
        this.warn('unreadable', path, '来源在搜索时已更新，请重新搜索。')
        return null
      }
      if (bytes.subarray(0, length).includes(0)) { this.warn('unsupported', path, '二进制来源未纳入文本搜索。'); return null }
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)) }
      catch { this.warn('unsupported', path, '来源不是 UTF-8 文本，未纳入搜索。'); return null }
    } catch (error) { this.failure(path, error); return null }
    finally { await handle?.close() }
  }

  async json(path: string, optional = false): Promise<JsonRecord | null> {
    const content = await this.read(path, optional)
    if (content === null) return null
    try {
      const value = record(JSON.parse(content))
      if (!value) throw new Error('invalid')
      return value
    } catch { this.warn('invalid', path, '来源 JSON 格式无效，未纳入搜索。'); return null }
  }

  async add(document: SearchDocument, field: ProjectSearchField, value: unknown, provenance: ProjectSearchProvenance = 'record', suffix = ''): Promise<void> {
    this.check()
    if (this.stopped || !this.wants(document.kind) || !this.accepts(field, provenance)) return
    const content = text(value)
    if (!content) return
    this.fingerprint.update(JSON.stringify([document.id, document.title, document.target, document.sourcePath, field, provenance, suffix]))
    this.fingerprint.update(String(Buffer.byteLength(content, 'utf8'))).update(':').update(content)
    const source = searchable(content, Boolean(this.options.caseSensitive))
    const hasLocation = document.target.type === 'writing' || document.sourcePath?.startsWith('.repaper/submissions/sources/')
    let line = 1
    let previousNewline = -1
    let nextNewline = hasLocation ? content.indexOf('\n') : -1
    let visitedLines = 0
    let matches = 0
    let found = source.value.indexOf(this.needle)
    while (found !== -1) {
      this.check()
      if (this.total >= this.maxResults) {
        this.warn('limit', document.sourcePath ?? '', '匹配数量超过搜索上限，请缩小关键词或筛选范围。')
        this.stopped = true
        return
      }
      const match = source.sourceRange(found, found + this.needle.length)
      if (this.total >= this.offset && this.results.length < this.limit) {
        const start = Math.max(0, match.start - 85)
        const end = Math.min(content.length, Math.max(match.end + 85, start + 170))
        const prefix = start ? '…' : ''
        const snippet = prefix + content.slice(start, end).replace(/[\r\n\t]/g, ' ') + (end < content.length ? '…' : '')
        const ranges = [{ start: match.start - start + prefix.length, end: match.end - start + prefix.length }]
        while (nextNewline !== -1 && nextNewline < match.start) {
          line += 1
          previousNewline = nextNewline
          nextNewline = content.indexOf('\n', nextNewline + 1)
          if (++visitedLines % 2048 === 0) { await yieldToEventLoop(); this.check() }
        }
        const location = hasLocation ? { line, column: match.start - previousNewline } : undefined
        const target = document.target.type === 'writing' ? { ...document.target, ...location } : document.target
        this.results.push({ id: `${document.id}:${field}:${suffix}:${match.start}`, kind: document.kind, field, provenance,
          title: document.title, snippet, ranges, match: { ...match, ...location }, target, sourcePath: document.sourcePath })
      }
      this.total += 1
      if (++matches % 64 === 0) { await yieldToEventLoop(); this.check() }
      found = source.value.indexOf(this.needle, found + this.needle.length)
    }
  }

  response(): ProjectSearchResponse {
    const nextOffset = this.offset + this.results.length
    return { query: this.query, fingerprint: this.fingerprint.copy().digest('hex'), requestId: this.options.requestId, results: this.results, total: this.total,
      totalIsExact: !this.incomplete, truncated: this.incomplete, offset: this.offset, limit: this.limit,
      nextOffset: this.results.length && nextOffset < this.total ? nextOffset : undefined,
      warnings: this.warnings, scannedFiles: this.scannedFiles, scannedBytes: this.scannedBytes }
  }
}

function resultText(block: JsonRecord): string {
  if (block.type === 'text') return text(block.text)
  if (block.type === 'figure') return [text(block.title), text(block.caption)].filter(Boolean).join('\n')
  if (block.type === 'table') return [text(block.title), strings(block.columns).join(' | '),
    ...(Array.isArray(block.rows) ? block.rows.map(row => Array.isArray(row) ? row.filter(cell => typeof cell === 'string' || typeof cell === 'number').join(' | ') : '') : [])].filter(Boolean).join('\n')
  return ''
}

async function addExperimentOverview(reader: SearchReader, document: SearchDocument, overview: JsonRecord, suffix = ''): Promise<void> {
  await reader.add(document, 'summary', overview.subtitle, 'record', suffix)
  await reader.add(document, 'design', overview.designReason, 'record', suffix)
  await reader.add(document, 'settings', records(overview.keySettings).map(setting => `${text(setting.label)}: ${text(setting.value)}`).join('\n'), 'record', suffix)
  for (const [index, block] of records(overview.results).entries()) await reader.add(document, 'results', resultText(block), 'record', `${suffix}:${index}`)
  await reader.add(document, 'conclusion', overview.conclusion, 'record', suffix)
}

async function manuscripts(reader: SearchReader, path = '.paper', depth = 0): Promise<void> {
  if (!reader.wants('manuscript') || !reader.accepts('content', 'original') || reader.stopped) return
  if (depth > 10) { reader.warn('limit', path, '文稿目录深度超过搜索上限。'); return }
  for (const entry of await reader.entries(path)) {
    reader.check()
    if (reader.stopped) break
    if (entry.isSymbolicLink()) { reader.warn('unsafe', `${path}/${entry.name}`, '符号链接未纳入搜索。'); continue }
    if (entry.name.startsWith('.') || entry.name.endsWith('~') || /\.(tmp|bak|log|aux|bbl|blg|toc|out|synctex)$/i.test(entry.name)) continue
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name.toLowerCase())) await manuscripts(reader, `${path}/${entry.name}`, depth + 1)
    } else if (entry.isFile() && manuscriptExtensions.has(extname(entry.name).toLowerCase())) {
      const sourcePath = `${path}/${entry.name}`
      const content = await reader.read(sourcePath)
      if (content !== null) await reader.add({ id: sourcePath, kind: 'manuscript', title: sourcePath.slice(7), sourcePath,
        target: { type: 'writing', path: sourcePath.slice(7), line: 1, column: 1 } }, 'content', content, 'original')
    }
  }
}

async function jsonRecords(reader: SearchReader, path: string, consume: (value: JsonRecord, sourcePath: string) => Promise<void> | void): Promise<void> {
  for (const entry of await reader.entries(path)) {
    if (reader.stopped) break
    if (!entry.name.endsWith('.json')) continue
    const sourcePath = `${path}/${entry.name}`
    const value = await reader.json(sourcePath)
    if (value) await consume(value, sourcePath)
    await yieldToEventLoop()
    reader.check()
  }
}

const literatureUuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const literatureDocumentIdPattern = new RegExp(`^ld_${literatureUuid}$`)
const literatureAnnotationIdPattern = new RegExp(`^la_${literatureUuid}$`)

function literatureText(value: unknown, maxBytes: number, required = false): value is string {
  return typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= maxBytes && (!required || Boolean(value.trim()))
}

function literatureTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

// Mirror literature.ts's read contract without invoking its store or initializing directories.
function literatureDocument(value: unknown): LiteratureDocument | null {
  const item = record(value)
  if (!item || typeof item.id !== 'string' || !literatureDocumentIdPattern.test(item.id) ||
    !literatureText(item.title, 2048, true) || !literatureText(item.originalName, 1024, true) ||
    item.originalName !== basename(item.originalName) || /[\\/]/.test(item.originalName) || item.pdfPath !== `pdfs/${item.id}.pdf` ||
    typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 8 || item.size > 100 * MiB ||
    typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
    !literatureTimestamp(item.createdAt) || !literatureTimestamp(item.updatedAt)) return null
  return { id: item.id, title: item.title, originalName: item.originalName, pdfPath: `pdfs/${item.id}.pdf`,
    size: item.size, sha256: item.sha256, createdAt: item.createdAt, updatedAt: item.updatedAt }
}

function literatureRect(value: unknown): LiteratureRect | null {
  const item = record(value)
  if (!item) return null
  const { x, y, width, height } = item
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number' ||
    ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
    x > 1 || y > 1 || width > 1 || height > 1 || x + width > 1 || y + height > 1) return null
  return { x, y, width, height }
}

function literatureAnnotation(value: unknown, documentId: string): LiteratureAnnotation | null {
  const item = record(value)
  if (!item || typeof item.id !== 'string' || !literatureAnnotationIdPattern.test(item.id) || item.documentId !== documentId ||
    item.expectedRevision !== undefined || (item.kind !== 'highlight' && item.kind !== 'underline' && item.kind !== 'note') ||
    (item.color !== 'yellow' && item.color !== 'green' && item.color !== 'blue' && item.color !== 'pink') ||
    typeof item.page !== 'number' || !Number.isSafeInteger(item.page) || item.page < 1 || item.page > 1_000_000 ||
    !Array.isArray(item.rects) || item.rects.length > 200 || !literatureText(item.quote, 64 * 1024) || !literatureText(item.note, 64 * 1024) ||
    typeof item.revision !== 'number' || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
    !literatureTimestamp(item.createdAt) || !literatureTimestamp(item.updatedAt)) return null
  const rects: LiteratureRect[] = []
  for (const value of item.rects) {
    const rect = literatureRect(value)
    if (!rect) return null
    rects.push(rect)
  }
  if (item.kind === 'note' ? !item.note.trim() : !rects.length || item.quote !== '' && !item.quote.trim()) return null
  const draft: Pick<LiteratureAnnotation, 'kind' | 'page' | 'quote' | 'note' | 'color' | 'rects'> = {
    kind: item.kind, page: item.page, quote: item.quote, note: item.note, color: item.color, rects
  }
  if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > 128 * 1024) return null
  return { ...draft, id: item.id, documentId, revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt }
}

async function literature(reader: SearchReader): Promise<void> {
  if (!reader.wants('literature') || reader.stopped) return
  const sourcePath = '.repaper/literature/state.json'
  const state = await reader.json(sourcePath, true)
  if (!state) return
  if (state.schemaVersion !== 1 || !Array.isArray(state.documents) || state.documents.length > 10_000) {
    reader.warn('invalid', sourcePath, '文献记录格式不受支持，未纳入搜索。')
    return
  }
  const documents: LiteratureDocument[] = []
  const documentIds = new Set<string>()
  const hashes = new Set<string>()
  for (const value of state.documents) {
    reader.check()
    const item = literatureDocument(value)
    if (!item || documentIds.has(item.id) || hashes.has(item.sha256)) {
      reader.warn('invalid', sourcePath, '文献索引含有损坏或重复的记录，未纳入搜索。')
      return
    }
    documentIds.add(item.id)
    hashes.add(item.sha256)
    documents.push(item)
    if (documents.length % 64 === 0) { await yieldToEventLoop(); reader.check() }
  }
  for (const item of documents) {
    reader.check()
    if (reader.stopped) break
    const documentId = item.id
    const document: SearchDocument = { id: `literature:${documentId}`, kind: 'literature', title: item.title,
      sourcePath, target: { type: 'literature', documentId } }
    await reader.add(document, 'title', item.title)
    if (item.originalName !== item.title) await reader.add(document, 'title', item.originalName, 'record', 'original-name')
    if (!reader.accepts('original', 'original') && !reader.accepts('notes', 'record')) continue
    const annotationsPath = `.repaper/literature/annotations/${documentId}.json`
    // A document has no annotations file until its first annotation is saved.
    const state = await reader.json(annotationsPath, true)
    if (!state) continue
    if (state.schemaVersion !== 1 || !Array.isArray(state.annotations) || state.annotations.length > 5000) {
      reader.warn('invalid', annotationsPath, '文献批注记录格式不受支持，未纳入搜索。')
      continue
    }
    const annotations: LiteratureAnnotation[] = []
    const annotationIds = new Set<string>()
    let valid = true
    for (const value of state.annotations) {
      reader.check()
      const annotation = literatureAnnotation(value, documentId)
      if (!annotation || annotationIds.has(annotation.id)) {
        reader.warn('invalid', annotationsPath, '文献批注文件含有损坏、重复或文献关联无效的记录，未纳入搜索。')
        valid = false
        break
      }
      annotationIds.add(annotation.id)
      annotations.push(annotation)
      if (annotations.length % 64 === 0) { await yieldToEventLoop(); reader.check() }
    }
    if (!valid) continue
    for (const annotation of annotations) {
      reader.check()
      if (reader.stopped) break
      const source: SearchDocument = { ...document, id: `literature-annotation:${documentId}:${annotation.id}`, sourcePath: annotationsPath,
        target: { type: 'literature', documentId, annotationId: annotation.id, page: annotation.page } }
      if (annotation.quote) await reader.add(source, 'original', annotation.quote, 'original')
      await reader.add(source, 'notes', annotation.note, 'record')
      await yieldToEventLoop()
    }
    await yieldToEventLoop()
  }
}

async function experiments(reader: SearchReader): Promise<void> {
  if (!reader.wants('experiment')) return
  const items = new Map<string, SearchDocument>()
  await jsonRecords(reader, '.repaper/experiments/items', async (item, sourcePath) => {
    const id = text(item.id)
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) { reader.warn('invalid', sourcePath, '实验标识无效，未纳入搜索。'); return }
    const groupKey = text(item.groupKey) || id.split('/')[0]
    const overview = record(item.overview)
    const target: ProjectSearchTarget = { type: 'experiment', experimentId: id, groupKey, revisionId: text(overview?.revisionId) || undefined }
    const document: SearchDocument = { id: `experiment:${id}`, kind: 'experiment', title: text(item.title) || id, target, sourcePath }
    const originalDocument: SearchDocument = { ...document, target: { type: 'experiment', experimentId: id, groupKey, original: true } }
    items.set(id, document)
    await reader.add(document, 'title', item.title)
    if (overview) {
      await addExperimentOverview(reader, document, overview)
      const legacy: JsonRecord = {}
      for (const key of ['subtitle', 'designReason', 'keySettings', 'results', 'conclusion']) {
        if (item[key] !== undefined && JSON.stringify(item[key]) !== JSON.stringify(overview[key])) legacy[key] = item[key]
      }
      await addExperimentOverview(reader, originalDocument, legacy, 'legacy')
    } else await addExperimentOverview(reader, originalDocument, item)
    await reader.add(originalDocument, 'design', [text(item.question), text(item.description)].filter(Boolean).join('\n'), 'record', 'legacy')
    await reader.add(originalDocument, 'settings', item.factor, 'record', 'legacy')
    await reader.add(originalDocument, 'results', item.result, 'record', 'legacy')
    await reader.add(originalDocument, 'settings', item.configPath, 'record', 'config')
    await reader.add(document, 'notes', record(item.importance)?.reason, 'record', 'importance')
  })
  if (reader.stopped) return
  await jsonRecords(reader, '.repaper/experiments/groups', async (group, sourcePath) => {
    const groupKey = text(group.key)
    if (!groupKey) { reader.warn('invalid', sourcePath, '实验组标识缺失。'); return }
    const source: SearchDocument = { id: `group:${groupKey}`, kind: 'experiment', title: `实验组：${text(group.title) || groupKey}`,
      target: { type: 'experiment_group', groupKey }, sourcePath }
    await reader.add(source, 'title', group.title)
    await reader.add(source, 'objective', group.goal)
    await reader.add(source, 'settings', group.metric)
    await reader.add(source, 'settings', group.configPath, 'record', 'config')
  })
  for (const document of items.values()) {
    if (reader.stopped) break
    if (document.target.type !== 'experiment' || !document.target.revisionId) continue
    const { experimentId, revisionId } = document.target
    const path = `.repaper/experiments/revisions/${experimentId.replace('/', '--')}`
    for (const entry of await reader.entries(path)) {
      if (reader.stopped) break
      if (!entry.name.endsWith('.json') || entry.name === `${revisionId}.json`) continue
      const sourcePath = `${path}/${entry.name}`
      const revision = await reader.json(sourcePath)
      if (!revision) continue
      if (revision.schemaVersion !== 1 || !text(revision.revisionId)) { reader.warn('invalid', sourcePath, '实验概览修订格式无效。'); continue }
      const target: ProjectSearchTarget = { type: 'experiment', experimentId, groupKey: document.target.groupKey, revisionId: text(revision.revisionId) }
      await addExperimentOverview(reader, { ...document, id: `experiment-revision:${experimentId}:${text(revision.revisionId)}`,
        title: `${document.title} · 历史概览`, sourcePath, target }, revision)
      await yieldToEventLoop()
      reader.check()
    }
  }
  // Run JSON contains structured evidence summaries; logs and artifact contents are never opened.
  await jsonRecords(reader, '.repaper/experiments/runs', async (run, sourcePath) => {
    const document = items.get(text(run.experimentId))
    if (!document || !text(run.id)) { reader.warn('invalid', sourcePath, '运行缺少有效的实验关联，未纳入搜索。'); return }
    const target = document.target.type === 'experiment' ? { ...document.target, runId: text(run.id), revisionId: text(run.overviewRevisionId) || undefined } : document.target
    const source = { ...document, id: `run:${text(run.id)}`, title: `${document.title} · ${text(run.label) || text(run.id)}`, target, sourcePath }
    await reader.add(source, 'title', run.label)
    await reader.add(source, 'summary', run.summary)
    await reader.add(source, 'settings', strings(run.command).join(' '))
    await reader.add(source, 'settings', run.metricSource, 'record', 'metric-source')
    const metrics = record(run.metrics)
    if (metrics) await reader.add(source, 'results', Object.entries(metrics).filter(([, value]) => typeof value === 'number').map(([key, value]) => `${key}: ${value}`).join('\n'))
    await reader.add(source, 'results', run.error, 'record', 'error')
    await reader.add(source, 'results', strings(run.artifacts).join('\n'), 'record', 'artifact-paths')
  })
}

async function submissions(reader: SearchReader): Promise<Set<string>> {
  const known = new Set<string>()
  if (!reader.wants('submission')) return known
  const venues = new Map<string, string>()
  await jsonRecords(reader, '.repaper/submissions/attempts', async (attempt, sourcePath) => {
    const id = text(attempt.id)
    if (!id || !text(attempt.venue)) { reader.warn('invalid', sourcePath, '投稿标识或 venue 缺失，未纳入搜索。'); return }
    known.add(id)
    if (text(attempt.legacyId)) known.add(text(attempt.legacyId))
    venues.set(id, text(attempt.venue))
    const document: SearchDocument = { id: `submission:${id}`, kind: 'submission', title: text(attempt.venue), sourcePath, target: { type: 'submission', submissionId: id } }
    await reader.add(document, 'title', [text(attempt.venue), text(attempt.track), text(attempt.versionLabel)].filter(Boolean).join('\n'))
    await reader.add(document, 'notes', attempt.notes)
  })
  await jsonRecords(reader, '.repaper/submissions/events', async (event, sourcePath) => {
    const submissionId = text(event.submissionId)
    const eventId = text(event.id)
    if (!submissionId || !eventId || !Array.isArray(event.reviews) || !Array.isArray(event.sources)) { reader.warn('invalid', sourcePath, '投稿事件格式无效，未纳入搜索。'); return }
    if (!known.has(submissionId)) reader.warn('missing', sourcePath, '投稿事件关联的投稿记录缺失；事件内容仍可搜索。')
    const target: ProjectSearchTarget = { type: 'submission', submissionId, eventId }
    const document: SearchDocument = { id: `event:${eventId}`, kind: 'submission', title: [venues.get(submissionId), text(event.title) || text(event.kind)].filter(Boolean).join(' · '), target, sourcePath }
    await reader.add(document, 'title', event.title)
    await reader.add(document, 'summary', event.summary, 'ai_summary')
    await reader.add(document, 'decision', event.rawDecision, 'original')
    await reader.add(document, 'original', event.editorConclusion, 'original', 'editor')
    const materialIds = new Set(records(event.sources).map(material => text(material.id)))
    for (const review of records(event.reviews)) {
      if (!text(review.id)) { reader.warn('invalid', sourcePath, '审稿记录标识缺失。'); continue }
      if (strings(review.sourceIds).some(sourceId => !materialIds.has(sourceId))) reader.warn('missing', sourcePath, '审稿记录引用的原始材料缺失；原文仍可搜索。')
      const source: SearchDocument = { ...document, id: `review:${eventId}:${text(review.id)}`, title: `${document.title} · ${text(review.reviewer) || '审稿意见'}`,
        target: { ...target, reviewId: text(review.id) } }
      await reader.add(source, 'title', review.reviewer, 'original')
      await reader.add(source, 'score', review.rawScore, 'original')
      await reader.add(source, 'original', review.rawText, 'original')
      await reader.add(source, 'score', review.score, 'legacy_summary', 'legacy')
      for (const field of ['summary', 'strengths', 'concerns', 'requests']) await reader.add(source, 'summary', review[field], 'legacy_summary', field)
    }
    for (const material of records(event.sources)) {
      if (reader.stopped) break
      const sourceId = text(material.id)
      if (!sourceId) { reader.warn('invalid', sourcePath, '材料来源标识缺失。'); continue }
      const source: SearchDocument = { ...document, id: `source:${eventId}:${sourceId}`, title: `${document.title} · ${text(material.label) || '原始材料'}`,
        target: { ...target, sourceId } }
      await reader.add(source, 'title', material.label)
      await reader.add(source, 'url', material.url, 'original')
      await reader.add(source, 'original', material.text, 'original')
      if (!reader.accepts('original', 'original')) continue
      const path = text(material.path)
      if (!path) continue
      if (!/^sources\/[a-z0-9_-]+\.(pdf|eml|html?|txt|md|png|jpe?g|webp)$/i.test(path)) { reader.warn('unsafe', sourcePath, '材料来源路径无效，未读取附件。'); continue }
      const materialPath = `.repaper/submissions/${path}`
      if (!attachmentExtensions.has(extname(path).toLowerCase())) {
        if (await reader.entry(materialPath, 'file')) reader.warn('unsupported', materialPath, 'PDF 或图片附件未提取正文；已记录的原文仍可搜索。')
        continue
      }
      const content = await reader.read(materialPath)
      if (content !== null && ['.eml', '.html', '.htm'].includes(extname(path).toLowerCase())) {
        reader.warn('unsupported', materialPath, '邮件或网页附件尚未解码显示正文；当前仅检索附件源文本及已记录的原文。')
      }
      if (content !== null && content !== text(material.text)) await reader.add({ ...source, sourcePath: materialPath }, 'original', content, 'original', 'attachment')
    }
  })
  return known
}

async function overview(reader: SearchReader): Promise<void> {
  if (!reader.wants('overview')) return
  const sourcePath = '.repaper/overview/state.json'
  const state = await reader.json(sourcePath, true)
  if (!state) return
  if (state.schemaVersion !== 1 || !Array.isArray(state.nodes) || !Array.isArray(state.notes) || !record(state.summary)) {
    reader.warn('invalid', sourcePath, '概况记录格式不受支持，未纳入搜索。')
    return
  }
  const summary = record(state.summary)!
  const document: SearchDocument = { id: 'overview:summary', kind: 'overview', title: '研究概况', sourcePath, target: { type: 'overview' } }
  for (const key of ['question', 'claim', 'scope', 'next']) await reader.add(document, 'summary', summary[key], 'ai_summary', key)
  const edits = record(state.edits) ?? {}
  const nodeIds = new Set<string>()
  for (const node of records(state.nodes)) {
    reader.check()
    if (reader.stopped) break
    const nodeId = text(node.id)
    if (!nodeId) { reader.warn('invalid', sourcePath, '概况节点标识缺失。'); continue }
    nodeIds.add(nodeId)
    const edit = record(edits[nodeId])
    const source: SearchDocument = { ...document, id: `overview:${nodeId}`, title: text(edit?.title ?? node.title) || '研究节点', target: { type: 'overview', nodeId } }
    const provenance = node.origin === 'agent' ? 'ai_summary' : 'record'
    await reader.add(source, 'title', edit?.title ?? node.title, edit?.title === undefined ? provenance : 'record')
    await reader.add(source, 'summary', edit?.summary ?? node.summary, edit?.summary === undefined ? provenance : 'record')
    for (const key of ['before', 'after', 'reason']) await reader.add(source, 'notes', node[key], provenance, key)
    await yieldToEventLoop()
  }
  // Fact nodes are synthesized by the UI; their manual edits are persisted only in edits.
  for (const [nodeId, value] of Object.entries(edits)) {
    if (nodeIds.has(nodeId) || reader.stopped) continue
    const edit = record(value)
    if (!edit) continue
    const source: SearchDocument = { ...document, id: `overview-edit:${nodeId}`, title: text(edit.title) || '已编辑的研究记录', target: { type: 'overview', nodeId } }
    await reader.add(source, 'title', edit.title)
    await reader.add(source, 'summary', edit.summary)
  }
  for (const note of records(state.notes)) {
    if (reader.stopped) break
    const noteId = text(note.id)
    if (!noteId) { reader.warn('invalid', sourcePath, '思考记录标识缺失。'); continue }
    const source: SearchDocument = { ...document, id: `note:${noteId}`, title: text(note.text).split('\n')[0].slice(0, 80) || '思考记录', target: { type: 'overview', noteId } }
    await reader.add(source, 'notes', note.text, 'original')
    for (const [index, image] of records(note.images).entries()) await reader.add(source, 'title', image.label, 'record', `image:${index}`)
    await yieldToEventLoop()
  }
}

async function projectMetadata(reader: SearchReader, project: JsonRecord, knownSubmissions: Set<string>, sourcePath?: string): Promise<void> {
  const document: SearchDocument = { id: 'project', kind: 'project', title: text(project.title) || '项目', target: { type: 'project' }, sourcePath }
  await reader.add(document, 'title', project.title)
  await reader.add(document, 'summary', project.summary)
  for (const route of records(project.routes)) {
    if (!text(route.id)) continue
    const source: SearchDocument = { ...document, id: `route:${text(route.id)}`, kind: 'route', title: text(route.name), target: { type: 'route', routeId: text(route.id) } }
    await reader.add(source, 'title', route.name)
    await reader.add(source, 'objective', route.objective)
    for (const task of records(route.implementations)) {
      if (!text(task.id)) continue
      const implementation: SearchDocument = { ...source, id: `implementation:${text(task.id)}`, title: `${source.title} · ${text(task.title)}`, target: { type: 'route', routeId: text(route.id), implementationId: text(task.id) } }
      await reader.add(implementation, 'title', task.title)
      await reader.add(implementation, 'task', task.details)
    }
  }
  for (const revision of records(project.revisions)) {
    if (!text(revision.id)) continue
    const source: SearchDocument = { ...document, id: `revision:${text(revision.id)}`, kind: 'revision', title: text(revision.title), target: { type: 'revision', revisionId: text(revision.id), submissionId: text(revision.submissionId) || undefined } }
    await reader.add(source, 'title', revision.title)
    await reader.add(source, 'task', revision.notes)
  }
  for (const attempt of records(project.submissions)) {
    const submissionId = text(attempt.id)
    if (!submissionId || knownSubmissions.has(submissionId)) continue
    const source: SearchDocument = { ...document, id: `legacy-submission:${submissionId}`, kind: 'submission', title: text(attempt.venue), target: { type: 'submission', submissionId, legacy: true } }
    await reader.add(source, 'title', attempt.venue)
    await reader.add(source, 'notes', attempt.notes)
  }
  for (const version of records(project.versions)) {
    if (!text(version.id)) continue
    const source: SearchDocument = { ...document, id: `version:${text(version.id)}`, kind: 'manuscript', title: text(version.label) || '文稿版本记录', target: { type: 'overview', nodeId: `legacy-version:${text(version.id)}` } }
    await reader.add(source, 'title', version.label)
    await reader.add(source, 'notes', version.notes)
  }
}

/** Bounded, read-only, literal project search. Each call reads fresh sources and never initializes stores or invokes Git. */
export async function searchProject(root: string, query: string, options: ProjectSearchReadOptions = {}): Promise<ProjectSearchResponse> {
  if (typeof query !== 'string' || query.length > 256) throw new Error('搜索关键词须为 256 字以内的文本。')
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('搜索选项无效。')
  if (options.caseSensitive !== undefined && typeof options.caseSensitive !== 'boolean') throw new Error('大小写匹配选项无效。')
  if (options.requestId !== undefined && (typeof options.requestId !== 'string' || options.requestId.length > 256)) throw new Error('搜索请求标识无效。')
  options.signal?.throwIfAborted()
  const normalizedQuery = query.trim()
  if (typeof root !== 'string' || !root || root.includes('\0')) throw new Error('项目目录无效。')
  const actualRoot = await realpath(resolve(root))
  if (!(await lstat(actualRoot)).isDirectory()) throw new Error('项目目录不存在。')
  const reader = new SearchReader(actualRoot, normalizedQuery, options)
  if (!normalizedQuery || reader.kindFilter?.size === 0 || reader.fieldFilter?.size === 0 || reader.provenanceFilter?.size === 0) return reader.response()
  let project = record(options.project)
  let metadataPath: string | undefined
  if (!project && ['project', 'route', 'revision', 'submission', 'manuscript'].some(kind => reader.wants(kind as ProjectSearchKind))) {
    metadataPath = '.repaper/overview/project.json'
    project = await reader.json(metadataPath, true)
  }
  // Records precede manuscript files so a large manuscript cannot hide small structured sources.
  const knownSubmissions = await submissions(reader)
  if (project) await projectMetadata(reader, project, knownSubmissions, metadataPath)
  await literature(reader)
  await experiments(reader)
  await overview(reader)
  await manuscripts(reader)
  reader.check()
  return reader.response()
}
