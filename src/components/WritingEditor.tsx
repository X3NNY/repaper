import { useEffect, useRef } from 'react'
import { StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { basicSetup, EditorView } from 'codemirror'

interface Props {
  filePath: string
  value: string
  onChange: (value: string) => void
  onSave: () => void
  reviewOriginal?: string
}

const latex = StreamLanguage.define(stex)
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#fff', color: '#263b32', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'Cascadia Mono, Consolas, monospace', lineHeight: '1.65' },
  '.cm-content': { padding: '20px 10px 60px', caretColor: '#1e5b49' },
  '.cm-gutters': { backgroundColor: '#f8faf7', color: '#a6b5a8', borderRight: '1px solid #e8eee6' },
  '.cm-activeLine': { backgroundColor: '#edf4ed78' },
  '.cm-activeLineGutter': { backgroundColor: '#eaf1e9' },
  '.cm-selectionBackground': { backgroundColor: '#cfe4d2 !important' }
})

const reviewTheme = EditorView.theme({
  '&.cm-merge-b .cm-changedLine': { backgroundColor: '#e7f5e8' },
  '&.cm-merge-b .cm-changedText': { background: 'linear-gradient(#78bd8680, #78bd8680) bottom/100% 2px no-repeat' },
  '.cm-deletedChunk': { backgroundColor: '#fff0ec', borderLeft: '3px solid #c97668', color: '#94574d' },
  '.cm-deletedLineGutter': { backgroundColor: '#c97668' },
  '.cm-changedLineGutter': { backgroundColor: '#55a56b' }
})

export default function WritingEditor({ filePath, value, onChange, onSave, reviewOriginal }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      doc: value,
      extensions: [
        basicSetup,
        theme,
        EditorView.lineWrapping,
        ...(filePath.toLowerCase().endsWith('.tex') ? [latex] : []),
        ...(reviewOriginal === undefined ? [EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        })] : [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          reviewTheme,
          unifiedMergeView({ original: reviewOriginal, mergeControls: false, gutter: true, highlightChanges: true, collapseUnchanged: { margin: 3, minSize: 8 } })
        ])
      ]
    })
    viewRef.current = view
    view.focus()
    return () => { viewRef.current = null; view.destroy() }
  }, [filePath, reviewOriginal])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  return <div className="writing-editor-host" ref={hostRef} onKeyDown={(event) => {
    if (reviewOriginal === undefined && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      onSaveRef.current()
    }
  }} />
}
