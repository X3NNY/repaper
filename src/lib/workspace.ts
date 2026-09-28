import { emptyWorkspace, isWorkspaceData, type Paper, type WorkspaceData } from '../../shared/model'

const browserStorageKey = 'repaper.workspace.v1'

export async function loadWorkspace(): Promise<WorkspaceData> {
  if (window.paperApi) return window.paperApi.loadWorkspace()
  const stored = localStorage.getItem(browserStorageKey)
  if (!stored) return emptyWorkspace()
  const parsed: unknown = JSON.parse(stored)
  if (!isWorkspaceData(parsed)) throw new Error('本地数据格式不受支持。')
  return parsed
}

export async function saveWorkspace(workspace: WorkspaceData): Promise<void> {
  if (window.paperApi) return window.paperApi.saveWorkspace(workspace)
  localStorage.setItem(browserStorageKey, JSON.stringify(workspace))
}

export async function chooseFile(): Promise<string | null> {
  return window.paperApi?.chooseFile() ?? null
}

export async function chooseFolder(): Promise<string | null> {
  return window.paperApi?.chooseFolder() ?? null
}

export async function openFile(path: string): Promise<void> {
  if (!window.paperApi) throw new Error('请在桌面应用中打开本地文件。')
  const error = await window.paperApi.openFile(path)
  if (error) throw new Error(error)
}

export function createId(): string {
  return crypto.randomUUID()
}

export function today(): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatDate(value: string): string {
  if (!value) return '未设置日期'
  const date = parseDate(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

export function formatShortDate(value: string): string {
  if (!value) return '—'
  const date = parseDate(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)
}

function parseDate(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value)
}

export function mostRecentPaper(papers: Paper[]): Paper[] {
  return [...papers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export const paperStatusLabels = {
  idea: '构思中',
  research: '研究中',
  writing: '写作中',
  submitted: '审稿中',
  revision: '修改中',
  published: '已发表',
  paused: '已暂停'
} as const

export const routeStatusLabels = {
  exploring: '探索中',
  active: '进行中',
  paused: '已暂停',
  closed: '已结束'
} as const

export const implementationStatusLabels = {
  planned: '待开始',
  in_progress: '进行中',
  done: '已完成',
  blocked: '受阻'
} as const

export const submissionStatusLabels = {
  under_review: '审稿中',
  revision: '需修改',
  rejected: '被拒稿',
  accepted: '已接收',
  withdrawn: '已撤稿'
} as const

export const revisionStatusLabels = {
  todo: '待处理',
  in_progress: '进行中',
  done: '已完成'
} as const

export function createSamplePaper(): Paper {
  const stamp = new Date().toISOString()
  const routeA = createId()
  const routeB = createId()
  const versionA = createId()
  const versionB = createId()
  const submissionA = createId()

  return {
    id: createId(),
    title: '面向长文档推理的层级检索方法',
    shortName: 'Hierarchical Retrieval',
    summary: '比较不同的检索与推理路径，记录从初始实验到重投版本的变化。此项目是可随时删除的示例。',
    status: 'revision',
    tags: ['NLP', 'Retrieval', '示例'],
    createdAt: stamp,
    updatedAt: stamp,
    routes: [
      {
        id: routeA,
        name: '路线 A · 分层检索',
        objective: '先定位章节，再检索证据段落，控制长文档噪声。',
        status: 'active',
        createdAt: stamp,
        implementations: [
          { id: createId(), title: '章节索引基线', details: '完成索引构建与第一轮消融。', status: 'done', repositoryPath: '', createdAt: stamp },
          { id: createId(), title: '跨章节证据聚合', details: '补充多跳问题上的实验。', status: 'in_progress', repositoryPath: '', createdAt: stamp }
        ]
      },
      {
        id: routeB,
        name: '路线 B · 全局向量检索',
        objective: '作为对照，测试无章节约束的召回效果。',
        status: 'paused',
        createdAt: stamp,
        implementations: [
          { id: createId(), title: '全局向量索引', details: '召回率较高，但最终答案噪声偏大。', status: 'done', repositoryPath: '', createdAt: stamp }
        ]
      }
    ],
    versions: [
      { id: versionA, label: 'v1 · 初投稿', notes: '采用路线 A 的第一轮结果。', routeIds: [routeA], filePath: '', createdAt: stamp },
      { id: versionB, label: 'v2 · 修改稿', notes: '补充消融与路线 B 对照实验。', routeIds: [routeA, routeB], filePath: '', createdAt: stamp }
    ],
    submissions: [
      { id: submissionA, venue: 'ACL', submittedAt: today(), status: 'revision', versionId: versionA, previousSubmissionId: '', notes: '根据审稿意见增加跨章节实验。' },
      { id: createId(), venue: 'EMNLP', submittedAt: today(), status: 'under_review', versionId: versionB, previousSubmissionId: submissionA, notes: '修改后重投，等待结果。' }
    ],
    revisions: [
      { id: createId(), title: '补充跨章节问题的误差分析', notes: '对比两条路线的失败案例。', status: 'in_progress', dueDate: '', submissionId: submissionA, createdAt: stamp }
    ]
  }
}
