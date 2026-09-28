import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { SessionProvider, SessionTerminalEvent } from '../../shared/sessions'
import '@xterm/xterm/css/xterm.css'

interface Props {
  terminalId: string
  provider: SessionProvider
  onStatus: (terminalId: string, provider: SessionProvider, running: boolean, exitCode: number | null) => void
}

export default function SessionTerminal({ terminalId, provider, onStatus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const api = window.paperApi
    const host = hostRef.current
    if (!api || !host) return

    let disposed = false
    let ready = false
    let sequence = 0
    const pending: SessionTerminalEvent[] = []
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.28,
      scrollback: 5000,
      theme: {
        background: '#17251d',
        foreground: '#d9e9d7',
        cursor: '#a5d9a5',
        selectionBackground: '#547d60',
        black: '#142019',
        red: '#e99786',
        green: '#9bd29b',
        yellow: '#e6c984',
        blue: '#9fbeec',
        magenta: '#d6a9d6',
        cyan: '#94d0cb',
        white: '#d9e9d7',
        brightBlack: '#6b8170',
        brightWhite: '#f7fff5'
      }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)

    function apply(event: SessionTerminalEvent) {
      if (event.sequence <= sequence) return
      sequence = event.sequence
      if (event.type === 'data') terminal.write(event.data)
      else {
        terminal.options.disableStdin = true
        onStatus(terminalId, provider, false, event.exitCode)
      }
    }

    const unsubscribe = api.onSessionTerminalEvent((event) => {
      if (event.terminalId !== terminalId) return
      if (!ready) pending.push(event)
      else apply(event)
    })
    const input = terminal.onData((data) => {
      void api.sessionTerminalWrite(terminalId, data).catch((reason) =>
        setError(reason instanceof Error ? reason.message : '无法向终端发送输入。'))
    })
    const binaryInput = terminal.onBinary((data) => {
      void api.sessionTerminalWrite(terminalId, data).catch((reason) =>
        setError(reason instanceof Error ? reason.message : '无法向终端发送输入。'))
    })

    function fitTerminal() {
      if (disposed || host!.clientWidth < 40 || host!.clientHeight < 40) return
      fit.fit()
      void api!.sessionTerminalResize(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
    }
    const observer = new ResizeObserver(fitTerminal)
    observer.observe(host)
    const frame = requestAnimationFrame(fitTerminal)

    void api.sessionTerminalSnapshot(terminalId).then((snapshot) => {
      if (disposed) return
      terminal.write(snapshot.output)
      sequence = snapshot.sequence
      terminal.options.disableStdin = !snapshot.running
      onStatus(terminalId, provider, snapshot.running, snapshot.exitCode)
      ready = true
      pending.forEach(apply)
      pending.length = 0
      fitTerminal()
      terminal.focus()
    }).catch((reason) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : '无法连接会话终端。')
    })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      unsubscribe()
      input.dispose()
      binaryInput.dispose()
      terminal.dispose()
    }
  }, [terminalId, provider, onStatus])

  return <div className="codex-terminal-wrap">
    <div className="codex-terminal-host" ref={hostRef} />
    {error ? <div className="codex-terminal-error">{error}</div> : null}
  </div>
}
