export interface LiteratureDocument {
  id: string
  title: string
  originalName: string
  pdfPath: string
  size: number
  sha256: string
  createdAt: string
  updatedAt: string
}

export interface LiteratureWorkspace {
  documents: LiteratureDocument[]
}

export interface LiteratureRect {
  x: number
  y: number
  width: number
  height: number
}

export type LiteratureAnnotationKind = 'highlight' | 'underline' | 'note'
export type LiteratureAnnotationColor = 'yellow' | 'green' | 'blue' | 'pink'

export interface LiteratureAnnotationDraft {
  kind: LiteratureAnnotationKind
  page: number
  quote: string
  note: string
  color: LiteratureAnnotationColor
  rects: LiteratureRect[]
  expectedRevision?: number
}

export interface LiteratureAnnotation extends Omit<LiteratureAnnotationDraft, 'expectedRevision'> {
  id: string
  documentId: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface LiteratureImportResult {
  documents: LiteratureDocument[]
  importedIds: string[]
  duplicateIds: string[]
}
