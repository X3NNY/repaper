import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rmdir, unlink, utimes } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type {
  LiteratureAnnotation, LiteratureAnnotationDraft, LiteratureDocument, LiteratureImportResult,
  LiteratureRect, LiteratureWorkspace
} from '../../shared/literature'

const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const documentIdPattern = new RegExp(`^ld_${uuidPattern}$`)
const annotationIdPattern = new RegExp(`^la_${uuidPattern}$`)
const maxPdfBytes = 100 * 1024 * 1024
const maxImportBytes = 500 * 1024 * 1024
const maxImportFiles = 20
const maxRecordBytes = 8 * 1024 * 1024
const maxDocuments = 10_000
const maxAnnotations = 5000
const maxRects = 200
const maxTextBytes = 64 * 1024
const maxAnnotationBytes = 128 * 1024
const maxTitleBytes = 2048

interface LiteratureState {
  schemaVersion: 1
  documents: LiteratureDocument[]
}

interface AnnotationState {
  schemaVersion: 1
  annotations: LiteratureAnnotation[]
}

interface ImportSource {
  path: string
  info: Stats
  originalName: string
}

function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException).code }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文献库记录格式无效。')
  return value as Record<string, unknown>
}
function within(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === '' || value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value)
}
function libraryDirectory(root: string): string { return join(root, '.repaper', 'literature') }
function documentId(id: string): string {
  if (typeof id !== 'string' || !documentIdPattern.test(id)) throw new Error('文献 ID 无效。')
  return id
}
function annotationId(id: string): string {
  if (typeof id !== 'string' || !annotationIdPattern.test(id)) throw new Error('批注 ID 无效。')
  return id
}
function annotationPath(root: string, id: string): string {
  return join(libraryDirectory(root), 'annotations', `${documentId(id)}.json`)
}
async function infoOrNull(path: string): Promise<Stats | null> {
  try { return await lstat(path) }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

// Check every component so Windows junctions and links in parent directories are rejected too.
async function ordinaryPath(path: string, kind: 'file' | 'directory'): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.length > 4096) throw new Error('文献库文件路径无效。')
  const absolute = resolve(path)
  const pathRoot = parse(absolute).root
  const parts = absolute.slice(pathRoot.length).split(sep).filter(Boolean)
  let current = pathRoot
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    const info = await lstat(current)
    const last = index === parts.length - 1
    if (info.isSymbolicLink()) throw new Error('文献库不能通过符号链接访问文件。')
    if ((!last || kind === 'directory') && !info.isDirectory() || last && kind === 'file' && !info.isFile()) {
      throw new Error(kind === 'file' ? '请选择普通 PDF 文件。' : '文献库目录无效。')
    }
  }
  const info = await lstat(absolute)
  if (info.isSymbolicLink() || kind === 'file' && !info.isFile() || kind === 'directory' && !info.isDirectory()) throw new Error('文献库路径无效。')
  return realpath(absolute)
}

async function projectRoot(root: string): Promise<string> { return ordinaryPath(root, 'directory') }

async function managedDirectories(root: string, parts: string[], create: boolean): Promise<string | null> {
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if (!within(root, current)) throw new Error('文献库目录必须位于项目内。')
    if (create) {
      try { await mkdir(current) }
      catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
    }
    const info = await infoOrNull(current)
    if (!info) return null
    if (!info.isDirectory() || info.isSymbolicLink() || !within(root, await realpath(current))) throw new Error('文献库目录必须位于项目内，且不能使用符号链接。')
  }
  return current
}

async function managedFile(root: string, path: string): Promise<Stats | null> {
  if (!within(libraryDirectory(root), path)) throw new Error('文献库文件必须位于项目文献库内。')
  const actual = await ordinaryPath(path, 'file').catch(error => {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  })
  if (actual === null) return null
  if (!within(root, actual) || !within(libraryDirectory(root), actual)) throw new Error('文献库文件必须位于项目文献库内。')
  return lstat(path)
}

async function openOrdinaryFile(path: string, maxBytes: number): Promise<{ file: FileHandle; before: Stats }> {
  await ordinaryPath(path, 'file')
  const before = await lstat(path)
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxBytes || info.dev !== before.dev || info.ino !== before.ino) throw new Error('文件已经改变，或超过文献库大小限制。')
    return { file, before: info }
  } catch (error) {
    await file.close()
    throw error
  }
}

async function stableFile(path: string, file: FileHandle, before: Stats, size: number): Promise<void> {
  await ordinaryPath(path, 'file')
  const after = await file.stat()
  const current = await lstat(path)
  if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
    current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size ||
    current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw new Error('文献库文件正在改变，请稍后重试。')
}

async function readBytes(path: string, maxBytes: number): Promise<Buffer> {
  const { file, before } = await openOrdinaryFile(path, maxBytes)
  try {
    const bytes = Buffer.alloc(before.size)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, Math.min(bytes.length - size, 1024 * 1024), size)
      if (!bytesRead) break
      size += bytesRead
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, size)
    if (extra.bytesRead) throw new Error('文献库文件正在改变，请稍后重试。')
    await stableFile(path, file, before, size)
    return bytes
  } finally { await file.close() }
}

async function readJson(root: string, path: string): Promise<unknown> {
  const info = await managedFile(root, path)
  if (!info) return undefined
  if (info.size > maxRecordBytes) throw new Error('文献库记录超过 8 MB。')
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(path, maxRecordBytes))) as unknown }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new Error('文献库记录不是有效的 UTF-8 JSON。')
    throw error
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null)
    if (!bytesWritten) throw new Error('无法保存文献库文件。')
    offset += bytesWritten
  }
}

async function removeTemporary(root: string, path: string): Promise<void> {
  const info = await managedFile(root, path)
  if (info) await unlink(path)
}

async function atomicJson(root: string, path: string, value: unknown): Promise<void> {
  await managedFile(root, path)
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  if (bytes.length > maxRecordBytes) throw new Error('文献库记录超过 8 MB，请减少批注内容。')
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await writeAll(file, bytes)
    await file.sync()
  } catch (error) {
    await file.close()
    await removeTemporary(root, temporary).catch(() => undefined)
    throw error
  }
  await file.close()
  try {
    await managedFile(root, temporary)
    await managedFile(root, path)
    await rename(temporary, path)
  } finally { await removeTemporary(root, temporary).catch(() => undefined) }
}

async function withLiteratureLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await managedDirectories(root, ['.repaper', 'literature'], true)
  const path = join(libraryDirectory(root), 'write.lock')
  const deadline = Date.now() + 15_000
  let acquired: Stats
  while (true) {
    try {
      await mkdir(path)
      acquired = await lstat(path)
      if (!acquired.isDirectory() || acquired.isSymbolicLink()) throw new Error('文献库保存锁无效。')
      break
    }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      const info = await infoOrNull(path)
      if (info?.isSymbolicLink() || info && !info.isDirectory()) throw new Error('文献库保存锁无效。')
      if (info && Date.now() - info.mtimeMs > 300_000) await rmdir(path).catch(() => undefined)
      if (Date.now() > deadline) throw new Error('文献库正在保存，请稍后重试。')
      await new Promise(done => setTimeout(done, 80))
    }
  }
  const heartbeat = setInterval(() => {
    void (async () => {
      const info = await infoOrNull(path)
      if (!info || info.isSymbolicLink() || !info.isDirectory() || info.dev !== acquired.dev || info.ino !== acquired.ino) return
      const now = new Date()
      await utimes(path, now, now)
    })().catch(() => undefined)
  }, 15_000)
  heartbeat.unref()
  try {
    await managedDirectories(root, ['.repaper', 'literature', 'pdfs'], true)
    await managedDirectories(root, ['.repaper', 'literature', 'annotations'], true)
    return await action()
  } finally {
    clearInterval(heartbeat)
    const info = await infoOrNull(path)
    if (info && !info.isSymbolicLink() && info.isDirectory() && info.dev === acquired.dev && info.ino === acquired.ino) await rmdir(path).catch(() => undefined)
  }
}

function text(value: unknown, name: string, maxBytes: number, required = false): string {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes || required && !value.trim()) throw new Error(`${name}无效或超过大小限制。`)
  return value
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error('文献库记录时间无效。')
  return value
}
function revision(value: unknown, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error('批注版本无效，请重新加载。')
  return value
}
function cleanDocument(value: unknown): LiteratureDocument {
  const data = object(value)
  const id = documentId(data.id as string)
  const originalName = text(data.originalName, 'PDF 原文件名', 1024, true)
  if (originalName !== basename(originalName) || /[\\/]/.test(originalName) || data.pdfPath !== `pdfs/${id}.pdf` ||
    typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 8 || data.size > maxPdfBytes ||
    typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('文献库 PDF 记录无效。')
  return {
    id, title: text(data.title, '文献标题', maxTitleBytes, true), originalName, pdfPath: `pdfs/${id}.pdf`,
    size: data.size, sha256: data.sha256, createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt)
  }
}

async function state(root: string): Promise<LiteratureState> {
  if (!await managedDirectories(root, ['.repaper', 'literature'], false)) return { schemaVersion: 1, documents: [] }
  await managedDirectories(root, ['.repaper', 'literature', 'pdfs'], false)
  await managedDirectories(root, ['.repaper', 'literature', 'annotations'], false)
  const value = await readJson(root, join(libraryDirectory(root), 'state.json'))
  if (value === undefined) return { schemaVersion: 1, documents: [] }
  const data = object(value)
  if (data.schemaVersion !== 1 || !Array.isArray(data.documents) || data.documents.length > maxDocuments) throw new Error('文献库索引格式不受支持。')
  const documents = data.documents.map(cleanDocument)
  if (new Set(documents.map(item => item.id)).size !== documents.length || new Set(documents.map(item => item.sha256)).size !== documents.length) throw new Error('文献库索引存在重复记录。')
  return { schemaVersion: 1, documents }
}

function findDocument(data: LiteratureState, id: string): LiteratureDocument {
  documentId(id)
  const item = data.documents.find(document => document.id === id)
  if (!item) throw new Error('文献不存在，请重新加载文献库。')
  return item
}

function cleanRect(value: unknown): LiteratureRect {
  const data = object(value)
  const { x, y, width, height } = data
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number' ||
    ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
    x > 1 || y > 1 || width > 1 || height > 1 || x + width > 1 || y + height > 1) throw new Error('批注位置必须是页面内的归一化坐标。')
  return { x, y, width, height }
}

function cleanDraft(value: unknown): LiteratureAnnotationDraft {
  const data = object(value)
  if (!['highlight', 'underline', 'note'].includes(data.kind as string) || !['yellow', 'green', 'blue', 'pink'].includes(data.color as string) ||
    typeof data.page !== 'number' || !Number.isSafeInteger(data.page) || data.page < 1 || data.page > 1_000_000 ||
    !Array.isArray(data.rects) || data.rects.length > maxRects) throw new Error('批注类型、页码、颜色或位置无效。')
  const quote = text(data.quote, '选文原文', maxTextBytes)
  const note = text(data.note, '批注文字', maxTextBytes)
  const rects = data.rects.map(cleanRect)
  if (data.kind === 'note' ? !note.trim() : !quote.trim() || !rects.length) throw new Error(data.kind === 'note' ? '页码笔记需要填写文字。' : '高亮和划线需要选文原文及页面位置。')
  const draft: LiteratureAnnotationDraft = {
    kind: data.kind as LiteratureAnnotationDraft['kind'], page: data.page, quote, note,
    color: data.color as LiteratureAnnotationDraft['color'], rects
  }
  if (data.expectedRevision !== undefined) draft.expectedRevision = revision(data.expectedRevision, true)
  if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > maxAnnotationBytes) throw new Error('单条批注超过 128 KB，请减少文字或选区。')
  return draft
}

function cleanAnnotation(value: unknown, id: string): LiteratureAnnotation {
  const data = object(value)
  if (data.documentId !== id || data.expectedRevision !== undefined) throw new Error('批注所属文献或记录格式无效。')
  const draft = cleanDraft(data)
  return {
    kind: draft.kind, page: draft.page, quote: draft.quote, note: draft.note, color: draft.color, rects: draft.rects,
    id: annotationId(data.id as string), documentId: id, revision: revision(data.revision),
    createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt)
  }
}

function sameRects(left: LiteratureRect[], right: LiteratureRect[]): boolean {
  return left.length === right.length && left.every((rect, index) => {
    const other = right[index]
    return rect.x === other.x && rect.y === other.y && rect.width === other.width && rect.height === other.height
  })
}

function requireOriginalAnchor(old: LiteratureAnnotation, draft: LiteratureAnnotationDraft): void {
  const anchoredPage = old.kind !== 'note' || Boolean(old.quote) || old.rects.length > 0
  if (draft.kind !== old.kind || draft.quote !== old.quote || !sameRects(draft.rects, old.rects) || anchoredPage && draft.page !== old.page) {
    throw new Error('已有批注的选文原文和位置不能覆盖。带选文或位置的批注只能修改笔记或颜色；独立页码笔记还可以修改页码。')
  }
}

async function annotationState(root: string, id: string): Promise<AnnotationState> {
  documentId(id)
  if (!await managedDirectories(root, ['.repaper', 'literature', 'annotations'], false)) return { schemaVersion: 1, annotations: [] }
  const value = await readJson(root, annotationPath(root, id))
  if (value === undefined) return { schemaVersion: 1, annotations: [] }
  const data = object(value)
  if (data.schemaVersion !== 1 || !Array.isArray(data.annotations) || data.annotations.length > maxAnnotations) throw new Error('文献批注记录格式不受支持。')
  const annotations = data.annotations.map(item => cleanAnnotation(item, id))
  if (new Set(annotations.map(item => item.id)).size !== annotations.length) throw new Error('文献批注存在重复 ID。')
  return { schemaVersion: 1, annotations }
}

function pdfHeader(bytes: Uint8Array): void {
  if (bytes.length < 8 || !/^%PDF-(?:1\.[0-9]|2\.0)/.test(Buffer.from(bytes.subarray(0, 8)).toString('latin1'))) throw new Error('所选文件缺少有效的 PDF 文件头。')
}

async function copyPdf(root: string, source: ImportSource, temporary: string): Promise<{ size: number; sha256: string }> {
  const { file, before } = await openOrdinaryFile(source.path, maxPdfBytes)
  if (before.dev !== source.info.dev || before.ino !== source.info.ino || before.size !== source.info.size ||
    before.mtimeMs !== source.info.mtimeMs || before.ctimeMs !== source.info.ctimeMs) {
    await file.close()
    throw new Error('所选 PDF 已经改变，请重新选择文件。')
  }
  let output: FileHandle | undefined
  try {
    output = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(1024 * 1024)
    let size = 0
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, size)
      if (!bytesRead) break
      if (!size) pdfHeader(chunk.subarray(0, bytesRead))
      size += bytesRead
      if (size > maxPdfBytes) throw new Error('单个 PDF 不能超过 100 MB。')
      const bytes = chunk.subarray(0, bytesRead)
      hash.update(bytes)
      await writeAll(output, bytes)
    }
    if (!size) throw new Error('所选 PDF 文件为空。')
    await stableFile(source.path, file, before, size)
    await output.sync()
    return { size, sha256: hash.digest('hex') }
  } finally {
    await file.close()
    await output?.close()
    await managedFile(root, temporary)
  }
}

export async function loadLiterature(root: string): Promise<LiteratureWorkspace> {
  const data = await state(await projectRoot(root))
  return { documents: data.documents }
}

// Only the main process may supply paths from native selection or dropped Files verified by the preload.
export async function importLiterature(root: string, paths: string[]): Promise<LiteratureImportResult> {
  const project = await projectRoot(root)
  if (!Array.isArray(paths) || paths.length > maxImportFiles) throw new Error('一次最多导入 20 个 PDF。')
  if (!paths.length) return { documents: (await state(project)).documents, importedIds: [], duplicateIds: [] }
  const sources: ImportSource[] = []
  let totalBytes = 0
  for (const path of paths) {
    const source = await ordinaryPath(path, 'file')
    const info = await lstat(source)
    if (extname(source).toLowerCase() !== '.pdf' || info.size < 8 || info.size > maxPdfBytes) throw new Error('请选择 100 MB 以内的普通 PDF 文件。')
    totalBytes += info.size
    if (totalBytes > maxImportBytes) throw new Error('一次导入的 PDF 总大小不能超过 500 MB。')
    const originalName = text(basename(source), 'PDF 原文件名', 1024, true)
    sources.push({ path: source, info, originalName })
  }
  return withLiteratureLock(project, async () => {
    const data = await state(project)
    const importedIds: string[] = []
    const duplicateIds: string[] = []
    const created: string[] = []
    const pending = new Set<string>()
    try {
      for (const source of sources) {
        const id = `ld_${randomUUID()}`
        const temporary = join(libraryDirectory(project), 'pdfs', `${id}.${randomUUID()}.tmp`)
        pending.add(temporary)
        const { size, sha256 } = await copyPdf(project, source, temporary)
        const duplicate = data.documents.find(item => item.sha256 === sha256)
        if (duplicate) {
          if (!duplicateIds.includes(duplicate.id)) duplicateIds.push(duplicate.id)
          await removeTemporary(project, temporary)
          pending.delete(temporary)
          continue
        }
        if (data.documents.length >= maxDocuments) throw new Error('文献库最多保存 10,000 篇文献。')
        const pdfPath = `pdfs/${id}.pdf`
        const target = join(libraryDirectory(project), 'pdfs', `${id}.pdf`)
        if (await managedFile(project, target)) throw new Error('文献 ID 冲突，请重新导入。')
        await managedFile(project, temporary)
        await rename(temporary, target)
        created.push(target)
        pending.delete(temporary)
        const now = new Date().toISOString()
        data.documents.push({
          id, title: text(source.originalName.slice(0, -4).trim() || source.originalName, '文献标题', maxTitleBytes, true),
          originalName: source.originalName, pdfPath, size, sha256, createdAt: now, updatedAt: now
        })
        importedIds.push(id)
      }
      if (importedIds.length) await atomicJson(project, join(libraryDirectory(project), 'state.json'), data)
      return { documents: data.documents, importedIds, duplicateIds }
    } catch (error) {
      for (const path of created) await removeTemporary(project, path).catch(() => undefined)
      throw error
    } finally {
      for (const path of pending) await removeTemporary(project, path).catch(() => undefined)
    }
  })
}

export async function readLiteraturePdf(root: string, id: string): Promise<Uint8Array> {
  const project = await projectRoot(root)
  const document = findDocument(await state(project), id)
  const path = join(libraryDirectory(project), 'pdfs', `${document.id}.pdf`)
  const info = await managedFile(project, path)
  if (!info || info.size !== document.size) throw new Error('文献 PDF 缺失，或大小与文献库记录不一致。')
  const bytes = await readBytes(path, maxPdfBytes)
  pdfHeader(bytes)
  if (createHash('sha256').update(bytes).digest('hex') !== document.sha256) throw new Error('文献 PDF 内容与导入记录不一致。')
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export async function renameLiteratureDocument(root: string, id: string, title: string): Promise<LiteratureDocument> {
  documentId(id)
  const cleanTitle = text(title, '文献标题', maxTitleBytes, true).trim()
  const project = await projectRoot(root)
  return withLiteratureLock(project, async () => {
    const data = await state(project)
    const document = findDocument(data, id)
    if (document.title === cleanTitle) return document
    const updated = { ...document, title: cleanTitle, updatedAt: new Date().toISOString() }
    data.documents[data.documents.indexOf(document)] = updated
    await atomicJson(project, join(libraryDirectory(project), 'state.json'), data)
    return updated
  })
}

export async function listLiteratureAnnotations(root: string, id: string): Promise<LiteratureAnnotation[]> {
  const project = await projectRoot(root)
  findDocument(await state(project), id)
  return (await annotationState(project, id)).annotations
}

export async function saveLiteratureAnnotation(root: string, id: string, draft: LiteratureAnnotationDraft, requestedId?: string): Promise<LiteratureAnnotation> {
  documentId(id)
  if (requestedId !== undefined) annotationId(requestedId)
  const clean = cleanDraft(draft)
  const expectedRevision = clean.expectedRevision
  const project = await projectRoot(root)
  return withLiteratureLock(project, async () => {
    findDocument(await state(project), id)
    const data = await annotationState(project, id)
    const old = requestedId === undefined ? undefined : data.annotations.find(item => item.id === requestedId)
    if (requestedId !== undefined && !old) throw new Error('批注不存在，请重新加载。')
    if (old ? expectedRevision !== old.revision : expectedRevision !== undefined && expectedRevision !== 0) throw new Error('批注已在另一个会话中修改，请重新加载后编辑。')
    if (old) requireOriginalAnchor(old, clean)
    if (!old && data.annotations.length >= maxAnnotations) throw new Error('每篇文献最多保存 5,000 条批注。')
    const now = new Date().toISOString()
    const saved: LiteratureAnnotation = {
      kind: clean.kind, page: clean.page, quote: clean.quote, note: clean.note, color: clean.color, rects: clean.rects,
      id: old?.id ?? `la_${randomUUID()}`, documentId: id, revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? now, updatedAt: now
    }
    if (!Number.isSafeInteger(saved.revision)) throw new Error('批注版本超过支持范围。')
    if (old) data.annotations[data.annotations.indexOf(old)] = saved
    else data.annotations.push(saved)
    await atomicJson(project, annotationPath(project, id), data)
    return saved
  })
}

export async function deleteLiteratureAnnotation(root: string, id: string, requestedId: string, expectedRevision: number): Promise<void> {
  documentId(id)
  annotationId(requestedId)
  const expected = revision(expectedRevision)
  const project = await projectRoot(root)
  await withLiteratureLock(project, async () => {
    findDocument(await state(project), id)
    const data = await annotationState(project, id)
    const old = data.annotations.find(item => item.id === requestedId)
    if (!old) throw new Error('批注不存在，请重新加载。')
    if (old.revision !== expected) throw new Error('批注已在另一个会话中修改，请重新加载后删除。')
    data.annotations = data.annotations.filter(item => item.id !== requestedId)
    await atomicJson(project, annotationPath(project, id), data)
  })
}
