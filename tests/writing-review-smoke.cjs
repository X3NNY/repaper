const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const output = path.resolve(__dirname, '../out/writing-review-smoke')
const fixture = path.join(output, `paper-${process.pid}-${Date.now()}`)
const paper = path.join(fixture, '.paper')
const userData = path.join(fixture, 'user')
fs.mkdirSync(paper, { recursive: true })
fs.mkdirSync(userData, { recursive: true })

function git(args) {
  return execFileSync('git', args, { cwd: paper, encoding: 'utf8', windowsHide: true }).trim()
}

git(['init', '--quiet'])
const originalManuscript = String.raw`\documentclass{article}
\begin{document}
Original result.
Retained line.
\end{document}
`
fs.writeFileSync(path.join(paper, 'manuscript.tex'), originalManuscript)
fs.writeFileSync(path.join(paper, 'old.tex'), 'Old section.\n')
git(['add', '--all'])
git(['-c', 'user.name=Review Test', '-c', 'user.email=review@local', 'commit', '--quiet', '-m', 'Initial manuscript'])
const hash = git(['rev-parse', 'HEAD'])
fs.writeFileSync(path.join(paper, 'manuscript.tex'), String.raw`\documentclass{article}
\begin{document}
Updated result.
Retained line.
Added discussion.
\end{document}
`)
fs.unlinkSync(path.join(paper, 'old.tex'))
fs.writeFileSync(path.join(paper, 'new.tex'), 'New section.\n')

app.setPath('userData', userData)
fs.writeFileSync(path.join(userData, 'workspace.json'), JSON.stringify({
  schemaVersion: 1,
  papers: [{
    id: 'review-smoke-paper', title: '版本对比测试', folderPath: fixture,
    shortName: '', summary: '', status: 'research', tags: [], routes: [],
    versions: [], submissions: [], revisions: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }]
}))
require('../out/main/index.js')

async function waitFor(check, timeout = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await Promise.resolve().then(check).catch(() => null)
    if (value) return value
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('等待版本对比界面超时。')
}

app.whenReady().then(async () => {
  let result
  let stage = 'window'
  let win
  try {
    win = await waitFor(() => BrowserWindow.getAllWindows()[0])
    stage = 'load'
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".recent-link"))'))
    await win.webContents.executeJavaScript('document.querySelector(".recent-link").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".paper-side-nav"))'))
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.paper-side-link')).find((item) => item.textContent.includes('写作')).click()`)
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".writing-workspace") && document.querySelector(".writing-compile-run"))'))

    stage = 'api'
    const summary = await win.webContents.executeJavaScript(`window.paperApi.writingReview(${JSON.stringify(fixture)}, ${JSON.stringify(hash)})`)
    const statuses = Object.fromEntries(summary.files.map((file) => [file.path, file.status]))
    if (JSON.stringify(statuses) !== JSON.stringify({ 'manuscript.tex': 'modified', 'new.tex': 'added', 'old.tex': 'deleted' })) throw new Error(`文件状态错误：${JSON.stringify(summary)}`)
    const contents = await Promise.all(['manuscript.tex', 'new.tex', 'old.tex'].map((name) => win.webContents.executeJavaScript(`window.paperApi.writingReviewFile(${JSON.stringify(fixture)}, ${JSON.stringify(hash)}, ${JSON.stringify(name)})`)))
    if (!contents[0].original.includes('Original result.') || !contents[0].current.includes('Updated result.') || contents[1].original !== '' || !contents[1].current.includes('New section.') || !contents[2].original.includes('Old section.') || contents[2].current !== '') throw new Error(`文件内容错误：${JSON.stringify(contents)}`)

    stage = 'compiler-menu'
    const defaultEngine = await win.webContents.executeJavaScript('document.querySelector(".writing-compile-run").textContent')
    if (!defaultEngine.includes('pdfLaTeX')) throw new Error(`默认编译方式错误：${defaultEngine}`)
    await win.webContents.executeJavaScript('document.querySelector(".writing-compile-toggle").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".writing-compile-popover"))'))
    await win.webContents.executeJavaScript('document.querySelectorAll(".writing-compile-popover button")[1].click()')
    if (!await win.webContents.executeJavaScript('document.querySelector(".writing-compile-run").textContent.includes("XeLaTeX")')) throw new Error('编译方式切换失败。')

    stage = 'review-ui'
    await win.webContents.executeJavaScript('document.querySelector(".writing-history-toggle").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".writing-history-popover button"))'))
    await win.webContents.executeJavaScript('document.querySelector(".writing-history-popover button").click()')
    await waitFor(() => win.webContents.executeJavaScript('document.querySelectorAll(".writing-review-file").length === 3'))
    const rows = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.writing-review-file')).map((item) => ({ path: item.title, badge: item.querySelector('small')?.textContent }))`)
    if (rows.map((row) => row.badge).join(',') !== '修改,新增,删除') throw new Error(`对比文件标签错误：${JSON.stringify(rows)}`)
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".writing-review-file")).find((item) => item.title === "manuscript.tex").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".writing-source .cm-deletedChunk") && document.querySelector(".writing-source .cm-changedLine"))'))
    const modified = await win.webContents.executeJavaScript(`({ red: document.querySelectorAll('.writing-source .cm-deletedChunk').length, green: document.querySelectorAll('.writing-source .cm-changedLine').length, editable: document.querySelector('.writing-source .cm-content')?.getAttribute('contenteditable') })`)
    if (!modified.red || !modified.green || modified.editable === 'true') throw new Error(`文本对比错误：${JSON.stringify(modified)}`)
    try { fs.writeFileSync(path.join(output, 'review.png'), (await win.webContents.capturePage()).toPNG()) } catch { /* Screenshot capture may be unavailable. */ }

    stage = 'added-deleted'
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".writing-review-file")).find((item) => item.title === "new.tex").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".writing-source .cm-changedLine"))'))
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".writing-review-file")).find((item) => item.title === "old.tex").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".writing-source .cm-deletedChunk"))'))

    stage = 'refresh-empty'
    fs.writeFileSync(path.join(paper, 'manuscript.tex'), originalManuscript)
    fs.writeFileSync(path.join(paper, 'old.tex'), 'Old section.\n')
    fs.unlinkSync(path.join(paper, 'new.tex'))
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".writing-files-head button")).find((item) => item.getAttribute("aria-label") === "刷新版本对比").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".writing-review-empty")?.textContent.includes("没有差异"))'))
    if (await win.webContents.executeJavaScript('document.querySelector(".writing-source-state")?.textContent.includes("正在生成")')) throw new Error('无变动时对比视图仍在加载。')
    await win.webContents.executeJavaScript('document.querySelector(".writing-review-bar button").click()')
    await waitFor(() => win.webContents.executeJavaScript('!document.querySelector(".writing-review-bar") && Boolean(document.querySelector(".writing-pdf"))'))

    result = { hash, summary, rows, modified, defaultEngine, emptyAfterRefresh: true, reviewExited: true }
  } catch (error) {
    result = { stage, error: String(error), stack: error?.stack }
    if (win && !win.isDestroyed()) result.ui = await win.webContents.executeJavaScript(`({ body: document.body.innerText.slice(-1500), editor: document.querySelector('.writing-source')?.outerHTML.slice(0, 1200) })`).catch(() => null)
  } finally {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    app.exit(result.error ? 1 : 0)
  }
})
