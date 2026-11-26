import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, CircleAlert, CircleDot, GitFork, Inbox, ListFilter, LoaderCircle, MessageSquare, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster } from '@/components/ui/sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { IssueDetail, IssueStatus } from '@/components/issue-detail'
import { ChooseRepositories, CreateIssue } from '@/components/workbench-dialogs'
import { createGitHubClient, errorMessage, formatTime, hasErrorCode, issueKey, readRepositories, type Account, type FullIssue, type Quota, type Repository, type StateFilter } from '@/github'
import { filterIssues, useIssueFeed } from '@/issue-feed'
import { useCindyTheme } from '@/theme'
import '@fontsource-variable/geist'
import './index.css'

const wideScreen = '(min-width: 880px)'
const numberFormat = new Intl.NumberFormat('zh-CN')

type Selection = { repo: string; number: number; knownIssue?: FullIssue; focusHeading: boolean }

function QuotaBar({ quota, busy, canRefresh, onRefresh }: { quota: Quota | null; busy: boolean; canRefresh: boolean; onRefresh: () => void }) {
  const [now, setNow] = useState(Date.now)
  const reset = quota?.core?.reset ?? 0
  const blocked = quota?.cooldown?.until ?? 0
  const nextTick = Math.min(...[reset, blocked].filter(value => value > now))
  useEffect(() => {
    if (!Number.isFinite(nextTick)) return
    const timeout = window.setTimeout(() => setNow(Date.now()), Math.max(10, nextTick - Date.now() + 30))
    return () => clearTimeout(timeout)
  }, [nextTick])
  const core = quota?.core
  const blockedNow = blocked > now
  const low = Boolean(core && core.reset > now && core.remaining <= Math.max(10, core.limit * 0.05))
  const hoverText = core ? '更新于 ' + formatTime(core.observedAt) : '手动读取 GitHub REST API 额度'
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-3 py-1.5 text-xs" role="status">
      <Activity className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span className="font-medium">REST API 额度</span>
      <span className={'font-mono tabular-nums ' + (low || blockedNow ? 'text-warning' : 'text-foreground')}>
        {core ? numberFormat.format(core.remaining) + ' / ' + numberFormat.format(core.limit) : '—'}
      </span>
      {blockedNow
        ? <Badge variant="outline" className="text-warning">{quota?.cooldown?.kind === 'primary' ? '额度耗尽' : '请求限流'} · {formatTime(blocked)} 后可重试</Badge>
        : core && <span className="text-muted-foreground">{reset > now ? '重置于 ' + formatTime(reset) : '上次周期已结束'}</span>}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" className="ms-auto" aria-label="刷新额度" onClick={onRefresh} disabled={!canRefresh || busy || blockedNow}>
            <RefreshCw className={busy ? 'animate-spin' : undefined} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{hoverText}</TooltipContent>
      </Tooltip>
    </div>
  )
}

function App() {
  const theme = useCindyTheme()
  const [account, setAccount] = useState<Account | null>(null)
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [quota, setQuota] = useState<Quota | null>(null)
  const [client] = useState(() => createGitHubClient(setQuota))
  const [checking, setChecking] = useState(true)
  const [quotaBusy, setQuotaBusy] = useState(false)
  const [error, setError] = useState('')
  const [writing, setWriting] = useState(false)
  const [repoFilter, setRepoFilter] = useState('')
  const [state, setState] = useState<StateFilter>('open')
  const [search, setSearch] = useState('')
  const [label, setLabel] = useState('')
  const [assignee, setAssignee] = useState('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [draft, setDraft] = useState('')
  const drafts = useRef(new Map<string, string>())
  const writeLock = useRef(false)
  const detecting = useRef(false)
  const restoreFocus = useRef<string | null>(null)
  const listHeading = useRef<HTMLHeadingElement>(null)

  const detect = useCallback(async (accountChanged = false) => {
    if (detecting.current || (writeLock.current && !accountChanged)) return
    const until = client.retryAt()
    if (until > Date.now()) {
      setError('GitHub 当前限流，请在 ' + formatTime(until) + ' 后重新检测。')
      return
    }
    detecting.current = true
    client.reset()
    setChecking(true)
    setError('')
    setAccount(null)
    setRepositories([])
    setSelection(null)
    try {
      const active = await client.request('account', {})
      client.selectAccount(active.id)
      const saved = await readRepositories(active)
      setRepositories(saved)
      setRepoFilter('')
      setSearch('')
      setState('open')
      setLabel('')
      setAssignee('')
      setAccount(active)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      detecting.current = false
      setChecking(false)
    }
  }, [client])

  const report = useCallback((cause: unknown) => {
    if (hasErrorCode(cause, 'ACCOUNT_CHANGED')) { void detect(true); return true }
    return hasErrorCode(cause, 'CANCELLED')
  }, [detect])

  useEffect(() => { void detect() }, [detect])
  useEffect(() => {
    function checkAccount() {
      if (!account || writeLock.current || Date.now() - client.lastAccountCheck() < 60000 || client.retryAt() > Date.now()) return
      void client.assertAccount(account.id).catch(cause => { if (!report(cause)) setError(errorMessage(cause)) })
    }
    window.addEventListener('focus', checkAccount)
    return () => window.removeEventListener('focus', checkAccount)
  }, [account, client, report])

  useEffect(() => {
    const row = restoreFocus.current
    if (selection || row === null) return
    restoreFocus.current = null
    const target = document.getElementById(row) ?? listHeading.current
    target?.focus({ preventScroll: true })
  }, [selection])

  const feed = useIssueFeed(client, account?.id ?? null, repositories, repoFilter, state, report)
  const items = useMemo(() => filterIssues(feed.items, search, label, assignee), [feed.items, search, label, assignee])
  const activeRepo = selection && repositories.find(repo => repo.name.toLowerCase() === selection.repo.toLowerCase())
  const activeKey = activeRepo && selection ? issueKey(activeRepo.name, selection.number) : ''

  function startWrite() {
    if (writeLock.current || detecting.current) return false
    writeLock.current = true
    setWriting(true)
    return true
  }

  function finishWrite() {
    writeLock.current = false
    setWriting(false)
  }

  function activate(row: Selection) {
    if (!account) return
    setDraft(drafts.current.get(account.id + ':' + issueKey(row.repo, row.number)) ?? '')
    setSelection(row)
  }

  function openRow(repo: string, number: number, viaKeyboard: boolean) {
    if (writeLock.current) return
    activate({ repo, number, focusHeading: viaKeyboard || !matchMedia(wideScreen).matches })
  }

  function backToList() {
    restoreFocus.current = 'issue-row-' + activeKey
    setSelection(null)
  }

  function updateDraft(value: string) {
    if (!account || !activeKey) return
    const id = account.id + ':' + activeKey
    if (value) drafts.current.set(id, value)
    else drafts.current.delete(id)
    setDraft(value)
  }

  async function refreshQuota() {
    if (!account || quotaBusy) return
    setQuotaBusy(true)
    try {
      await client.request('quota', { accountId: account.id })
    } catch (cause) {
      if (!report(cause)) setError(errorMessage(cause))
    } finally {
      setQuotaBusy(false)
    }
  }

  function saveRepositories(next: Repository[]) {
    setRepositories(next)
    if (repoFilter && !next.some(repo => repo.name.toLowerCase() === repoFilter)) setRepoFilter('')
    if (selection && !next.some(repo => repo.name.toLowerCase() === selection.repo.toLowerCase())) backToList()
  }

  return (
    <TooltipProvider>
      <main className="workbench mx-auto flex h-dvh max-w-[1640px] flex-col gap-3 px-3 py-4 sm:px-6 sm:py-5">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="workbench-mark grid size-10 shrink-0 place-items-center rounded-xl border"><GitFork className="size-5" aria-hidden="true" /></div>
            <div className="min-w-0">
              <h1 className="text-[1.65rem] leading-none font-semibold tracking-tight sm:text-[1.9rem]">GitHub Issues</h1>
              <p className="mt-1 truncate text-xs text-muted-foreground">{account ? '@' + account.login + ' · 本机 GitHub CLI' : checking ? '正在检测 GitHub CLI…' : 'GitHub CLI 未连接'}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" variant="ghost" size="sm" disabled={checking || writing} onClick={() => void detect()}>
              <RefreshCw className={checking ? 'animate-spin' : undefined} />重新检测
            </Button>
            {account && <>
              <ChooseRepositories client={client} account={account} repositories={repositories} busy={writing} report={report} onSaved={saveRepositories} />
              <CreateIssue client={client} account={account} repositories={repositories} busy={writing} report={report}
                startWrite={startWrite} finishWrite={finishWrite} onCreated={(repo, issue) => {
                  feed.update(repo, issue)
                  activate({ repo, number: issue.number, knownIssue: issue, focusHeading: true })
                  toast.success('已创建 ' + repo + ' #' + issue.number)
                }} />
            </>}
          </div>
        </header>
        <div className="shrink-0"><QuotaBar quota={quota} busy={quotaBusy} canRefresh={Boolean(account)} onRefresh={() => void refreshQuota()} /></div>
        {error && <Alert variant="destructive" className="shrink-0"><CircleAlert /><AlertTitle>GitHub 请求失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        {!account ? (
          <Card className="min-h-0 flex-1 overflow-y-auto shadow-none">
            {checking ? <CardContent className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在检测本机 GitHub CLI</CardContent>
              : <Empty className="m-auto"><EmptyHeader><EmptyMedia variant="icon"><GitFork /></EmptyMedia><EmptyTitle>连接本机 GitHub CLI</EmptyTitle>
                <EmptyDescription>在终端运行 <code className="break-words font-mono">gh auth login --hostname github.com</code>，完成后点击「重新检测」。</EmptyDescription></EmptyHeader></Empty>}
          </Card>
        ) : (
          <div className="workspace min-h-0 flex-1" data-detail-open={Boolean(activeRepo)}>
            <Card className="workspace-list flex min-h-0 min-w-0 flex-col gap-0 overflow-hidden py-0 shadow-none" aria-label="Issue 列表">
              <CardHeader className="shrink-0 space-y-3 border-b px-3 py-3 sm:px-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 ref={listHeading} tabIndex={-1} className="flex items-center gap-2 text-sm font-semibold outline-none"><ListFilter className="size-4 text-muted-foreground" />Issues</h2>
                  <span className="text-xs text-muted-foreground tabular-nums" role="status">
                    {feed.busy && <LoaderCircle className="me-1.5 inline size-3 animate-spin" aria-label="正在加载" />}{items.length} / {feed.items.length} 条已加载
                  </span>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute inset-s-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
                  <Input type="search" aria-label="搜索已加载的标题或编号" placeholder="搜索已加载的标题或 #编号"
                    className="ps-9" value={search} onChange={event => setSearch(event.target.value)} />
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)] gap-2">
                  <Select value={repoFilter || 'all-repositories'} onValueChange={value => setRepoFilter(value === 'all-repositories' ? '' : value)}>
                    <SelectTrigger aria-label="仓库" className="w-full min-w-0"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="all-repositories">全部已选仓库</SelectItem>
                      {[...repositories].sort((a, b) => a.name.localeCompare(b.name)).map(repo => <SelectItem key={repo.name} value={repo.name.toLowerCase()}>{repo.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={state} onValueChange={value => setState(value as StateFilter)}>
                    <SelectTrigger aria-label="状态" className="w-full min-w-0"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="open">打开</SelectItem><SelectItem value="closed">已关闭</SelectItem><SelectItem value="all">所有状态</SelectItem></SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Input type="search" aria-label="标签" placeholder="标签" value={label} onChange={event => setLabel(event.target.value)} />
                  <Input type="search" aria-label="指派人" placeholder="指派人" value={assignee} onChange={event => setAssignee(event.target.value)} />
                </div>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-2 sm:p-3">
                {(feed.error || feed.errors.length > 0) && <Alert variant="destructive"><CircleAlert /><AlertTitle>部分 Issue 加载失败</AlertTitle>
                  <AlertDescription>{feed.error && <p>{feed.error}</p>}{feed.errors.map(([repo, message]) => <p key={repo} className="wrap-anywhere">{repo} · {message}</p>)}</AlertDescription></Alert>}
                {!items.length && (feed.busy && !feed.items.length
                  ? <div className="space-y-2 p-1" role="status" aria-label="正在加载 Issue">{[1, 2, 3, 4].map(row => <Skeleton key={row} className="h-[4.5rem] w-full" />)}</div>
                  : <Empty className="m-auto px-3 py-8"><EmptyHeader><EmptyMedia variant="icon"><Inbox /></EmptyMedia>
                    <EmptyTitle>{repositories.length ? '没有匹配的 Issue' : '选择要跟进的仓库'}</EmptyTitle>
                    <EmptyDescription>{repositories.length ? '可以调整筛选条件，或继续加载更多条目。' : '点击右上方「选择仓库」开始。'}</EmptyDescription>
                  </EmptyHeader></Empty>)}
                {items.length > 0 && <ul className="space-y-1">
                  {items.map(issue => {
                    const key = issueKey(issue.repo, issue.number)
                    return <li key={key}>
                      <Button id={'issue-row-' + key} type="button" variant="ghost" aria-current={activeKey === key ? 'true' : undefined}
                        className="issue-row h-auto w-full justify-start gap-2.5 px-2.5 py-2.5 text-start font-normal whitespace-normal"
                        aria-disabled={writing || undefined} onClick={event => openRow(issue.repo, issue.number, event.detail === 0)}>
                        <CircleDot className="issue-dot mt-0.5 self-start" aria-hidden="true" data-state={issue.state} />
                        <span className="grid min-w-0 flex-1 gap-1.5">
                          <span className="min-w-0 text-sm leading-snug font-medium wrap-anywhere">{issue.title || '无标题'}</span>
                          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <span className="break-all font-mono">{issue.repo} #{issue.number}</span>
                            <span className="hidden sm:inline">{formatTime(issue.updated)}</span>
                            {issue.comments > 0 && <span className="inline-flex items-center gap-1"><MessageSquare className="size-3" />{issue.comments} 条评论</span>}
                          </span>
                          {(issue.labels.length > 0 || issue.assignees.length > 0 || state === 'all') && <span className="flex min-w-0 flex-wrap gap-1">
                            {state === 'all' && <IssueStatus state={issue.state} />}
                            {issue.labels.map(tag => <Badge key={tag.name} variant="secondary" className="max-w-full font-normal"><span className="truncate">{tag.name}</span></Badge>)}
                            {issue.assignees.map(login => <Badge key={login} variant="outline" className="max-w-full font-normal"><span className="truncate">@{login}</span></Badge>)}
                          </span>}
                        </span>
                      </Button>
                    </li>
                  })}
                </ul>}
                {feed.hasNext && <Button type="button" variant="outline" className="shrink-0" aria-disabled={feed.busy || undefined} onClick={feed.loadMore}>
                  {feed.busy && <LoaderCircle className="animate-spin" />}{feed.errors.length || feed.error ? '加载更多 / 重试失败仓库' : '加载更多 Issues'}
                </Button>}
              </CardContent>
            </Card>
            <div className="workspace-detail min-h-0 min-w-0">
              {activeRepo && selection ? <IssueDetail key={account.id + ':' + activeKey} client={client} account={account}
                repo={activeRepo} number={selection.number} knownIssue={selection.knownIssue} focusHeading={selection.focusHeading}
                writing={writing} startWrite={startWrite} finishWrite={finishWrite} report={report} draft={draft} setDraft={updateDraft}
                onUpdated={issue => feed.update(activeRepo.name, issue)} onBack={backToList} />
                : <Card className="flex min-w-0 flex-1 items-center justify-center border-dashed bg-card/65 shadow-none">
                  <Empty><EmptyHeader><EmptyMedia variant="icon"><CircleDot /></EmptyMedia><EmptyTitle>选择一个 Issue</EmptyTitle>
                    <EmptyDescription>从列表打开 Issue，查看正文、评论和处理操作。</EmptyDescription></EmptyHeader></Empty>
                </Card>}
            </div>
          </div>
        )}
      </main>
      <Toaster theme={theme} position="bottom-right" />
    </TooltipProvider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
