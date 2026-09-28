const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const fixture = path.resolve(__dirname, '../out/window-layout-smoke')
const userData = path.join(fixture, 'user')

function samplePdf() {
  const stream = 'BT /F1 24 Tf 72 720 Td (Preview stability) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'ascii')
}

fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
fs.writeFileSync(path.join(userData, 'workspace.json'), JSON.stringify({
  schemaVersion: 1,
  papers: [{
    id: 'layout-smoke-paper', title: '界面布局测试', folderPath: fixture,
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
  throw new Error('等待界面加载超时。')
}

async function geometry(win) {
  return win.webContents.executeJavaScript(`(() => {
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect()
    const bottom = document.querySelector('.sidebar-bottom').getBoundingClientRect()
    const nav = document.querySelector('.paper-side-nav').getBoundingClientRect()
    const topbar = document.querySelector('.topbar').getBoundingClientRect()
    const context = document.querySelector('.topbar-context').getBoundingClientRect()
    const right = document.querySelector('.topbar-right').getBoundingClientRect()
    return {
      viewport: { width: innerWidth, height: innerHeight },
      overlay: document.documentElement.classList.contains('windows-titlebar-overlay'),
      nativeOverlay: navigator.windowControlsOverlay?.visible ?? null,
      topbar: { top: topbar.top, height: topbar.height, contextRight: context.right, actionsLeft: right.left, rightContent: right.right,
        drag: getComputedStyle(document.querySelector('.topbar')).getPropertyValue('-webkit-app-region'),
        controls: getComputedStyle(document.querySelector('.topbar-right')).getPropertyValue('-webkit-app-region') },
      sidebar: { bottom: sidebar.bottom, bottomSection: bottom.bottom, navBottom: nav.bottom }
    }
  })()`)
}

function verify(layout) {
  const { viewport, overlay, topbar, sidebar } = layout
  if (Math.abs(sidebar.bottom - viewport.height) > 1) throw new Error(`侧栏高度不对：${JSON.stringify(layout)}`)
  if (Math.abs(sidebar.bottomSection - (viewport.height - 16)) > 2) throw new Error(`侧栏底部信息未贴底：${JSON.stringify(layout)}`)
  if (sidebar.navBottom > sidebar.bottomSection) throw new Error(`导航与底部信息重叠：${JSON.stringify(layout)}`)
  if (topbar.top !== 0) throw new Error(`顶栏未与窗口顶部融合：${JSON.stringify(layout)}`)
  if (topbar.contextRight > topbar.actionsLeft - 7) throw new Error(`顶栏操作与页面标题重叠：${JSON.stringify(layout)}`)
  if (process.platform === 'win32') {
    if (!overlay || !layout.nativeOverlay || topbar.height !== 48 || topbar.drag !== 'drag' || topbar.controls !== 'no-drag') throw new Error(`Windows 标题栏设置不对：${JSON.stringify(layout)}`)
    if (topbar.rightContent > viewport.width - 155) throw new Error(`顶栏内容占用了窗口按钮区域：${JSON.stringify(layout)}`)
  }
}

app.whenReady().then(async () => {
  let result
  let stage = 'window'
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0])
    stage = 'load'
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".recent-link"))'))
    stage = 'paper'
    await win.webContents.executeJavaScript('document.querySelector(".recent-link").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".paper-side-nav"))'))
    stage = 'navigation'
    const navigation = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.paper-side-link span')).map((item) => item.textContent.trim())`)
    if (JSON.stringify(navigation) !== JSON.stringify(['概况', '会话', '写作', '实验'])) throw new Error(`论文导航不正确：${JSON.stringify(navigation)}`)
    await waitFor(() => win.webContents.executeJavaScript(`document.querySelector('.topbar-right')?.innerText.includes('新建 Codex') && document.querySelector('.topbar-right')?.innerText.includes('新建 Claude')`))
    const sessionsActions = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.topbar-right button')).map((item) => item.textContent.trim() || item.getAttribute('aria-label'))`)
    await win.webContents.executeJavaScript('document.querySelector(".paper-side-link").click()')
    await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".overview-grid"))'))
    const overview = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.overview-grid .section-heading h2')).map((item) => item.textContent.trim())`)
    if (JSON.stringify(overview) !== JSON.stringify(['会话', '写作', '实验'])) throw new Error(`论文概况不正确：${JSON.stringify(overview)}`)
    if (!await win.webContents.executeJavaScript(`document.querySelector('.topbar-context-copy strong')?.textContent === '概况' && document.querySelector('.topbar-right')?.innerText.includes('编辑论文')`)) throw new Error('概况顶栏缺少实际操作。')
    stage = 'normal'
    const normal = await geometry(win)
    verify(normal)
    stage = 'writing'
    await win.webContents.executeJavaScript(`(async () => { const state = await window.paperApi.writingGet(${JSON.stringify(fixture)}); if (!state.initialized) await window.paperApi.writingInitialize(${JSON.stringify(fixture)}, 'blank'); return true })()`)
    const pdfPath = path.join(fixture, '.paper', '.build', 'manuscript.pdf')
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true })
    fs.writeFileSync(pdfPath, samplePdf())
    await win.webContents.executeJavaScript(`localStorage.removeItem(${JSON.stringify(`repaper-writing-split:${fixture}`)})`)
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.paper-side-link')).find((item) => item.textContent.includes('写作')).click()`)
    await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.writing-workspace') && document.querySelector('.topbar-right .writing-history-toggle'))`))
    await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.writing-pdf canvas')?.style.width || document.querySelector('.writing-pdf-state.error'))`))
    const previewError = await win.webContents.executeJavaScript(`document.querySelector('.writing-pdf-state.error')?.textContent || ''`)
    if (previewError) throw new Error(`测试 PDF 无法渲染：${previewError}`)
    const writingActions = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.topbar-right button')).map((item) => item.textContent.trim())`)
    if (!writingActions.some((item) => item.includes('编译')) || !writingActions.some((item) => item.includes('记录版本'))) throw new Error(`写作顶栏缺少实际操作：${JSON.stringify(writingActions)}`)
    await win.webContents.executeJavaScript(`document.querySelector('.topbar-right .writing-history-toggle').click()`)
    const beforeDrag = await win.webContents.executeJavaScript(`(() => { const source = document.querySelector('.writing-source').getBoundingClientRect(); const divider = document.querySelector('.writing-divider').getBoundingClientRect(); return { sourceWidth: source.width, x: Math.round(divider.left + divider.width / 2), y: Math.round(divider.top + divider.height / 2) } })()`)
    stage = 'divider-drag'
    win.webContents.sendInputEvent({ type: 'mouseMove', x: beforeDrag.x, y: beforeDrag.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: beforeDrag.x, y: beforeDrag.y, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 5; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: beforeDrag.x + step * 16, y: beforeDrag.y, button: 'left' })
      await new Promise((done) => setTimeout(done, 25))
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: beforeDrag.x + 80, y: beforeDrag.y, button: 'left', clickCount: 1 })
    await new Promise((done) => setTimeout(done, 450))
    const afterDrag = await win.webContents.executeJavaScript(`({ sourceWidth: document.querySelector('.writing-source').getBoundingClientRect().width, pdfWidth: document.querySelector('.writing-pdf').getBoundingClientRect().width, dragging: document.querySelector('.writing-document').classList.contains('is-resizing'), savedKeys: Object.keys(localStorage).filter((key) => key.startsWith('repaper-writing-split:')), savedRatio: localStorage.getItem(${JSON.stringify(`repaper-writing-split:${fixture}`)}) })`)
    if (afterDrag.sourceWidth < beforeDrag.sourceWidth + 40 || !afterDrag.savedRatio) throw new Error(`拖动分界线未调整占比：${JSON.stringify({ beforeDrag, afterDrag })}`)
    stage = 'pdf-stability'
    await waitFor(() => win.webContents.executeJavaScript(`(() => { const pane = document.querySelector('.writing-pdf').getBoundingClientRect().width; const canvas = document.querySelector('.writing-pdf canvas'); return Boolean(canvas?.style.width && parseFloat(canvas.style.width) <= pane - 50) })()`))
    const pdfStability = await win.webContents.executeJavaScript(`new Promise(async (resolve) => {
      const canvas = document.querySelector('.writing-pdf canvas')
      let changes = 0
      const observer = new MutationObserver(() => { changes += 1 })
      observer.observe(canvas, { attributes: true, attributeFilter: ['width', 'height', 'style'] })
      const sizes = []
      for (let index = 0; index < 8; index++) {
        sizes.push({ pane: Math.round(document.querySelector('.writing-pdf').getBoundingClientRect().width), canvas: canvas.style.width })
        await new Promise((done) => setTimeout(done, 100))
      }
      observer.disconnect()
      resolve({ changes, sizes })
    })`)
    if (!pdfStability.sizes[0].canvas || pdfStability.changes > 1 || new Set(pdfStability.sizes.map((item) => item.pane)).size > 1 || new Set(pdfStability.sizes.map((item) => item.canvas)).size > 1) throw new Error(`PDF 预览尺寸不稳定：${JSON.stringify(pdfStability)}`)
    await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.topbar-right .writing-history-popover'))`))
    await win.webContents.executeJavaScript(`document.querySelector('.topbar-right .writing-history-toggle').click()`)
    stage = 'narrow'
    win.setSize(1100, 720)
    await new Promise((done) => setTimeout(done, 300))
    const narrow = await geometry(win)
    verify(narrow)
    const narrowWriting = await win.webContents.executeJavaScript(`({ editor: document.querySelector('.writing-source').getBoundingClientRect().width, divider: document.querySelector('.writing-divider').getBoundingClientRect().width, pdf: document.querySelector('.writing-pdf').getBoundingClientRect().width, content: document.querySelector('.writing-document').getBoundingClientRect().width })`)
    if (narrowWriting.editor < 259 || narrowWriting.pdf < 299 || Math.abs(narrowWriting.editor + narrowWriting.divider + narrowWriting.pdf - narrowWriting.content) > 2) throw new Error(`窄窗口写作布局不正确：${JSON.stringify(narrowWriting)}`)
    try { fs.writeFileSync(path.join(fixture, 'writing-narrow.png'), (await win.webContents.capturePage()).toPNG()) } catch { /* Screenshot capture is unavailable on some GPUs. */ }
    stage = 'maximized'
    win.maximize()
    await waitFor(() => win.isMaximized())
    const maximized = await geometry(win)
    verify(maximized)
    stage = 'experiments'
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.paper-side-link')).find((item) => item.textContent.includes('实验')).click()`)
    await waitFor(() => win.webContents.executeJavaScript(`document.querySelector('.topbar-right')?.innerText.includes('刷新实验')`))
    result = { navigation, sessionsActions, overview, writingActions, beforeDrag, afterDrag, pdfStability, normal, narrow, narrowWriting, maximized, experimentsAction: true }
  } catch (error) {
    result = { stage, error: String(error), stack: error?.stack }
  } finally {
    fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2))
    app.exit(result.error ? 1 : 0)
  }
})
