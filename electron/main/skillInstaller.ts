import { app } from 'electron'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import type { SkillInstallStatus, SkillProvider } from '../../shared/experiments'

const SKILL_NAME = 'repaper-experiments'

const applicationRoot = resolve(__dirname, '../..')
function sourceSkillPath(): string {
  return join(app.isPackaged ? process.resourcesPath : applicationRoot, 'skills', SKILL_NAME, 'SKILL.md')
}
function sourceCliPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'cli', 'repaper.cjs')
    : join(applicationRoot, 'out', 'cli', 'repaper.cjs')
}

function destination(provider: SkillProvider): string {
  const base = provider === 'codex'
    ? process.env.CODEX_HOME || join(homedir(), '.codex')
    : process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'skills', SKILL_NAME)
}

function versionOf(source: string): string | null {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(source)?.[1]
  return frontmatter ? /^\s*version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?\s*$/m.exec(frontmatter)?.[1] ?? null : null
}

function hash(data: Buffer): string { return createHash('sha256').update(data).digest('hex') }

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

async function sourceFiles(): Promise<{ skill: Buffer; cli: Buffer; version: string }> {
  const [skill, cli] = await Promise.all([readFile(sourceSkillPath()), readFile(sourceCliPath())])
  const version = versionOf(skill.toString('utf8'))
  if (!version) throw new Error('内置 SKILL 缺少有效版本号。')
  return { skill, cli, version }
}

export async function skillStatuses(): Promise<SkillInstallStatus[]> {
  const source = await sourceFiles()
  return Promise.all((['codex', 'claude'] as const).map(async (provider) => {
    const path = destination(provider)
    const installedSkill = await readFile(join(path, 'SKILL.md')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!installedSkill) return { provider, path, state: 'missing', installedVersion: null, availableVersion: source.version }
    const installedVersion = versionOf(installedSkill.toString('utf8'))
    const installedCli = await readFile(join(path, 'scripts', 'repaper.cjs')).catch(() => null)
    const current = installedVersion === source.version && hash(installedSkill) === hash(source.skill) && Boolean(installedCli && hash(installedCli) === hash(source.cli))
    return {
      provider, path, state: !installedVersion ? 'unknown' : compareVersions(installedVersion, source.version) > 0 ? 'newer' : current ? 'current' : 'outdated',
      installedVersion, availableVersion: source.version
    }
  }))
}

export async function installSkill(provider: SkillProvider): Promise<SkillInstallStatus[]> {
  if (provider !== 'codex' && provider !== 'claude') throw new Error('未知的 Agent。')
  const source = await sourceFiles()
  const path = destination(provider)
  await mkdir(join(path, 'scripts'), { recursive: true })
  const current = await readFile(join(path, 'SKILL.md')).catch(() => null)
  const installedVersion = current && versionOf(current.toString('utf8'))
  if (installedVersion && compareVersions(installedVersion, source.version) > 0) {
    throw new Error(`已安装 v${installedVersion}，高于内置 v${source.version}。`)
  }
  if (current && hash(current) !== hash(source.skill)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(join(path, 'SKILL.md'), join(path, `SKILL.md.backup-${timestamp}`))
  }
  const currentCli = await readFile(join(path, 'scripts', 'repaper.cjs')).catch(() => null)
  if (currentCli && hash(currentCli) !== hash(source.cli)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(join(path, 'scripts', 'repaper.cjs'), join(path, 'scripts', `repaper.cjs.backup-${timestamp}`))
  }
  await Promise.all([
    writeFile(join(path, 'SKILL.md'), source.skill),
    writeFile(join(path, 'scripts', 'repaper.cjs'), source.cli)
  ])
  return skillStatuses()
}

export function cliBinDirectory(): string { return join(app.getPath('userData'), 'bin') }

export async function ensureCliLauncher(): Promise<void> {
  const cli = sourceCliPath()
  if (!(await stat(cli).catch(() => null))) throw new Error('实验 CLI 尚未构建，请先运行 npm run build:cli。')
  const directory = cliBinDirectory()
  await mkdir(directory, { recursive: true })
  if (process.platform === 'win32') {
    const command = `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" "${cli}" %*\r\n`
    await writeFile(join(directory, 'repaper.cmd'), command, 'utf8')
  } else {
    const command = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cli}" "$@"\n`
    const path = join(directory, 'repaper')
    await writeFile(path, command, 'utf8')
    await chmod(path, 0o755)
  }
}

export function withCliPath(path: string | undefined): string {
  return [cliBinDirectory(), path ?? ''].filter(Boolean).join(delimiter)
}
