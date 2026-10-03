export type BuiltinWritingTemplate = 'ieee-single' | 'ieee-double' | 'blank'
export type WritingTemplate = BuiltinWritingTemplate | `custom:${string}`
export type WritingTemplateSource = 'builtin' | 'folder' | 'file' | 'archive'

export interface WritingTemplateInfo {
  id: WritingTemplate
  name: string
  description: string
  builtin: boolean
  mainFile: string
  candidates: string[]
  fileCount: number
  totalBytes: number
  sourceKind: WritingTemplateSource
  sourceName: string
  createdAt: string
}

export interface WritingTemplateLibrary {
  templates: WritingTemplateInfo[]
  defaultTemplate: WritingTemplate | ''
}

export interface WritingTemplateImport {
  token: string
  name: string
  sourceName: string
  sourceKind: Exclude<WritingTemplateSource, 'builtin'>
  candidates: string[]
  mainFile: string
  fileCount: number
  totalBytes: number
}

export interface WritingTemplateDraft {
  name: string
  description: string
  mainFile: string
}

export const builtinWritingTemplates: WritingTemplateInfo[] = [
  { id: 'ieee-single', name: 'IEEE 单栏', description: 'IEEEtran 单栏草稿', fileCount: 2 },
  { id: 'ieee-double', name: 'IEEE 双栏', description: 'IEEEtran 期刊双栏', fileCount: 2 },
  { id: 'blank', name: '空模板', description: '空白 article 文稿', fileCount: 1 }
].map(item => ({ ...item, id: item.id as BuiltinWritingTemplate, builtin: true, mainFile: 'manuscript.tex', candidates: ['manuscript.tex'], totalBytes: 0, sourceKind: 'builtin' as const, sourceName: '', createdAt: '' }))
export type LatexEngine = 'pdflatex' | 'xelatex'

export interface WritingFile {
  path: string
  name: string
  kind: 'file' | 'directory'
  children?: WritingFile[]
}

export interface WritingWorkspace {
  initialized: boolean
  rootPath: string
  mainFile: string
  gitReady: boolean
  files: WritingFile[]
  pdfAvailable: boolean
}

export interface WritingCompileResult {
  success: boolean
  engine: LatexEngine
  mode: 'quick' | 'full'
  steps: string[]
  log: string
  error?: string
}

export interface WritingSourceLocation {
  path: string
  line: number
  column: number
}

export interface WritingHistoryEntry {
  hash: string
  message: string
  committedAt: string
  files: number
  additions: number
  deletions: number
}

export interface WritingChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  binary: boolean
}

export interface WritingChangeSummary {
  files: WritingChange[]
  totalFiles: number
  additions: number
  deletions: number
}

export interface WritingReviewFile {
  original: string
  current: string
  binary: boolean
}

export interface WritingTemplateSwitchPreview {
  token: string
  templateId: WritingTemplate
  templateName: string
  sourceMainFile: string
  mainFile: string
  sourceFingerprint: string
  canApply: boolean
  warnings: string[]
  summary: string
  changes: WritingChangeSummary
  original: string
  current: string
}

export interface WritingTemplateSwitchResult {
  workspace: WritingWorkspace
  originalBranch: string
  templateBranch: string
  originalCommit: string
  templateCommit: string
}
