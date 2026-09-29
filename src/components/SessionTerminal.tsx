import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { SessionProvider, SessionTerminalEvent } from '../../shared/sessions'
import { createLightAnsiTransformer } from '../lib/terminalColors'
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
    const transformColors = createLightAnsiTransformer()
    const styles = getComputedStyle(host)
    const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.28,
      scrollback: 5000,
      theme: {
        background: color('--terminal-background', '#fbfcf9'),
        foreground: color('--terminal-foreground', '#294336'),
        cursor: color('--terminal-cursor', '#347451'),
        cursorAccent: color('--terminal-background', '#fbfcf9'),
        selectionBackground: color('--terminal-selection', '#cce2cf'),
        selectionForeground: color('--terminal-foreground', '#294336'),
        black: '#263c30',
        red: '#9d433a',
        green: '#246944',
        yellow: '#78551e',
        blue: '#335d89',
        magenta: '#764b80',
        cyan: '#2d696e',
        white: '#405847',
        brightBlack: '#536856',
        brightRed: '#a0443b',
        brightGreen: '#286d45',
        brightYellow: '#795922',
        brightBlue: '#3a648e',
        brightMagenta: '#794f83',
        brightCyan: '#2d656b',
        brightWhite: '#263c30'
      }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)

    function apply(event: SessionTerminalEvent) {
      if (event.sequence <= sequence) return
      sequence = event.sequence
      if (event.type === 'data') terminal.write(transformColors(event.data))
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
      terminal.write(transformColors(snapshot.output))
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
