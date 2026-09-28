import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionPage, SessionSummary } from '../../shared/sessions'
import { sameDirectory } from './codexBridge'

const PAGE_SIZE = 30
const METADATA_BYTES = 256 * 1024
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function projectKey(folderPath: string): string {
  return resolve(folderPath).replace(/[^a-zA-Z0-9]/g, '-')
}

function userPrompt(record: JsonObject): string {
  if (record.type !== 'user' || record.isSidechain === true) return ''
  const content = object(record.message).content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((part) => object(part).type === 'text').map((part) => object(part).text).filter((part): part is string => typeof part === 'string').join(' ')
      : ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 180)
}

async function readMetadata(path: string, sessionId: string): Promise<{ cwd: string; prompt: string } | null> {
  const file = await open(path, 'r').catch(() => null)
  if (!file) return null
  const buffer = Buffer.alloc(METADATA_BYTES)
  let bytesRead = 0
  try { ({ bytesRead } = await file.read(buffer, 0, buffer.length, 0)) }
  finally { await file.close() }
  let content = buffer.toString('utf8', 0, bytesRead)
  if (bytesRead === buffer.length && !content.endsWith('\n')) content = content.slice(0, content.lastIndexOf('\n') + 1)
  let cwd = ''
  let prompt = ''
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue
    let record: JsonObject
    try { record = object(JSON.parse(line)) }
    catch { continue }
    if (typeof record.sessionId === 'string' && record.sessionId !== sessionId) return null
    if (!cwd && typeof record.cwd === 'string') cwd = record.cwd
    if (!prompt) prompt = userPrompt(record)
    if (cwd && prompt) break
  }
  return cwd ? { cwd, prompt } : null
}

export class ClaudeSessions {
  constructor(private readonly projectsRoot = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')) {}

  private async projectDirectory(folderPath: string): Promise<string | null> {
    const expected = projectKey(folderPath)
    const directories = await readdir(this.projectsRoot, { withFileTypes: true }).catch(() => [])
    const match = directories.find((entry) => entry.isDirectory() &&
      (process.platform === 'win32' ? entry.name.toLowerCase() === expected.toLowerCase() : entry.name === expected))
    return match ? join(this.projectsRoot, match.name) : null
  }

  async list(folderPath: string, cursor?: string): Promise<SessionPage> {
    const directory = await this.projectDirectory(folderPath)
    if (!directory) return { sessions: [], nextCursor: null }
    const entries = await readdir(directory, { withFileTypes: true })
    const files = entries.filter((entry) => entry.isFile() && SESSION_ID.test(entry.name.slice(0, -6)) && entry.name.endsWith('.jsonl'))
    const dated: { name: string; updatedAt: number }[] = []
    for (let index = 0; index < files.length; index += 32) {
      const batch = files.slice(index, index + 32)
      const results = await Promise.all(batch.map(async (entry) => {
        const info = await stat(join(directory, entry.name)).catch(() => null)
        return info?.isFile() ? { name: entry.name, updatedAt: info.mtimeMs / 1000 } : null
      }))
      dated.push(...results.filter((result): result is { name: string; updatedAt: number } => result !== null))
    }
    dated.sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name))
    const offset = cursor && /^\d+$/.test(cursor) ? Math.min(Number(cursor), dated.length) : 0
    const sessions: SessionSummary[] = []
    let position = offset
    while (position < dated.length && sessions.length < PAGE_SIZE) {
      const file = dated[position++]
      const id = file.name.slice(0, -6)
      const metadata = await readMetadata(join(directory, file.name), id)
      if (!metadata || !sameDirectory(metadata.cwd, folderPath)) continue
      sessions.push({
        id,
        title: metadata.prompt.slice(0, 88) || `会话 ${id.slice(0, 8)}`,
        preview: metadata.prompt,
        cwd: metadata.cwd,
        updatedAt: file.updatedAt,
        provider: 'claude'
      })
    }
    return { sessions, nextCursor: position < dated.length ? String(position) : null }
  }

  async assertSessionFolder(folderPath: string, sessionId: string): Promise<void> {
    if (!SESSION_ID.test(sessionId)) throw new Error('Claude Code 会话 ID 无效。')
    const directory = await this.projectDirectory(folderPath)
    const metadata = directory && await readMetadata(join(directory, `${sessionId}.jsonl`), sessionId)
    if (!metadata || !sameDirectory(metadata.cwd, folderPath)) {
      throw new Error('该 Claude Code 会话不属于所选文件夹。')
    }
  }
}
