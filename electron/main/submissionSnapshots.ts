import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, unlink, utimes, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { Zip, ZipPassThrough } from 'fflate'
import type {
  SubmissionSnapshot, SubmissionSnapshotCommitInspection, SubmissionSnapshotDraft, SubmissionSnapshotFile
} from '../../shared/submissionSnapshots'

const execFileAsync = promisify(execFile)
const attemptIdPattern = /^s_[a-f0-9-]{36}$/
const eventIdPattern = /^se_[a-f0-9-]{36}$/
const snapshotIdPattern = /^ss_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const maxSourceFiles = 2000
const maxSupplementFiles = 20
const maxFileBytes = 50 * 1024 * 1024
const maxSourceBytes = 250 * 1024 * 1024
const maxSupplementBytes = 200 * 1024 * 1024
const maxSnapshotBytes = 500 * 1024 * 1024
const maxManifestBytes = 2 * 1024 * 1024
const maxSubmissionRecordBytes = 8 * 1024 * 1024
const writingConfigFile = '.repaper-writing.json'

export interface SubmissionSnapshotFileSelection {
  pdfFilePath: string
  supplementFilePaths?: string[]
}

interface CommitFile { path: string; size: number; objectId: string }
interface CommitSource {
  root: string
  gitCommit: string
  mainFile: string
  files: CommitFile[]
  totalBytes: number
}

function snapshotStore(root: string): string { return join(root, '.repaper', 'submissions', 'snapshots') }
function snapshotDirectory(root: string, id: string): string {
  if (typeof id !== 'string' || !snapshotIdPattern.test(id)) throw new Error('投稿材料快照 ID 无效。')
  return join(snapshotStore(root), id)
}
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException).code }
async function infoOrNull(path: string) {
  try { return await lstat(path) }
  catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error }
}
function within(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === '' || value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value)
}

// Walk parent components as well: a junction in an otherwise ordinary path is a link.
async function ordinaryPath(path: string, kind: 'file' | 'directory'): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.length > 4096) throw new Error('文件路径无效。')
  const absolute = resolve(path)
  const pathRoot = parse(absolute).root
  const parts = absolute.slice(pathRoot.length).split(sep).filter(Boolean)
  let current = pathRoot
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error('投稿材料不能通过符号链接访问。')
    const last = index === parts.length - 1
    if ((!last || kind === 'directory') && !info.isDirectory() || last && kind === 'file' && !info.isFile()) {
      throw new Error(kind === 'file' ? '请选择普通材料文件。' : '投稿材料目录无效。')
    }
  }
  const info = await lstat(absolute)
  if (info.isSymbolicLink() || kind === 'file' && !info.isFile() || kind === 'directory' && !info.isDirectory()) throw new Error('投稿材料路径无效。')
  return realpath(absolute)
}

async function projectRoot(root: string): Promise<string> { return ordinaryPath(root, 'directory') }
async function managedDirectories(root: string, parts: string[]): Promise<string> {
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try { await mkdir(current) }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('投稿材料目录不能是符号链接或文件。')
  }
  return current
}

function portablePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\') || isAbsolute(value)) throw new Error('归档中存在不支持的文件路径。')
  const parts = value.split('/')
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' ||
    Buffer.byteLength(part, 'utf8') > 255 || /[<>:"|?*\u0000-\u001f\u007f]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('归档中存在不支持的文件路径：' + value)
  return value
}

function uniquePaths(paths: string[]): void {
  const seen = new Map<string, { path: string; directory: boolean }>()
  for (const path of paths) {
    portablePath(path)
    const parts = path.split('/')
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts.slice(0, index + 1).join('/')
      const key = name.normalize('NFC').toLowerCase()
      const directory = index < parts.length - 1
      const old = seen.get(key)
      if (old && (old.path !== name || old.directory !== directory || !directory)) throw new Error('归档中存在大小写冲突或重复的文件路径：' + path)
      seen.set(key, { path: name, directory })
    }
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key]
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

async function gitBytes(root: string, args: string[], maxBytes: number): Promise<Buffer> {
  try {
    const result = await execFileAsync('git', ['--no-pager', '--no-replace-objects', ...args], {
      cwd: root, env: gitEnvironment(), windowsHide: true, encoding: 'buffer', timeout: 30_000,
      maxBuffer: maxBytes + 1024
    })
    const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
    if (bytes.length > maxBytes) throw new Error('Git 文件超过归档大小限制。')
    return bytes
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error('找不到 Git，请先安装 Git。')
    const failure = error as Error & { stderr?: Buffer | string }
    const detail = failure.stderr ? String(failure.stderr).trim().slice(-500) : failure.message
    throw new Error('无法读取选定的 Git 提交：' + detail)
  }
}

function utf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error('Git 提交中存在不支持的文件名或主文件配置编码。') }
}

async function inspectCommit(root: string, requested: string): Promise<CommitSource> {
  if (typeof requested !== 'string' || !/^[a-f0-9]{7,64}$/i.test(requested)) throw new Error('请明确选择一个有效的文稿 Git 提交。')
  const writingRoot = await ordinaryPath(join(root, '.paper'), 'directory')
  const gitInfo = await infoOrNull(join(writingRoot, '.git'))
  if (!gitInfo || gitInfo.isSymbolicLink() || !gitInfo.isFile() && !gitInfo.isDirectory()) throw new Error('写作目录尚未初始化 Git。')
  const topLevel = utf8(await gitBytes(writingRoot, ['rev-parse', '--show-toplevel'], 4096)).trim()
  if (!isAbsolute(topLevel) || relative(writingRoot, await ordinaryPath(topLevel, 'directory')) !== '') throw new Error('选定提交必须属于 .paper 写作目录的 Git 仓库。')
  const gitCommit = utf8(await gitBytes(writingRoot, ['rev-parse', '--verify', `${requested.toLowerCase()}^{commit}`], 256)).trim()
  if (!commitPattern.test(gitCommit)) throw new Error('选定的 Git 提交不存在。')
  const output = utf8(await gitBytes(writingRoot, ['ls-tree', '-r', '-z', '-l', '--full-tree', gitCommit], maxManifestBytes))
  const files: CommitFile[] = []
  let totalBytes = 0
  for (const record of output.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40}|[a-f0-9]{64}) +([\d-]+)$/.exec(record.slice(0, tab))
    if (tab < 0 || !match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob') throw new Error('选定提交包含符号链接、子模块或不支持的条目。')
    const path = portablePath(record.slice(tab + 1))
    portablePath(`source/${path}`)
    const size = Number(match[4])
    if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) throw new Error('选定提交包含超过 50 MB 的文件。')
    totalBytes += size
    if (files.length >= maxSourceFiles || totalBytes > maxSourceBytes) throw new Error('文稿源码归档最多包含 2,000 个文件，总大小不能超过 250 MB。')
    files.push({ path, size, objectId: match[3] })
  }
  uniquePaths(files.map(file => file.path))
  let mainFile = 'manuscript.tex'
  const config = files.find(file => file.path === writingConfigFile)
  if (config) {
    if (config.size > 4096) throw new Error('选定提交中的主文件配置无效。')
    let data: { schemaVersion?: unknown; mainFile?: unknown }
    try { data = JSON.parse(utf8(await gitBytes(writingRoot, ['cat-file', 'blob', config.objectId], config.size))) as typeof data }
    catch { throw new Error('选定提交中的主文件配置无效。') }
    if (!data || data.schemaVersion !== 1 || typeof data.mainFile !== 'string') throw new Error('选定提交中的主文件配置无效。')
    mainFile = portablePath(data.mainFile.replace(/\\/g, '/'))
  }
  if (extname(mainFile).toLowerCase() !== '.tex' || !files.some(file => file.path === mainFile)) throw new Error('选定提交缺少配置的 TeX 主文件；无法完整归档该文稿版本。')
  return { root: writingRoot, gitCommit, mainFile, files, totalBytes }
}

export async function inspectSubmissionSnapshotCommit(root: string, requested: string): Promise<SubmissionSnapshotCommitInspection> {
  const source = await inspectCommit(await projectRoot(root), requested)
  return { gitCommit: source.gitCommit, mainFile: source.mainFile, totalBytes: source.totalBytes, files: source.files.map(({ path, size }) => ({ path, size })) }
}

async function readRecord(path: string, maxBytes = maxManifestBytes): Promise<unknown> {
  const file = await openOrdinaryFile(path)
  try {
    const before = await file.stat()
    if (before.size > maxBytes) throw new Error('投稿材料记录过大。')
    const chunk = Buffer.alloc(Math.min(maxBytes + 1, 1024 * 1024))
    const parts: Buffer[] = []
    let size = 0
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, size)
      if (!bytesRead) break
      size += bytesRead
      if (size > maxBytes) throw new Error('投稿材料记录过大。')
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)))
    }
    const after = await file.stat()
    if (size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('投稿材料记录正在改变，请稍后重试。')
    return JSON.parse(utf8(Buffer.concat(parts))) as unknown
  } finally { await file.close() }
}

async function requireTarget(root: string, submissionId: string, eventId?: string): Promise<void> {
  if (!attemptIdPattern.test(submissionId) || eventId !== undefined && !eventIdPattern.test(eventId)) throw new Error('投稿或修订事件 ID 无效。')
  const base = join(root, '.repaper', 'submissions')
  const attempt = await readRecord(join(base, 'attempts', `${submissionId}.json`), maxSubmissionRecordBytes) as { id?: unknown }
  if (!attempt || attempt.id !== submissionId) throw new Error('请先保存这次投稿记录。')
  if (eventId) {
    const event = await readRecord(join(base, 'events', `${eventId}.json`), maxSubmissionRecordBytes) as { id?: unknown; submissionId?: unknown; kind?: unknown }
    if (!event || event.id !== eventId || event.submissionId !== submissionId || event.kind !== 'revision') throw new Error('材料快照只能关联这次投稿的修订事件。')
  }
}

// Use the same lock directory as event writes and submission deletion, including CLI writers.
async function withSubmissionLock<T>(root: string, submissionId: string, action: () => Promise<T>): Promise<T> {
  const directory = await managedDirectories(root, ['.repaper', 'submissions', 'locks'])
  const path = join(directory, `${submissionId}.lock`)
  const deadline = Date.now() + 15_000
  while (true) {
    try { await mkdir(path); break }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      const info = await infoOrNull(path)
      if (info?.isSymbolicLink() || info && !info.isDirectory()) throw new Error('投稿保存锁无效。')
      if (info && Date.now() - info.mtimeMs > 300_000) await rmdir(path).catch(() => undefined)
      if (Date.now() > deadline) throw new Error('这次投稿正在保存，请稍后重试。')
      await new Promise(done => setTimeout(done, 80))
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date()
    void utimes(path, now, now).catch(() => undefined)
  }, 15_000)
  heartbeat.unref()
  try { return await action() }
  finally { clearInterval(heartbeat); await rmdir(path).catch(() => undefined) }
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null)
    if (!bytesWritten) throw new Error('无法写入投稿材料文件。')
    offset += bytesWritten
  }
}

async function openOrdinaryFile(path: string): Promise<FileHandle> {
  await ordinaryPath(path, 'file')
  const before = await lstat(path)
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const info = await file.stat()
  if (!info.isFile() || info.size > maxFileBytes || info.dev !== before.dev || info.ino !== before.ino) {
    await file.close()
    throw new Error('材料文件已改变，或单个材料超过 50 MB。')
  }
  return file
}

async function copySelectedFile(snapshotRoot: string, input: string, path: string, role: 'pdf' | 'supplement'): Promise<SubmissionSnapshotFile> {
  const source = await openOrdinaryFile(input)
  let target: FileHandle | undefined
  try {
    const before = await source.stat()
    if (role === 'pdf') {
      const header = Buffer.alloc(8)
      const { bytesRead } = await source.read(header, 0, header.length, 0)
      if (extname(input).toLowerCase() !== '.pdf' || bytesRead < 8 || !/^%PDF-[12]\.\d$/.test(header.toString('ascii'))) throw new Error('请选择实际提交的有效 PDF 文件。')
    }
    const destination = join(snapshotRoot, ...portablePath(path).split('/'))
    await mkdir(dirname(destination), { recursive: true })
    target = await open(destination, 'wx')
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(1024 * 1024)
    let size = 0
    while (true) {
      const { bytesRead } = await source.read(chunk, 0, chunk.length, size)
      if (!bytesRead) break
      size += bytesRead
      if (size > maxFileBytes) throw new Error('单个投稿材料不能超过 50 MB。')
      const bytes = chunk.subarray(0, bytesRead)
      hash.update(bytes)
      await writeAll(target, bytes)
    }
    const after = await source.stat()
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('材料在归档期间发生改变，请重新选择并保存。')
    await target.sync()
    return { path, role, size, sha256: hash.digest('hex') }
  } finally { await target?.close(); await source.close() }
}

export async function createSubmissionSnapshot(root: string, draft: SubmissionSnapshotDraft, selection: SubmissionSnapshotFileSelection): Promise<SubmissionSnapshot> {
  const canonicalRoot = await projectRoot(root)
  if (!draft || typeof draft.label !== 'string' || !draft.label.trim() || draft.label.trim().length > 160 ||
    typeof draft.submissionId !== 'string' || !attemptIdPattern.test(draft.submissionId) ||
    draft.eventId !== undefined && (typeof draft.eventId !== 'string' || !eventIdPattern.test(draft.eventId))) throw new Error('请填写有效的投稿材料名称及关联投稿。')
  if (!selection || typeof selection.pdfFilePath !== 'string' || !isAbsolute(selection.pdfFilePath) ||
    selection.supplementFilePaths !== undefined && (!Array.isArray(selection.supplementFilePaths) ||
      selection.supplementFilePaths.length > maxSupplementFiles || selection.supplementFilePaths.some(path => typeof path !== 'string' || !isAbsolute(path)))) throw new Error('请通过文件选择框选择 PDF 和最多 20 个补充材料。')
  return withSubmissionLock(canonicalRoot, draft.submissionId, async () => {
    await requireTarget(canonicalRoot, draft.submissionId, draft.eventId)
    const source = await inspectCommit(canonicalRoot, draft.gitCommit)
    const inputPaths = [selection.pdfFilePath, ...selection.supplementFilePaths ?? []]
    const canonicalInputs: string[] = []
    for (const input of inputPaths) canonicalInputs.push(await ordinaryPath(input, 'file'))
    if (new Set(canonicalInputs.map(path => path.normalize('NFC').toLowerCase())).size !== inputPaths.length) throw new Error('不能重复选择同一个材料文件。')
    const base = await managedDirectories(canonicalRoot, ['.repaper', 'submissions', 'snapshots'])
    const id = `ss_${randomUUID()}`
    const destination = join(base, id)
    // Exclusive reservation makes an existing snapshot impossible to replace.
    await mkdir(destination)
    let published = false
    try {
      const files: SubmissionSnapshotFile[] = []
      files.push(await copySelectedFile(destination, canonicalInputs[0], `pdf/${portablePath(basename(selection.pdfFilePath))}`, 'pdf'))
      let supplementBytes = 0
      for (let index = 1; index < canonicalInputs.length; index += 1) {
        const name = portablePath(basename(inputPaths[index]))
        const file = await copySelectedFile(destination, canonicalInputs[index], `supplements/${String(index).padStart(2, '0')}-${name}`, 'supplement')
        supplementBytes += file.size
        if (supplementBytes > maxSupplementBytes) throw new Error('补充材料总大小不能超过 200 MB。')
        files.push(file)
      }
      for (const file of source.files) {
        const bytes = await gitBytes(source.root, ['cat-file', 'blob', file.objectId], file.size)
        if (bytes.length !== file.size) throw new Error('选定 Git 提交中的源码大小不一致。')
        const path = `source/${file.path}`
        const target = join(destination, ...path.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes, { flag: 'wx', flush: true })
        files.push({ path, role: 'source', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
      const snapshot: SubmissionSnapshot = {
        schemaVersion: 1, id, label: draft.label.trim(), createdAt: new Date().toISOString(),
        submissionId: draft.submissionId, ...(draft.eventId ? { eventId: draft.eventId } : {}),
        gitCommit: source.gitCommit, mainFile: source.mainFile,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0), files
      }
      if (snapshot.totalBytes > maxSnapshotBytes) throw new Error('单份投稿材料快照不能超过 500 MB。')
      validateSnapshot(snapshot, id)
      const manifest = JSON.stringify(snapshot, null, 2) + '\n'
      if (Buffer.byteLength(manifest, 'utf8') > maxManifestBytes) throw new Error('投稿材料快照清单过大，请减少文件数量或缩短源码路径。')
      // The exclusively reserved directory belongs only to this creation. Publish
      // its completed manifest last, atomically, on filesystems without hard links too.
      const temporary = join(destination, '.manifest.tmp')
      await writeFile(temporary, manifest, { encoding: 'utf8', flag: 'wx', flush: true })
      const manifestPath = join(destination, 'manifest.json')
      if (await infoOrNull(manifestPath)) throw new Error('快照清单已存在，不能覆盖归档。')
      await rename(temporary, manifestPath)
      published = true
      return snapshot
    } finally {
      if (!published) {
        await ordinaryPath(destination, 'directory')
        if (!within(base, destination) || destination === base) throw new Error('快照清理路径无效。')
        await rm(destination, { recursive: true, force: true })
      }
    }
  })
}

function validateSnapshot(value: unknown, expectedId: string): SubmissionSnapshot {
  const snapshot = value as SubmissionSnapshot
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.id !== expectedId || !snapshotIdPattern.test(snapshot.id) ||
    typeof snapshot.label !== 'string' || !snapshot.label.trim() || snapshot.label.length > 160 ||
    typeof snapshot.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.createdAt) || !Number.isFinite(Date.parse(snapshot.createdAt)) ||
    typeof snapshot.submissionId !== 'string' || !attemptIdPattern.test(snapshot.submissionId) ||
    snapshot.eventId !== undefined && (typeof snapshot.eventId !== 'string' || !eventIdPattern.test(snapshot.eventId)) ||
    typeof snapshot.gitCommit !== 'string' || !commitPattern.test(snapshot.gitCommit) ||
    !Number.isSafeInteger(snapshot.totalBytes) || snapshot.totalBytes < 0 || snapshot.totalBytes > maxSnapshotBytes ||
    !Array.isArray(snapshot.files) || snapshot.files.length > maxSourceFiles + maxSupplementFiles + 1) throw new Error('投稿材料快照清单无效。')
  portablePath(snapshot.mainFile)
  let totalBytes = 0
  for (const file of snapshot.files) {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxFileBytes || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('投稿材料快照文件清单无效。')
    portablePath(file.path)
    const prefix = file.role === 'pdf' ? 'pdf/' : file.role === 'source' ? 'source/' : file.role === 'supplement' ? 'supplements/' : ''
    if (!prefix || !file.path.startsWith(prefix)) throw new Error('投稿材料快照文件角色或路径无效。')
    totalBytes += file.size
  }
  uniquePaths(snapshot.files.map(file => file.path))
  const pdfFiles = snapshot.files.filter(file => file.role === 'pdf')
  const sourceFiles = snapshot.files.filter(file => file.role === 'source')
  const supplements = snapshot.files.filter(file => file.role === 'supplement')
  if (totalBytes !== snapshot.totalBytes || pdfFiles.length !== 1 || extname(pdfFiles[0].path).toLowerCase() !== '.pdf' ||
    sourceFiles.length > maxSourceFiles || sourceFiles.reduce((sum, file) => sum + file.size, 0) > maxSourceBytes ||
    supplements.length > maxSupplementFiles || supplements.reduce((sum, file) => sum + file.size, 0) > maxSupplementBytes ||
    extname(snapshot.mainFile).toLowerCase() !== '.tex' || !sourceFiles.some(file => file.path === `source/${snapshot.mainFile}`)) throw new Error('投稿材料快照清单不完整或超过大小限制。')
  return snapshot
}

export async function loadSubmissionSnapshot(root: string, id: string): Promise<SubmissionSnapshot> {
  const canonicalRoot = await projectRoot(root)
  const directory = snapshotDirectory(canonicalRoot, id)
  return validateSnapshot(await readRecord(join(directory, 'manifest.json')), id)
}

export async function listSubmissionSnapshots(root: string, submissionId?: string): Promise<SubmissionSnapshot[]> {
  const canonicalRoot = await projectRoot(root)
  if (submissionId !== undefined && (typeof submissionId !== 'string' || !attemptIdPattern.test(submissionId))) throw new Error('投稿 ID 无效。')
  const base = snapshotStore(canonicalRoot)
  if (!await infoOrNull(base)) return []
  await ordinaryPath(base, 'directory')
  const names = (await readdir(base)).filter(name => snapshotIdPattern.test(name))
  if (names.length > 10_000) throw new Error('投稿材料快照数量过多。')
  const snapshots: SubmissionSnapshot[] = []
  for (const id of names) {
    const manifest = join(base, id, 'manifest.json')
    // An interrupted reservation has no manifest and is never listed as a snapshot.
    if (!await infoOrNull(manifest)) continue
    const snapshot = validateSnapshot(await readRecord(manifest), id)
    if (!submissionId || snapshot.submissionId === submissionId) snapshots.push(snapshot)
  }
  return snapshots.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
}

async function archivedFile(root: string, snapshot: SubmissionSnapshot, file: SubmissionSnapshotFile): Promise<string> {
  const directory = snapshotDirectory(root, snapshot.id)
  const path = resolve(directory, ...portablePath(file.path).split('/'))
  if (!within(directory, path) || path === directory) throw new Error('归档文件路径无效。')
  await ordinaryPath(path, 'file')
  if ((await lstat(path)).size !== file.size) throw new Error('归档文件大小与快照清单不一致。')
  return path
}

async function readVerifiedFile(path: string, file: SubmissionSnapshotFile, onChunk?: (bytes: Buffer) => Promise<void>): Promise<void> {
  const handle = await openOrdinaryFile(path)
  try {
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(1024 * 1024)
    let size = 0
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size)
      if (!bytesRead) break
      size += bytesRead
      if (size > file.size) throw new Error('归档文件大小与快照清单不一致。')
      const bytes = chunk.subarray(0, bytesRead)
      hash.update(bytes)
      if (onChunk) await onChunk(bytes)
    }
    if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error('归档文件校验失败，材料已发生改变。')
  } finally { await handle.close() }
}

export async function submissionSnapshotFilePath(root: string, id: string, path: string): Promise<string> {
  const canonicalRoot = await projectRoot(root)
  const snapshot = await loadSubmissionSnapshot(canonicalRoot, id)
  const file = snapshot.files.find(item => item.path === path)
  if (!file) throw new Error('该文件不属于选定的投稿材料快照。')
  const target = await archivedFile(canonicalRoot, snapshot, file)
  await readVerifiedFile(target, file)
  return target
}

export async function exportSubmissionSnapshotZip(root: string, id: string, targetPath: string): Promise<string> {
  const canonicalRoot = await projectRoot(root)
  const snapshot = await loadSubmissionSnapshot(canonicalRoot, id)
  if (typeof targetPath !== 'string' || !isAbsolute(targetPath) || extname(targetPath).toLowerCase() !== '.zip' || targetPath.includes('\0')) throw new Error('请选择一个 ZIP 导出文件路径。')
  const target = resolve(targetPath)
  const parent = await ordinaryPath(dirname(target), 'directory')
  const canonicalTarget = join(parent, basename(target))
  if (within(join(canonicalRoot, '.paper'), canonicalTarget) || within(join(canonicalRoot, '.repaper'), canonicalTarget)) {
    throw new Error('材料 ZIP 不能导出到 .paper 或 .repaper 管理目录中，请选择其他位置。')
  }
  const previous = await infoOrNull(canonicalTarget)
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('ZIP 导出目标必须是普通文件。')
  const temporary = join(parent, `.repaper-snapshot-${randomUUID()}.tmp`)
  const output = await open(temporary, 'wx')
  let writes = Promise.resolve()
  let zipError: Error | undefined
  let finished = false
  const zip = new Zip((error, bytes, final) => {
    if (error) { zipError = error; return }
    writes = writes.then(() => writeAll(output, bytes))
    if (final) finished = true
  })
  try {
    const manifest = new ZipPassThrough('manifest.json')
    manifest.mtime = new Date(snapshot.createdAt)
    zip.add(manifest)
    manifest.push(Buffer.from(JSON.stringify(snapshot, null, 2) + '\n'), true)
    await writes
    for (const file of snapshot.files) {
      const path = await archivedFile(canonicalRoot, snapshot, file)
      const entry = new ZipPassThrough(file.path)
      entry.mtime = new Date(snapshot.createdAt)
      zip.add(entry)
      await readVerifiedFile(path, file, async bytes => {
        entry.push(bytes)
        await writes
        if (zipError) throw zipError
      })
      entry.push(new Uint8Array(0), true)
      await writes
      if (zipError) throw zipError
    }
    zip.end()
    await writes
    if (zipError) throw zipError
    if (!finished) throw new Error('材料 ZIP 未完整生成。')
    await output.sync()
    await output.close()
    // Recheck links immediately before replacing a user-selected ordinary ZIP.
    await ordinaryPath(parent, 'directory')
    const current = await infoOrNull(canonicalTarget)
    if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('ZIP 导出目标已改变，请重新选择位置。')
    await rename(temporary, canonicalTarget)
    return canonicalTarget
  } catch (error) {
    zip.terminate()
    await writes.catch(() => undefined)
    await output.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
