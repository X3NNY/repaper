import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import './ResizablePanels.css'

interface Pane {
  id: string
  minSize: number
  maxSize?: number
  defaultSize?: number
  defaultRatio?: number
  fixedSize?: number
}

interface Options {
  storageKey: string
  panes: Pane[]
  gutter?: number
  stackBelow?: number
}

interface HandleProps {
  label: string
  value: number
  min: number
  max: number
  direction: 1 | -1
  onChange: (value: number) => void
  onCommit: () => void
  onReset: () => void
  className?: string
}

type Sizes = Record<string, number>
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const storagePrefix = 'repaper:panel-widths:'

function readSizes(key: string): Sizes {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storagePrefix + key) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0 && entry[1] < 20000))
  } catch { return {} }
}

export function useResizablePanels({ storageKey, panes, gutter = 6, stackBelow = 0 }: Options) {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  const [saved, setSaved] = useState(() => ({ key: storageKey, sizes: readSizes(storageKey) }))
  const savedRef = useRef(saved)
  const signature = JSON.stringify(panes)
  const definitions = useMemo(() => panes, [signature])
  const ref = useCallback((element: HTMLElement | null) => setContainer(element), [])

  useLayoutEffect(() => {
    if (savedRef.current.key === storageKey) return
    const next = { key: storageKey, sizes: readSizes(storageKey) }
    savedRef.current = next
    setSaved(next)
  }, [storageKey])

  useLayoutEffect(() => {
    if (!container) return
    const measure = () => {
      const style = getComputedStyle(container)
      setWidth(Math.max(0, container.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [container])

  const stacked = width > 0 && width < stackBelow
  const available = Math.max(0, (width || 1000) - gutter * Math.max(0, definitions.length - 1))
  const preferences = saved.key === storageKey ? saved.sizes : {}
  const flexIndex = definitions.findIndex(pane => pane.defaultSize === undefined && pane.defaultRatio === undefined && pane.fixedSize === undefined)
  const sizes = definitions.map((pane, index) => index === flexIndex ? pane.minSize : pane.fixedSize ?? clamp(preferences[pane.id] ?? pane.defaultSize ?? available * (pane.defaultRatio ?? 0.5), pane.minSize, pane.maxSize ?? available))
  const minimums = definitions.map(pane => pane.fixedSize ?? pane.minSize)
  const minimumTotal = minimums.reduce((sum, value) => sum + value, 0)
  if (minimumTotal > available) {
    for (let index = 0; index < sizes.length; index++) sizes[index] = minimums[index] * available / minimumTotal
  } else {
    const total = sizes.reduce((sum, value) => sum + value, 0)
    const excess = Math.max(0, total - available)
    const capacity = sizes.reduce((sum, value, index) => sum + (index === flexIndex ? 0 : value - minimums[index]), 0)
    if (excess && capacity) {
      for (let index = 0; index < sizes.length; index++) {
        if (index !== flexIndex) sizes[index] -= (sizes[index] - minimums[index]) * Math.min(1, excess / capacity)
      }
    }
    if (flexIndex >= 0) sizes[flexIndex] = available - sizes.reduce((sum, value, index) => sum + (index === flexIndex ? 0 : value), 0)
  }

  function commit() {
    if (savedRef.current.key !== storageKey) return
    try { localStorage.setItem(storagePrefix + storageKey, JSON.stringify(savedRef.current.sizes)) } catch { /* Resizing also works when local storage is unavailable. */ }
  }

  function change(id: string, value?: number) {
    const nextSizes = { ...(savedRef.current.key === storageKey ? savedRef.current.sizes : {}) }
    // Keep other visible panes still when preferences were squeezed by a smaller window.
    definitions.forEach((pane, index) => {
      if (index !== flexIndex && pane.fixedSize === undefined) nextSizes[pane.id] = sizes[index]
    })
    if (value === undefined) delete nextSizes[id]
    else nextSizes[id] = value
    const next = { key: storageKey, sizes: nextSizes }
    savedRef.current = next
    setSaved(next)
  }

  function handle(id: string, label: string): HandleProps {
    const index = definitions.findIndex(pane => pane.id === id)
    const pane = definitions[index]
    const value = sizes[index] ?? 0
    const min = Math.min(pane.minSize, value)
    const others = sizes.reduce((sum, size, at) => sum + (at === index || at === flexIndex ? 0 : size), 0)
    const max = Math.max(min, Math.min(pane.maxSize ?? available, available - others - (definitions[flexIndex]?.minSize ?? 0)))
    return { label, value, min, max, direction: index < flexIndex ? 1 : -1,
      onChange: next => change(id, clamp(next, min, max)), onCommit: commit,
      onReset: () => { change(id); commit() } }
  }

  const style: CSSProperties = { gridTemplateColumns: stacked ? 'minmax(0, 1fr)' : definitions.map((_, index) => index === flexIndex ? 'minmax(0, 1fr)' : `${sizes[index]}px`).join(gutter ? ` ${gutter}px ` : ' '), columnGap: 0 }
  return { ref, style, handle, stacked }
}

export default function ResizeHandle({ label, value, min, max, direction, onChange, onCommit, onReset, className = '' }: HandleProps) {
  const elementRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const callbacks = useRef({ onChange, onCommit })
  callbacks.current = { onChange, onCommit }

  const finish = useCallback((cancel = false) => {
    const active = gesture.current
    if (!active) return
    gesture.current = null
    if (cancel) callbacks.current.onChange(active.startValue)
    callbacks.current.onCommit()
    setDragging(false)
    document.documentElement.classList.remove('resizing-panels')
    const element = elementRef.current
    if (element?.hasPointerCapture(active.pointerId)) element.releasePointerCapture(active.pointerId)
  }, [])

  useEffect(() => {
    const blur = () => finish()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); finish(true) } }
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('blur', blur); window.removeEventListener('keydown', escape, true); finish() }
  }, [finish])

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId) return
    event.preventDefault()
    onChange(active.startValue + (event.clientX - active.startX) * direction)
  }

  return <div ref={elementRef} className={`panel-resize-handle ${dragging ? 'is-dragging' : ''} ${className}`} role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} 像素`} tabIndex={0} title={`${label} · 拖动调整，双击恢复默认`}
    onClick={event => event.stopPropagation()}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary || max <= min) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      gesture.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value }
      event.currentTarget.setPointerCapture(event.pointerId)
      document.documentElement.classList.add('resizing-panels')
      setDragging(true)
    }}
    onPointerMove={move} onPointerUp={event => { if (gesture.current?.pointerId === event.pointerId) { move(event); finish() } }}
    onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish()} onDoubleClick={onReset}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
      event.preventDefault()
      if (event.key === 'Enter') { onReset(); return }
      onChange(event.key === 'Home' ? min : event.key === 'End' ? max : value + (event.key === 'ArrowLeft' ? -1 : 1) * direction * (event.shiftKey ? 40 : 10))
      onCommit()
    }} />
}
