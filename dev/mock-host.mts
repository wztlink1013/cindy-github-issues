import type { IncomingMessage, ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { Plugin } from 'vite'
import type { Account, CindyTask, FullIssue, IssueComment, IssueLabel, Page, Quota, Repository } from '../src/github'

const account: Account = { id: 42, login: 'preview-user' }
const repositories: Repository[] = [
  { name: 'preview/workbench', owner: 'preview', organization: true, private: false, archived: false, issues: true, role: 'admin' },
  { name: 'preview/docs', owner: 'preview', organization: true, private: true, archived: false, issues: true, role: 'push' },
  { name: 'preview-user/archive', owner: 'preview-user', organization: false, private: false, archived: true, issues: true, role: 'pull' },
]
const titles = [
  '加载评论时保留草稿和光标位置',
  '收起筛选栏时保持列表滚动位置',
  '检查暗色主题下状态标签的对比度',
  '调整窄窗口中详情页的返回按钮',
  '新建 Issue 失败后保留表单内容',
  '优化仓库选择器的键盘操作',
  '为很长的 Issue 标题检查换行',
  '补充 Issue 分页的空状态',
  '统一工具提示的位置与间距',
  '显示私有仓库和归档仓库的状态',
  '检查屏幕阅读器中的评论提示',
  '调整小屏幕中标签和指派人的间距',
]
const hour = 60 * 60 * 1000
const labels: IssueLabel[] = [
  { name: 'ui', color: 'a2eeef' }, { name: 'bug', color: 'd73a4a' }, { name: 'documentation', color: '0075ca' },
]
const keyboardLabel = { name: 'keyboard', color: 'a978d2' }
const guideLabel = { name: 'guide', color: '2ea381' }

type DemoIssue = FullIssue & { thread: IssueComment[] }
type Reply = { ok: true; data: unknown; quota: Quota } | { ok: false; code: string; message: string; quota: Quota }

function pageOf<T>(items: T[], value: unknown, size: number): Page<T> {
  const page = typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1
  const offset = (page - 1) * size
  return { items: items.slice(offset, offset + size), hasNext: offset + size < items.length }
}

function withoutThread({ thread, ...issue }: DemoIssue): FullIssue {
  return issue
}

function seedIssues(repo: Repository, clock: number): DemoIssue[] {
  const names = repo === repositories[0] ? titles : repo === repositories[1]
    ? ['补充插件本地预览说明', '更新安装与账号切换指引']
    : ['归档仓库中的示例 Issue']
  return names.map((title, index) => {
    const updated = new Date(clock - (index + 1) * hour).toISOString()
    const thread = index < 3 ? [
      { id: index * 2 + 1, author: 'preview-user', created: updated, body: '已在 **本地预览** 复现。\n\n> 刷新评论时，保留输入框里的草稿。\n\n详情见 [GitHub 文档](https://docs.github.com/issues)。' },
      { id: index * 2 + 2, author: 'demo-reviewer', created: updated, body: '也可以试试切换浅色和深色，或将窗口缩窄后返回列表。' },
    ] : []
    return {
      number: names.length - index, title, updated, thread,
      state: index > 9 ? 'closed' : 'open', author: account.login, comments: thread.length,
      labels: [repo === repositories[1] && index === 0 ? guideLabel : repo === repositories[0] && index === 7 ? keyboardLabel : labels[index % labels.length]],
      assignees: index % 2 === 0 ? ['preview-user'] : [],
      body: [
        '## 复现步骤', '', '1. 在列表打开一个 **Issue**。', '2. 刷新详情和评论，观察滚动位置。', '',
        '### 验收条件', '', '- [x] 保留评论草稿', '- [ ] 窄窗口下可返回列表', '',
        '| 视图 | 操作 |', '| --- | --- |', '| 详情 | 刷新评论 |', '',
        '```sh', 'gh issue view --comments', '```',
      ].join('\n'),
      locked: false,
    }
  })
}

function createMockHost() {
  const now = Date.now()
  const issues = new Map(repositories.map(repo => [repo.name, seedIssues(repo, now)]))
  let settings: unknown = { accounts: { [account.id]: { repositories: repositories.slice(0, 2) } } }
  let nextComment = 100
  const pending = new Map<string, Promise<Reply>>()
  const quota = (): Quota => ({
    accountId: account.id, core: { limit: 5000, remaining: 4920, reset: now + hour, observedAt: Date.now() }, cooldown: null,
  })
  const ok = (data: unknown): Reply => ({ ok: true, data, quota: quota() })
  const failure = (code: string, message: string): Reply => ({ ok: false, code, message, quota: quota() })

  async function dispatch(action: string, args: Record<string, unknown>): Promise<Reply> {
    if (action === 'account') return ok(account)
    if (action === 'quota') return ok(null)
    if (action === 'repositories') return ok(pageOf(repositories, args.page, 2))
    const repo = repositories.find(item => item.name === args.repo)
    const list = repo && issues.get(repo.name)
    if (!repo || !list) return failure('NOT_FOUND', '找不到预览仓库。')
    if (action === 'labels') {
      const catalog = new Map(list.flatMap(issue => issue.labels).map(label => [label.name, label]))
      return ok(pageOf([...catalog.values()], args.page, 3))
    }
    if (action === 'issues') {
      const selectedLabel = typeof args.label === 'string' && !args.label.includes(',') ? args.label.toLowerCase() : ''
      const visible = list.filter(issue => (args.state === 'all' || args.state === issue.state)
        && (!selectedLabel || issue.labels.some(label => label.name.toLowerCase() === selectedLabel)))
      visible.sort((a, b) => b.updated.localeCompare(a.updated) || b.number - a.number)
      return ok(pageOf(visible.map(withoutThread), args.page, 6))
    }
    if (action === 'create' && !repo.archived && typeof args.title === 'string' && typeof args.body === 'string') {
      const issue: DemoIssue = { number: Math.max(0, ...list.map(item => item.number)) + 1, title: args.title,
        body: args.body, author: account.login, state: 'open', updated: new Date().toISOString(),
        comments: 0, labels: [], assignees: [], locked: false, thread: [] }
      list.push(issue)
      return ok(withoutThread(issue))
    }
    const issue = list.find(item => item.number === args.number)
    if (!issue) return failure('NOT_FOUND', '找不到预览 Issue。')
    if (action === 'issue') return ok(withoutThread(issue))
    if (action === 'handOffIssue' && args.accountId === account.id) {
      const task: CindyTask = { taskId: 'preview:' + repo.name + '#' + issue.number, title: repo.name + ' #' + issue.number, preview: true }
      return ok(task)
    }
    if (action === 'comments') {
      await delay(500)
      return ok(pageOf(issue.thread, args.page, 1))
    }
    if (repo.archived) return failure('FORBIDDEN', '归档仓库仅供查看。')
    if (action === 'comment' && typeof args.body === 'string') {
      const comment = { id: nextComment++, author: account.login, created: new Date().toISOString(), body: args.body }
      issue.thread.push(comment)
      issue.comments = issue.thread.length
      issue.updated = comment.created
      return ok(comment)
    }
    const values = Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === 'string') : []
    if (action === 'state' && (args.state === 'open' || args.state === 'closed')) issue.state = args.state
    else if (action === 'addLabels') {
      const current = new Map(issue.labels.map(item => [item.name, item]))
      for (const name of values) current.set(name, current.get(name) ?? labels.find(label => label.name === name) ?? { name })
      issue.labels = [...current.values()]
    }
    else if (action === 'removeLabel') issue.labels = issue.labels.filter(label => label.name !== args.value)
    else if (action === 'addAssignees') issue.assignees = [...new Set([...issue.assignees, ...values])]
    else if (action === 'removeAssignees') issue.assignees = issue.assignees.filter(name => !values.includes(name))
    else return failure('INVALID_INPUT', '预览请求无效。')
    issue.updated = new Date().toISOString()
    return ok(withoutThread(issue))
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.url === '/wake' && request.method === 'GET') {
      response.setHeader('X-Cindy-Preview', 'github-issues')
      return json(response, 200, {})
    }
    if (request.url === '/kv' && request.method === 'GET') return json(response, 200, settings)
    if (request.url === '/kv' && request.method === 'PUT') {
      settings = await readJson(request)
      return json(response, 204)
    }
    if (request.url !== '/__cindy_preview/rpc' || request.method !== 'POST') return json(response, 405)
    const payload = await readJson(request)
    if (!isRecord(payload) || typeof payload.id !== 'string' || !/^[a-f0-9]{32}$/.test(payload.id)
      || typeof payload.action !== 'string' || !isRecord(payload.args)) return json(response, 400)
    const { id, action, args } = payload
    let result = pending.get(id)
    if (!result) {
      result = dispatch(action, args)
      pending.set(id, result)
      // Two open preview tabs can relay the same BroadcastChannel request.
      setTimeout(() => pending.delete(id), 30000).unref()
    }
    json(response, 200, await result)
  }

  return handle
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

class PreviewRequestError extends Error {
  readonly status: number
  constructor(status: number) {
    super('Invalid preview request')
    this.status = status
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const bytes of request) {
    size += bytes.length
    if (size > 262144) throw new PreviewRequestError(413)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new PreviewRequestError(400) }
}

function json(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

export function githubIssuesMockPreview(): Plugin {
  return {
    name: 'github-issues-mock-preview',
    apply: 'serve',
    configureServer(server) {
      const handle = createMockHost()
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/wake' && request.url !== '/kv' && request.url !== '/__cindy_preview/rpc') return next()
        void handle(request, response).catch(error => {
          if (!response.headersSent && !response.destroyed) json(response, error instanceof PreviewRequestError ? error.status : 500)
        })
      })
    },
    transformIndexHtml: {
      order: 'pre',
      handler(_html, context) {
        if (!context.server || context.path === '/settings.html') return
        return [{ tag: 'script', attrs: { type: 'module', src: '/dev/mock-bridge.ts' }, injectTo: 'head-prepend' }]
      },
    },
  }
}
