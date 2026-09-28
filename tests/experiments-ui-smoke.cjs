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
  return result.stdout
}
run(['init'])
run(['group', 'ensure', 'benchmark', '--title', '跨 Benchmark 测试', '--goal', '比较模型在不同数据集上的表现'])
run(['experiment', 'ensure', 'benchmark/data-a', '--title', 'A 数据集', '--subtitle', 'A 上是否优于基线？', '--design', '在相同预算和数据划分下比较方法与基线。', '--setting', '数据集=A', '--setting', '训练轮数=140'])
run(['run', 'benchmark/data-a', '--label', '当前方法 · A 数据集', '--metrics', 'metrics.json', '--artifact', 'metrics.json', '--', 'node', '-e', "require('node:fs').writeFileSync('metrics.json', JSON.stringify({accuracy:0.825})); console.log('accuracy=0.825')"])
const evidenceId = JSON.parse(run(['list', 'runs', '--json']))[0].id
fs.mkdirSync(path.join(paperFolder, 'figures'), { recursive: true })
fs.writeFileSync(path.join(paperFolder, 'figures', 'accuracy.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl7lJ8AAAAASUVORK5CYII=', 'base64'))
fs.writeFileSync(path.join(paperFolder, 'overview.json'), JSON.stringify([
  { type: 'text', text: 'A 数据集本次运行的 accuracy 为 0.825。', sourceRunIds: [evidenceId] },
  { type: 'table', title: '主结果', columns: ['方法', 'accuracy'], rows: [['当前方法', '0.825']], sourceRunIds: [evidenceId] },
  { type: 'figure', title: '准确率图', path: 'figures/accuracy.png', caption: '实验图片示例', sourceRunIds: [evidenceId] }
]))
run(['experiment', 'update', 'benchmark/data-a', '--results-file', 'overview.json', '--conclusion', '这次运行提供了 A 数据集上的初步证据，尚需其他数据集验证。'])
run(['experiment', 'ensure', 'benchmark/legacy', '--title', '旧实验', '--question', '旧研究问题', '--factor', '旧参数组合'])
run(['experiment', 'update', 'benchmark/legacy', '--result', '旧运行进度', '--conclusion', '旧执行约束'])
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
    await waitFor(() => win.webContents.executeJavaScript('document.querySelectorAll(".global-settings-row").length === 2 && document.querySelector(".global-settings-row")?.innerText.includes("v1.3.0")'))
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
    for (const item of statuses) {
      const initSkill = path.join(path.dirname(item.path), 'repaper-init', 'SKILL.md')
      if (!fs.readFileSync(initSkill, 'utf8').includes('name: repaper-init')) throw new Error('初始化 SKILL 未安装。')
    }
    stage = 'skill-update'
    const codexSkill = path.join(statuses[0].path, 'SKILL.md')
    fs.writeFileSync(codexSkill, fs.readFileSync(codexSkill, 'utf8').replace('version: "1.3.0"', 'version: "0.9.0"'))
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
    await waitFor(() => win.webContents.executeJavaScript('document.querySelector(".experiment-result-image")?.complete'))
    const overview = await win.webContents.executeJavaScript(`({
      sections: Array.from(document.querySelectorAll('.experiment-overview-heading h3')).map((item) => item.textContent),
      design: document.querySelector('.experiment-overview-card p')?.textContent,
      settings: Array.from(document.querySelectorAll('.experiment-setting-list dt')).map((item) => item.textContent),
      table: document.querySelector('.experiment-result-table-scroll')?.textContent,
      imageLoaded: document.querySelector('.experiment-result-image')?.naturalWidth > 0,
      evidenceLinks: document.querySelectorAll('.experiment-result-sources button').length,
      legacyHidden: !document.querySelector('.experiment-overview-grid')?.textContent.includes('旧运行进度') && !document.querySelector('.experiment-legacy-details')?.open,
      historyCollapsed: document.querySelector('.experiment-run-toggle')?.getAttribute('aria-expanded') === 'false'
    })`)
    if (JSON.stringify(overview.sections) !== JSON.stringify(['设计原因', '关键设置', '结果', '结论']) || !overview.design?.includes('相同预算') || overview.settings.length !== 2 || !overview.table?.includes('0.825') || !overview.imageLoaded || overview.evidenceLinks !== 3 || !overview.legacyHidden || !overview.historyCollapsed) throw new Error(`实验概览不正确：${JSON.stringify(overview)}`)
    await win.webContents.executeJavaScript('document.querySelector(".experiment-result-image-button").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".experiment-image-backdrop"))'))
    await win.webContents.executeJavaScript('document.querySelector(".experiment-image-backdrop > button").click()')
    await win.webContents.executeJavaScript('document.querySelector(".experiment-history-button").click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelectorAll(".experiment-revision-list details").length >= 2'))
    await win.webContents.executeJavaScript('document.querySelector(".experiment-history-button").click()')
    await win.webContents.executeJavaScript('document.querySelector(".experiment-result-sources button").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".experiment-evidence-drawer"))'))
    await win.webContents.executeJavaScript('document.querySelector(".experiment-evidence-drawer-head button").click()')
    await win.webContents.executeJavaScript('document.querySelector(".experiments-tree-toggle").click()')
    const compactTreeWidth = await win.webContents.executeJavaScript('document.querySelector(".experiments-tree").getBoundingClientRect().width')
    if (compactTreeWidth !== 52) throw new Error(`实验目录折叠宽度不对：${compactTreeWidth}`)
    await win.webContents.executeJavaScript('document.querySelector(".experiments-tree-toggle").click()')
    await win.webContents.executeJavaScript('document.querySelector(".experiments-group-toggle").click()')
    if (await win.webContents.executeJavaScript('Boolean(document.querySelector(".experiments-child-list"))')) throw new Error('实验组收起后仍显示实验。')
    await win.webContents.executeJavaScript('document.querySelector(".experiments-group-toggle").click()')
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".experiments-child")).find((item) => item.innerText.includes("旧实验")).click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelector(".experiment-content h2")?.innerText === "旧实验"'))
    const legacy = await win.webContents.executeJavaScript(`({
      hasOverview: Boolean(document.querySelector('.experiment-overview-grid')),
      rawRecordCollapsed: Boolean(document.querySelector('.experiment-legacy-details') && !document.querySelector('.experiment-legacy-details').open),
      hasOrganizeAction: Array.from(document.querySelectorAll('.experiment-title-actions button')).some((button) => button.textContent.includes('整理指令'))
    })`)
    if (legacy.hasOverview || !legacy.rawRecordCollapsed || !legacy.hasOrganizeAction) throw new Error(`旧记录未隔离：${JSON.stringify(legacy)}`)
    await win.webContents.executeJavaScript('document.querySelector(".experiment-legacy-details summary").click()')
    if (!await win.webContents.executeJavaScript('document.querySelector(".experiment-legacy-details")?.innerText.includes("旧运行进度")')) throw new Error('原始记录未保留旧内容。')
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".experiments-child")).find((item) => item.innerText.includes("A 数据集")).click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelector(".experiment-content h2")?.innerText === "A 数据集"'))
    await win.webContents.executeJavaScript('document.querySelector(".experiment-run-toggle").click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelectorAll(".experiment-run-row").length >= 1'))
    await win.webContents.executeJavaScript('document.querySelector(".experiment-log-button").click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelector(".experiment-log")?.innerText.includes("accuracy=0.825")'))
    stage = 'historical-evidence'
    const historicalFile = `historical-${Date.now().toString(36)}.json`
    fs.writeFileSync(path.join(paperFolder, historicalFile), JSON.stringify({ accuracy: 0.91 }))
    run(['run', 'import', 'benchmark/data-a', '--source', historicalFile, '--summary', '历史结果文件记录的准确率'])
    await waitFor(() => win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".experiment-run-row")).some((row) => row.innerText.includes("历史导入"))'))
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".experiment-run-row")).find((row) => row.innerText.includes("历史导入")).click()')
    const imported = await win.webContents.executeJavaScript(`({
      heading: document.querySelector('.experiment-detail-heading')?.innerText,
      hasCommand: Boolean(document.querySelector('.experiment-command')),
      hasRunLog: Boolean(document.querySelector('.experiment-log-button')),
      hasMetric: document.querySelector('.experiment-metrics')?.innerText.includes('0.91')
    })`)
    if (!imported.heading?.includes('历史证据') || imported.hasCommand || imported.hasRunLog || !imported.hasMetric) throw new Error(`历史证据界面不正确：${JSON.stringify(imported)}`)
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
    result = { ui, statuses, launcher: shellResult.stdout.trim(), watcherUpdated: true, overview, legacy, imported, narrow }
  } catch (error) {
    result = { stage, error: String(error), stack: error?.stack }
  } finally {
    fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2))
    app.quit()
  }
})
