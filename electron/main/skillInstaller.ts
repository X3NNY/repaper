import { app } from 'electron'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import type { SkillInstallStatus, SkillProvider } from '../../shared/experiments'

const SKILL_NAMES = ['repaper-experiments', 'repaper-init'] as const

const applicationRoot = resolve(__dirname, '../..')
function sourceSkillPath(name: string): string {
  return join(app.isPackaged ? process.resourcesPath : applicationRoot, 'skills', name, 'SKILL.md')
}
function sourceCliPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'cli', 'repaper.cjs')
    : join(applicationRoot, 'out', 'cli', 'repaper.cjs')
}

function destination(provider: SkillProvider, name: string): string {
  const base = provider === 'codex'
    ? process.env.CODEX_HOME || join(homedir(), '.codex')
    : process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'skills', name)
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

async function sourceFiles(): Promise<{ skills: { name: string; skill: Buffer }[]; cli: Buffer; version: string }> {
  const [skills, cli] = await Promise.all([
    Promise.all(SKILL_NAMES.map(async (name) => ({ name, skill: await readFile(sourceSkillPath(name)) }))),
    readFile(sourceCliPath())
  ])
  const versions = skills.map(({ skill }) => versionOf(skill.toString('utf8')))
  if (!versions[0] || versions.some((version) => version !== versions[0])) throw new Error('内置 SKILL 缺少有效版本号或版本不一致。')
  return { skills, cli, version: versions[0] }
}

export async function skillStatuses(): Promise<SkillInstallStatus[]> {
  const source = await sourceFiles()
  return Promise.all((['codex', 'claude'] as const).map(async (provider) => {
    const path = destination(provider, SKILL_NAMES[0])
    const installed = await Promise.all(source.skills.map(async ({ name }) => readFile(join(destination(provider, name), 'SKILL.md')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })))
    const installedVersion = installed[0] ? versionOf(installed[0].toString('utf8')) : null
    const installedCli = await readFile(join(path, 'scripts', 'repaper.cjs')).catch(() => null)
    const current = source.skills.every(({ skill }, index) => {
      const local = installed[index]
      return local !== null && versionOf(local.toString('utf8')) === source.version && hash(local) === hash(skill)
    })
      && Boolean(installedCli && hash(installedCli) === hash(source.cli))
    const newer = installed.some((skill) => {
      const version = skill && versionOf(skill.toString('utf8'))
      return version !== null && compareVersions(version, source.version) > 0
    })
    return {
      provider, path, state: !installed[0] ? 'missing' : newer ? 'newer' : !installedVersion ? 'unknown' : current ? 'current' : 'outdated',
      installedVersion, availableVersion: source.version
    }
  }))
}

export async function installSkill(provider: SkillProvider): Promise<SkillInstallStatus[]> {
  if (provider !== 'codex' && provider !== 'claude') throw new Error('未知的 Agent。')
  const source = await sourceFiles()
  const path = destination(provider, SKILL_NAMES[0])
  const installed = await Promise.all(source.skills.map(async ({ name }) => {
    const skillPath = destination(provider, name)
    return { path: skillPath, current: await readFile(join(skillPath, 'SKILL.md')).catch(() => null) }
  }))
  for (const { current } of installed) {
    const version = current && versionOf(current.toString('utf8'))
    if (version && compareVersions(version, source.version) > 0) throw new Error(`已安装 v${version}，高于内置 v${source.version}。`)
  }
  await mkdir(join(path, 'scripts'), { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const [index, { path: skillPath, current }] of installed.entries()) {
    await mkdir(skillPath, { recursive: true })
    if (current && hash(current) !== hash(source.skills[index].skill)) {
      await copyFile(join(skillPath, 'SKILL.md'), join(skillPath, `SKILL.md.backup-${timestamp}`))
    }
  }
  const currentCli = await readFile(join(path, 'scripts', 'repaper.cjs')).catch(() => null)
  if (currentCli && hash(currentCli) !== hash(source.cli)) {
    await copyFile(join(path, 'scripts', 'repaper.cjs'), join(path, 'scripts', `repaper.cjs.backup-${timestamp}`))
  }
  await Promise.all([
    ...source.skills.map(({ name, skill }) => writeFile(join(destination(provider, name), 'SKILL.md'), skill)),
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
