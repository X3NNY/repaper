const { app, BrowserWindow } = require('electron')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const fixture = path.join(root, 'out', 'experiments-ui-smoke')
const userData = path.join(fixture, 'user')
const paperFolder = path.join(fixture, 'paper')
process.env.CODEX_HOME = path.join(fixture, 'codex')
process.env.CLAUDE_CONFIG_DIR = path.join(fixture, 'claude')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(paperFolder, { recursive: true })
app.setPath('userData', userData)

const cli = path.join(root, 'out', 'cli', 'repaper.cjs')
function run(args) {
  const result = spawnSync('node', [cli, '--paper', paperFolder, ...args], { cwd: paperFolder, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`)
}
run(['init'])
run(['group', 'ensure', 'benchmark', '--title', '跨 Benchmark 测试', '--goal', '比较模型在不同数据集上的表现'])
run(['experiment', 'ensure', 'benchmark/data-a', '--title', 'A 数据集', '--question', 'A 上是否优于基线？'])
run(['run', 'benchmark/data-a', '--metrics', 'metrics.json', '--artifact', 'metrics.json', '--', 'node', '-e', "require('node:fs').writeFileSync('metrics.json', JSON.stringify({accuracy:0.825})); console.log('accuracy=0.825')"])
fs.writeFileSync(path.join(userData, 'workspace.json'), JSON.stringify({
  schemaVersion: 1,
  papers: [{
    id: 'experiment-smoke-paper', title: '实验界面测试', folderPath: paperFolder,
    shortName: '', summary: '', status: 'research', tags: [], routes: [],
    versions: [], submissions: [], revisions: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }]
}))
require('../out/main/index.js')

async function waitFor(check, timeout = 20000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeout) {
    try { const result = await check(); if (result) return result }
    catch (error) { lastError = error }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`等待超时${lastError ? `：${lastError}` : ''}`)
}

app.whenReady().then(async () => {
  let result
  let stage = 'window'
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0])
    stage = 'load'
    await waitFor(() => win.webContents.getURL().startsWith('file:') && !win.webContents.isLoadingMainFrame())
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".recent-link"))'))
    stage = 'paper'
    await win.webContents.executeJavaScript('document.querySelector(".recent-link").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".paper-side-link"))'))
    stage = 'experiments'
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".paper-side-link")).find((item) => item.innerText.includes("实验")).click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelectorAll(".experiments-child").length >= 1'))
    const ui = await win.webContents.executeJavaScript(`({
      title: document.querySelector('.topbar-context-copy strong')?.innerText,
      group: document.querySelector('.experiments-group-button')?.innerText,
      experiment: document.querySelector('.experiments-child')?.innerText,
      treeWidth: document.querySelector('.experiments-tree')?.getBoundingClientRect().width,
      hasSkillConfig: Array.from(document.querySelectorAll('.experiments-shell button')).some((item) => item.innerText.includes('SKILL'))
    })`)
    if (ui.hasSkillConfig) throw new Error('实验页仍显示 SKILL 配置。')
    stage = 'skill-status'
    await win.webContents.executeJavaScript('document.querySelector(".sidebar-return").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".main-nav"))'))
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".main-nav .nav-link")).find((item) => item.innerText.includes("设置")).click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelectorAll(".global-settings-row").length === 2 && document.querySelector(".global-settings-row")?.innerText.includes("v1.0.0")'))
    stage = 'skill-install'
    for (let index = 0; index < 2; index++) {
      const alreadyCurrent = await win.webContents.executeJavaScript(`document.querySelectorAll('.global-settings-row')[${index}]?.innerText.includes('已是最新')`)
      if (!alreadyCurrent) {
        await win.webContents.executeJavaScript(`document.querySelectorAll('.global-settings-row')[${index}].querySelector('button').click()`)
        await waitFor(() => win.webContents.executeJavaScript(`document.querySelectorAll('.global-settings-row')[${index}]?.innerText.includes('已是最新')`))
      }
    }
    const statuses = await win.webContents.executeJavaScript('window.paperApi.skillStatuses()')
    if (statuses.some((item) => item.state !== 'current')) throw new Error('安装状态不正确。')
    stage = 'skill-update'
    const codexSkill = path.join(statuses[0].path, 'SKILL.md')
    fs.writeFileSync(codexSkill, fs.readFileSync(codexSkill, 'utf8').replace('version: "1.0.0"', 'version: "0.9.0"'))
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".topbar-right button")).find((item) => item.innerText.includes("重新检测")).click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelector(".global-settings-row .global-settings-version strong")?.innerText === "v0.9.0"'))
    await win.webContents.executeJavaScript('document.querySelector(".global-settings-row .button-primary").click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelector(".global-settings-row")?.innerText.includes("已是最新")'))
    if (!fs.readdirSync(statuses[0].path).some((name) => name.startsWith('SKILL.md.backup-'))) throw new Error('更新前未备份旧 SKILL。')
    stage = 'launcher'
    const launcher = path.join(userData, 'bin', 'repaper.cmd')
    const shellResult = spawnSync('cmd.exe', ['/c', launcher, 'status'], { cwd: paperFolder, encoding: 'utf8', timeout: 10000 })
    if (shellResult.status !== 0 || !shellResult.stdout.includes('实验组 1')) throw new Error(`CLI 启动器失败：${shellResult.stdout}\n${shellResult.stderr}`)
    const settingsImage = await win.webContents.capturePage()
    fs.writeFileSync(path.join(fixture, 'settings.png'), settingsImage.toPNG())
    stage = 'watch'
    await win.webContents.executeJavaScript('document.querySelector(".recent-link").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".paper-side-link"))'))
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".paper-side-link")).find((item) => item.innerText.includes("实验")).click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelectorAll(".experiments-child").length >= 1'))
    const previousCount = await win.webContents.executeJavaScript('document.querySelectorAll(".experiments-child").length')
    run(['experiment', 'ensure', `benchmark/data-b-${Date.now().toString(36)}`, '--title', 'B 数据集'])
    await waitFor(() => win.webContents.executeJavaScript(`document.querySelectorAll('.experiments-child').length === ${previousCount + 1}`))
    await win.webContents.executeJavaScript('document.querySelector(".experiments-child").click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelector(".experiment-content h2")?.innerText === "A 数据集"'))
    await waitFor(() => win.webContents.executeJavaScript('document.querySelectorAll(".experiment-run-row").length >= 1'))
    await win.webContents.executeJavaScript('document.querySelector(".experiment-log-button").click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelector(".experiment-log")?.innerText.includes("accuracy=0.825")'))
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(fixture, 'experiments.png'), image.toPNG())
    win.setSize(1100, 720)
    await new Promise((done) => setTimeout(done, 350))
    const narrow = await win.webContents.executeJavaScript(`({
      mainWidth: document.querySelector('.experiments-main')?.clientWidth,
      scrollWidth: document.querySelector('.experiments-main')?.scrollWidth
    })`)
    if (narrow.scrollWidth > narrow.mainWidth + 1) throw new Error(`实验页存在横向溢出：${JSON.stringify(narrow)}`)
    const narrowImage = await win.webContents.capturePage()
    fs.writeFileSync(path.join(fixture, 'experiments-narrow.png'), narrowImage.toPNG())
    result = { ui, statuses, launcher: shellResult.stdout.trim(), watcherUpdated: true, narrow }
  } catch (error) {
    result = { stage, error: String(error), stack: error?.stack }
  } finally {
    fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2))
    app.quit()
  }
})
