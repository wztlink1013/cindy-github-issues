export const isBrowserPreview = ['http:', 'https:'].includes(window.location.protocol)

export type IssueState = 'open' | 'closed'
export type StateFilter = IssueState | 'all'
export type Account = { id: number; login: string }
export type IssueLabel = { name: string; color?: string }
export type Repository = {
  name: string
  owner: string
  organization: boolean
  private: boolean
  archived: boolean
  issues: boolean
  role: 'admin' | 'maintain' | 'push' | 'triage' | 'pull' | 'unknown'
}
export type Issue = {
  number: number
  title: string
  state: IssueState
  updated: string
  author: string
  comments: number
  labels: IssueLabel[]
  assignees: string[]
}
export type FullIssue = Issue & { body: string; locked: boolean; warning?: string }
export type IssueComment = { id: number; author: string; created: string; body: string }
export type Page<T> = { items: T[]; hasNext: boolean }
export type Quota = {
  accountId: number | null
  core: { remaining: number; limit: number; reset: number; observedAt: number } | null
  cooldown: { kind: 'primary' | 'secondary'; until: number } | null
}
export type IssueTarget = { repo: string; number: number; accountId: number }
export type IssueMutation =
  | { action: 'comment'; args: { body: string } }
  | { action: 'state'; args: { state: IssueState } }
  | { action: 'addLabels' | 'addAssignees' | 'removeAssignees'; args: { values: string[] } }
  | { action: 'removeLabel'; args: { value: string } }

type Actions = {
  account: [Record<string, never>, Account]
  quota: [{ accountId: number }, null]
  repositories: [{ accountId: number; page: number }, Page<Repository>]
  labels: [{ repo: string; accountId: number; page: number }, Page<IssueLabel>]
  issues: [{ repo: string; page: number; state: StateFilter; label?: string }, Page<Issue>]
  issue: [Pick<IssueTarget, 'repo' | 'number'>, FullIssue]
  comments: [IssueTarget & { page: number }, Page<IssueComment>]
  create: [{ repo: string; accountId: number; title: string; body: string }, FullIssue]
  comment: [IssueTarget & { body: string }, IssueComment]
  state: [IssueTarget & { state: IssueState }, FullIssue]
  addLabels: [IssueTarget & { values: string[] }, FullIssue]
  removeLabel: [IssueTarget & { value: string }, FullIssue]
  addAssignees: [IssueTarget & { values: string[] }, FullIssue]
  removeAssignees: [IssueTarget & { values: string[] }, FullIssue]
}

type Reply = { ok: true; data: unknown; quota?: Quota } | { ok: false; code: string; message: string; quota?: Quota }
type Pending = { stopRetry: () => void; receive: (result: Reply) => void; cancel: () => void }
const mutations = new Set<keyof Actions>(['create', 'comment', 'state', 'addLabels', 'removeLabel', 'addAssignees', 'removeAssignees'])
const repoPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/i
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

export class GitHubError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export function hasErrorCode(error: unknown, code: string) {
  return error instanceof GitHubError && error.code === code
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'GitHub 操作失败，请重试。'
}

export function formatTime(value: string | number) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : ''
}

export function issueKey(repo: string, number: number) {
  return repo.toLowerCase() + '#' + number
}

export function issueUrl(repo: string, number: number) {
  return 'https://github.com/' + repo.split('/').map(encodeURIComponent).join('/') + '/issues/' + number
}

export function createGitHubClient(onQuota: (snapshot: Quota | null) => void) {
  let channel: BroadcastChannel | undefined
  let generation = 0
  let accountId: number | null = null
  let quota: Quota | null = null
  let lastAccountCheck = 0
  const pending = new Map<string, Pending>()

  function getChannel() {
    if (channel) return channel
    channel = new BroadcastChannel('cindy-github-issues/v1')
    channel.onmessage = ({ data }) => {
      if (typeof data?.id !== 'string') return
      const call = pending.get(data.id)
      if (data.type === 'ack') call?.stopRetry()
      if (data.type === 'result' && typeof data.result?.ok === 'boolean') call?.receive(data.result)
    }
    return channel
  }

  async function request<K extends keyof Actions>(action: K, args: Actions[K][0]): Promise<Actions[K][1]> {
    const until = quota?.cooldown?.until ?? 0
    if (until > Date.now()) throw new GitHubError('RATE_LIMIT', 'GitHub 当前限流，请在 ' + formatTime(until) + ' 后重试。')
    const context = generation
    const wake = await fetch('/wake').catch(() => null)
    if (context !== generation) throw new GitHubError('CANCELLED', '页面已切换。')
    if (isBrowserPreview && (!wake?.ok || wake.headers.get('X-Cindy-Preview') !== 'github-issues')) {
      throw new GitHubError('PREVIEW_UNAVAILABLE', '无法连接 Vite 开发服务器的模拟接口。')
    }
    if (!wake?.ok) throw new GitHubError('BRIDGE', '无法唤醒插件，请重新检测。')
    const connection = getChannel()
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    const message = { type: 'request', id, action, args }
    return new Promise((resolve, reject) => {
      const retry = window.setInterval(() => connection.postMessage(message), 450)
      const timeout = window.setTimeout(() => {
        finish()
        reject(mutations.has(action)
          ? new GitHubError('WRITE_UNCERTAIN', '无法确认 GitHub 是否已保存。请先核对结果，再决定是否重试。')
          : new GitHubError('TIMEOUT', 'GitHub 后台响应超时，请重试。'))
      }, action === 'state' ? 177000 : 88000)

      function stopRetry() { window.clearInterval(retry) }
      function finish() {
        stopRetry()
        window.clearTimeout(timeout)
        pending.delete(id)
      }

      pending.set(id, {
        stopRetry,
        receive(result) {
          finish()
          const snapshot = result.quota
          if (snapshot && (accountId === null || snapshot.accountId === accountId) && (snapshot.core || snapshot.cooldown || quota)) {
            quota = { ...snapshot, core: snapshot.core ?? quota?.core ?? null }
            onQuota(quota)
          }
          if (result.ok) {
            if (action === 'account') lastAccountCheck = Date.now()
            resolve(result.data as Actions[K][1])
          } else {
            reject(new GitHubError(result.code, result.message))
          }
        },
        cancel() {
          finish()
          reject(new GitHubError('CANCELLED', '页面已切换。'))
        },
      })
      connection.postMessage(message)
    })
  }

  return {
    request,
    reset() {
      generation++
      for (const call of pending.values()) call.cancel()
      accountId = null
      quota = null
      onQuota(null)
    },
    selectAccount(id: number) { accountId = id },
    retryAt() { return quota?.cooldown?.until ?? 0 },
    lastAccountCheck() { return lastAccountCheck },
    async assertAccount(expected: number) {
      if ((await request('account', {})).id !== expected) throw new GitHubError('ACCOUNT_CHANGED', '本机 GitHub CLI 账号已切换。')
    },
    async edit(target: IssueTarget, mutation: Exclude<IssueMutation, { action: 'comment' }>) {
      switch (mutation.action) {
        case 'state': return request('state', { ...target, ...mutation.args })
        case 'addLabels': return request('addLabels', { ...target, ...mutation.args })
        case 'removeLabel': return request('removeLabel', { ...target, ...mutation.args })
        case 'addAssignees': return request('addAssignees', { ...target, ...mutation.args })
        case 'removeAssignees': return request('removeAssignees', { ...target, ...mutation.args })
      }
    },
  }
}

export type GitHubClient = ReturnType<typeof createGitHubClient>
export type Reporter = (error: unknown) => boolean

export type RepositorySelection = { repositories: Repository[]; defaultRepository: string }
type Settings = { accounts?: Record<string, Partial<RepositorySelection>> }

export function getDefaultRepository(repositories: Repository[], preferred?: string) {
  const name = typeof preferred === 'string' ? preferred.toLowerCase() : ''
  return repositories.find(repo => repo.name.toLowerCase() === name)?.name ?? repositories[0]?.name ?? ''
}

async function readSettings(): Promise<Settings> {
  const response = await fetch('/kv')
  if (!response.ok) throw new Error('无法读取已保存的仓库选择。')
  return await response.json()
}

export async function readRepositories(account: Account) {
  const saved = (await readSettings()).accounts?.[String(account.id)]
  const repositories = Array.isArray(saved?.repositories)
    ? saved.repositories.filter(repo => typeof repo?.name === 'string' && repoPattern.test(repo.name)) : []
  return { repositories, defaultRepository: getDefaultRepository(repositories, saved?.defaultRepository) }
}

export async function saveRepositories(client: GitHubClient, account: Account, selection: RepositorySelection) {
  await client.assertAccount(account.id)
  const settings = await readSettings()
  const id = String(account.id)
  const accounts = { ...settings.accounts, [id]: { ...settings.accounts?.[id], ...selection } }
  const response = await fetch('/kv', { method: 'PUT', body: JSON.stringify({ ...settings, accounts }) })
  if (!response.ok) throw new Error(response.status === 413 ? '仓库选择超过保存上限，请减少选择。' : '无法保存仓库选择。')
}
