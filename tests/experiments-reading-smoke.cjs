const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'out'), { recursive: true })
const fixture = fs.mkdtempSync(path.join(root, 'out', 'experiments-reading-'))
const userData = path.join(fixture, 'user')
const papers = [path.join(fixture, 'paper-a'), path.join(fixture, 'paper-b')]
process.env.CODEX_HOME = path.join(fixture, 'codex')
process.env.CLAUDE_CONFIG_DIR = path.join(fixture, 'claude')
delete process.env.ELECTRON_RENDERER_URL
app.setPath('userData', userData)
fs.mkdirSync(userData, { recursive: true })

function run(folder, args) {
  const result = spawnSync('node', [path.join(root, 'out', 'cli', 'repaper.cjs'), '--paper', folder, ...args], {
    cwd: folder, encoding: 'utf8', timeout: 20000
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout
}

for (const folder of papers) {
  fs.mkdirSync(folder, { recursive: true })
  run(folder, ['init'])
  run(folder, ['group', 'ensure', 'core', '--title', '核心能力比较'])
  run(folder, ['experiment', 'ensure', 'core/a', '--title', 'C01 同预算方法核心比较', '--design', '比较相同预算下的方法性能。'])
  run(folder, ['experiment', 'ensure', 'core/b', '--title', 'E15 参数家族中的排序载体与很长的实验标题'])
}
run(papers[0], ['run', 'core/a', '--', 'node', '-e', 'console.log("complete")'])
fs.writeFileSync(path.join(papers[0], 'historical.json'), '{"accuracy":0.9}')
fs.utimesSync(path.join(papers[0], 'historical.json'), new Date('2024-01-01'), new Date('2024-01-01'))
run(papers[0], ['run', 'import', 'core/a', '--source', 'historical.json', '--summary', '历史准确率记录'])
fs.writeFileSync(path.join(userData, 'workspace.json'), JSON.stringify({
  schemaVersion: 1,
  papers: papers.map((folderPath, index) => ({
    id: `reading-paper-${index}`, title: `实验阅读状态 ${index + 1}`, folderPath,
    shortName: '', summary: '', status: 'research', tags: [], routes: [],
    versions: [], submissions: [], revisions: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }))
}))

app.on('browser-window-created', (_event, win) => {
  win.hide()
  win.webContents.setBackgroundThrottling(false)
})
require('../out/main/index.js')

async function waitFor(check, timeout = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('等待实验界面超时。')
}

app.whenReady().then(async () => {
  let win
  try {
    await waitFor(() => { win = BrowserWindow.getAllWindows()[0]; return Boolean(win) })
    const evaluate = (code) => win.webContents.executeJavaScript(code)
    const row = (id) => `document.querySelector('[data-experiment-id="${id}"]')`
    const readStatus = (id) => evaluate(`${row(id)}?.dataset.readStatus`)
    const openPaper = async (index) => {
      await waitFor(() => evaluate('Boolean(document.querySelector(".recent-link"))'))
      // The hidden probe controls focus without interrupting the user's active window.
      await evaluate(`window.readingProbeFocused = true; Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => window.readingProbeFocused }); true`)
      await evaluate(`Array.from(document.querySelectorAll('.recent-link')).find((button) => button.innerText.includes('实验阅读状态 ${index + 1}')).click()`)
      await waitFor(() => evaluate('Boolean(document.querySelector(".paper-side-link"))'))
      await evaluate(`Array.from(document.querySelectorAll('.paper-side-link')).find((button) => button.innerText.includes('实验')).click()`)
      await waitFor(() => evaluate('document.querySelectorAll(".experiments-child").length === 2'))
    }
    await openPaper(0)
    assert.equal(await readStatus('core/a'), 'unread')
    assert.equal(await readStatus('core/b'), 'unread')
    assert.equal(await evaluate('document.querySelector(".experiments-unread-count").textContent'), '2 未读')
    assert.equal(await evaluate(`${row('core/a')}.querySelector('.experiment-child-meta > span').textContent`), '2 次运行')
    assert.equal(await evaluate(`${row('core/b')}.querySelector('.experiment-child-meta > span').textContent`), '0 次运行')
    await evaluate('document.querySelector(".experiments-group-button").click()')
    assert.equal(await readStatus('core/a'), 'unread', '浏览实验组不应标记实验已读。')
    await evaluate(`${row('core/a')}.click()`)
    await waitFor(async () => await readStatus('core/a') === 'read')
    assert.equal(await readStatus('core/b'), 'unread')
    const records = await evaluate(`Object.keys(localStorage).filter((key) => key.startsWith('repaper.experiment-reading.v1:')).map((key) => JSON.parse(localStorage.getItem(key)))`)
    assert.ok(records[0]['core/a'].revision)
    assert.ok(records[0]['core/a'].readAt)

    await evaluate('document.querySelector(".experiments-group-button").click()')
    const previousTime = await evaluate(`${row('core/a')}.querySelector('time').dateTime`)
    const runId = JSON.parse(run(papers[0], ['list', 'runs', '--json']))[0].id
    run(papers[0], ['run', 'annotate', runId, '--summary', '补充准确率分析'])
    await waitFor(async () => await readStatus('core/a') === 'unread')
    const updatedTime = await evaluate(`${row('core/a')}.querySelector('time').dateTime`)
    assert.ok(Date.parse(updatedTime) > Date.parse(previousTime), '补充运行分析后应显示新的更新时间。')
    await evaluate(`${row('core/a')}.click()`)
    await waitFor(async () => await readStatus('core/a') === 'read')

    await evaluate(`window.readingProbeFocused = false; window.dispatchEvent(new Event('blur'))`)
    run(papers[0], ['experiment', 'ensure', 'core/a', '--design', '加入第二种方法进行比较。'])
    await waitFor(async () => await readStatus('core/a') === 'unread')
    assert.equal(await evaluate('document.querySelector(".experiment-overview-card p").textContent'), '加入第二种方法进行比较。')
    await evaluate(`window.readingProbeFocused = true; window.dispatchEvent(new Event('focus'))`)
    await waitFor(async () => await readStatus('core/a') === 'read')

    await evaluate('document.querySelector(".experiments-group-button").click()')
    run(papers[0], ['run', 'core/a', '--', 'node', '-e', 'console.log("second run")'])
    await waitFor(() => evaluate(`${row('core/a')}.querySelector('.experiment-child-meta > span').textContent === '3 次运行'`))
    assert.equal(await readStatus('core/a'), 'unread')
    await evaluate(`${row('core/a')}.click()`)
    await waitFor(async () => await readStatus('core/a') === 'read')

    // Reload the renderer, retaining its persistent storage, as on app restart.
    win.webContents.reload()
    await openPaper(0)
    assert.equal(await readStatus('core/a'), 'read', '重新加载后必须保留已读状态。')
    assert.equal(await readStatus('core/b'), 'unread')
    await evaluate('document.querySelector(".sidebar-return").click()')
    await openPaper(1)
    assert.equal(await readStatus('core/a'), 'unread', '相同实验 ID 的其他论文必须保持独立阅读状态。')
    await evaluate('document.querySelector(".sidebar-return").click()')
    await openPaper(0)
    assert.equal(await readStatus('core/a'), 'read')

    win.setSize(1100, 720)
    await new Promise((done) => setTimeout(done, 200))
    const layout = await evaluate(`Array.from(document.querySelectorAll('.experiments-child')).map((button) => ({
      width: button.clientWidth, scrollWidth: button.scrollWidth,
      titleHeight: button.querySelector('.experiment-child-title').getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(button.querySelector('.experiment-child-title')).lineHeight),
      metadataWidth: button.querySelector('.experiment-child-meta').clientWidth,
      metadataScrollWidth: button.querySelector('.experiment-child-meta').scrollWidth
    }))`)
    for (const item of layout) {
      assert.ok(item.scrollWidth <= item.width, '实验目录不应横向溢出。')
      assert.equal(item.titleHeight, item.lineHeight, '实验标题必须保持单行。')
      assert.ok(item.metadataScrollWidth <= item.metadataWidth, '时间和运行次数不应重叠。')
    }
    fs.writeFileSync(path.join(fixture, 'experiments.png'), (await win.webContents.capturePage()).toPNG())
    const result = { passed: true, checks: ['metadata', 'read-on-open', 'updates-unread', 'background-updates', 'run-count', 'reload-persistence', 'project-isolation', 'narrow-layout'], layout }
    fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ ...result, fixture }))
    app.exit(0)
  } catch (error) {
    console.error(error)
    fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify({ passed: false, error: String(error), stack: error.stack }, null, 2))
    app.exit(1)
  }
})
