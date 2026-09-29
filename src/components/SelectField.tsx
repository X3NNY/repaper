import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import '../select-field.css'

export interface SelectFieldOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectFieldProps {
  options: readonly SelectFieldOption[]
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  id?: string
  name?: string
  ariaLabel?: string
  disabled?: boolean
  autoFocus?: boolean
  className?: string
  placeholder?: string
  required?: boolean
}

interface MenuPosition {
  top: number
  left: number
  width: number
  maxHeight: number
  scrollable: boolean
}

function firstEnabled(options: readonly SelectFieldOption[]): number {
  return options.findIndex((option) => !option.disabled)
}

function lastEnabled(options: readonly SelectFieldOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index].disabled) return index
  }
  return -1
}

export default function SelectField({
  options, value, defaultValue = '', onChange, id, name, ariaLabel, disabled = false,
  autoFocus = false, className = '', placeholder = '请选择', required = false
}: SelectFieldProps) {
  const [internalValue, setInternalValue] = useState(defaultValue)
  const selectedValue = value === undefined ? internalValue : value
  const selectedOption = options.find((option) => option.value === selectedValue)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef({ text: '', at: 0 })
  const generatedId = useId()
  const triggerId = id ?? `${generatedId}-trigger`
  const listboxId = `${generatedId}-listbox`

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger || !trigger.isConnected) return
    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight
    const margin = 8
    const gap = 5
    const contentHeight = menuRef.current?.scrollHeight ?? (options.length ? options.length * 36 + 8 : 42)
    const naturalHeight = Math.ceil(contentHeight + 2)
    const desiredHeight = Math.min(naturalHeight, 260)
    const below = viewportHeight - rect.bottom - gap - margin
    const above = rect.top - gap - margin
    const placeAbove = below < desiredHeight && above > below
    const available = Math.max(36, placeAbove ? above : below)
    const maxHeight = Math.min(desiredHeight, available)
    const width = Math.min(Math.max(rect.width, 120), viewportWidth - margin * 2)
    const left = Math.min(Math.max(rect.left, margin), viewportWidth - width - margin)
    const top = placeAbove ? Math.max(margin, rect.top - gap - maxHeight) : Math.min(viewportHeight - margin - maxHeight, rect.bottom + gap)
    setMenuPosition({ top, left, width, maxHeight, scrollable: naturalHeight > maxHeight })
  }, [options.length])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    const trigger = triggerRef.current
    const menu = menuRef.current
    const observer = new ResizeObserver(updatePosition)
    if (trigger) observer.observe(trigger)
    if (menu) observer.observe(menu)
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return
      updatePosition()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', updatePosition)
    window.visualViewport?.addEventListener('resize', updatePosition)
    window.visualViewport?.addEventListener('scroll', updatePosition)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', updatePosition)
      window.visualViewport?.removeEventListener('resize', updatePosition)
      window.visualViewport?.removeEventListener('scroll', updatePosition)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      } else if (event.key === 'Tab') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    const menu = menuRef.current
    const option = menu?.children.item(activeIndex)
    if (!(menu && option instanceof HTMLElement)) return
    const optionRect = option.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    if (optionRect.top < menuRect.top) menu.scrollTop -= menuRect.top - optionRect.top
    else if (optionRect.bottom > menuRect.bottom) menu.scrollTop += optionRect.bottom - menuRect.bottom
  }, [open, activeIndex, menuPosition])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  function openMenu(nextActive?: number) {
    if (disabled) return
    const selectedIndex = options.findIndex((option) => option.value === selectedValue && !option.disabled)
    setActiveIndex(nextActive ?? (selectedIndex >= 0 ? selectedIndex : firstEnabled(options)))
    setOpen(true)
  }

  function choose(index: number) {
    const option = options[index]
    if (!option || option.disabled) return
    if (value === undefined) setInternalValue(option.value)
    if (option.value !== selectedValue) onChange?.(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  function moveActive(direction: 1 | -1) {
    if (!options.length) return
    let next = activeIndex
    for (let count = 0; count < options.length; count += 1) {
      next = (next + direction + options.length) % options.length
      if (!options[next].disabled) { setActiveIndex(next); return }
    }
  }

  function search(key: string) {
    const now = Date.now()
    const previous = searchRef.current
    const combined = now - previous.at < 650 ? previous.text + key.toLocaleLowerCase() : key.toLocaleLowerCase()
    const query = combined.length > 1 && [...combined].every((character) => character === combined[0]) ? combined[0] : combined
    searchRef.current = { text: combined, at: now }
    const selectedIndex = options.findIndex((option) => option.value === selectedValue)
    const start = (open ? activeIndex : selectedIndex) < 0 ? 0 : (open ? activeIndex : selectedIndex) + 1
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + offset) % options.length
      if (!options[index].disabled && options[index].label.toLocaleLowerCase().startsWith(query)) {
        if (!open) openMenu(index)
        else setActiveIndex(index)
        return
      }
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
      return
    }
    if (event.key === 'Tab') { setOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) openMenu()
      else moveActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const index = event.key === 'Home' ? firstEnabled(options) : lastEnabled(options)
      if (!open) openMenu(index)
      else setActiveIndex(index)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) openMenu()
      else choose(activeIndex)
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) search(event.key)
  }

  const menuStyle: CSSProperties = menuPosition
    ? { top: menuPosition.top, left: menuPosition.left, width: menuPosition.width, maxHeight: menuPosition.maxHeight }
    : { visibility: 'hidden' }
  const portalTarget = rootRef.current?.closest<HTMLElement>('.dialog-backdrop, .submission-modal-backdrop') ?? document.body

  return <span className={`select-field ${className}`.trim()} ref={rootRef}>
    {name ? <input type="hidden" name={name} value={selectedValue} disabled={disabled} /> : null}
    <button
      ref={triggerRef}
      id={triggerId}
      type="button"
      className={`select-field-trigger ${open ? 'is-open' : ''}`}
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
      aria-required={required || undefined}
      disabled={disabled}
      autoFocus={autoFocus}
      onClick={() => { if (open) setOpen(false); else openMenu() }}
      onKeyDown={handleKeyDown}
      title={selectedOption?.label}
    >
      <span className={`select-field-value ${selectedOption && selectedValue !== '' ? '' : 'is-placeholder'}`}>{selectedOption?.label ?? placeholder}</span>
      <ChevronDown size={15} className={`select-field-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />
    </button>
    {open ? createPortal(<div
      ref={menuRef}
      id={listboxId}
      className={`select-field-menu ${menuPosition?.scrollable ? 'is-scrollable' : ''}`}
      role="listbox"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : triggerId}
      style={menuStyle}
    >
      {options.length ? options.map((option, index) => <div
        key={`${option.value}-${index}`}
        id={`${listboxId}-option-${index}`}
        className={`select-field-option ${index === activeIndex ? 'is-active' : ''} ${option.value === selectedValue ? 'is-selected' : ''}`}
        role="option"
        aria-selected={option.value === selectedValue}
        aria-disabled={option.disabled || undefined}
        data-select-option-index={index}
        title={option.label}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => { if (!option.disabled) setActiveIndex(index) }}
        onClick={() => choose(index)}
      >
        <span>{option.label}</span>
        {option.value === selectedValue ? <Check size={14} aria-hidden="true" /> : null}
      </div>) : <div className="select-field-empty">暂无可选项</div>}
    </div>, portalTarget) : null}
  </span>
}
