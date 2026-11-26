import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Archive, FolderGit2, LoaderCircle, Plus, RefreshCw, Search, Star } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage, getDefaultRepository, saveRepositories, type Account, type FullIssue, type GitHubClient, type Reporter, type Repository, type RepositorySelection } from '@/github'

const roles = { admin: '管理员', maintain: '维护', push: '写入', triage: '分流', pull: '读取', unknown: '角色未知' }
let repoCache: { accountId: number; time: number; items: Repository[] } | undefined

type DialogProps = RepositorySelection & { client: GitHubClient; account: Account; busy: boolean; report: Reporter }

export function ChooseRepositories({ account, busy, onSaved, ...props }: DialogProps & { onSaved: (selection: RepositorySelection) => void }) {
  const [open, setOpen] = useState(false)
  const saving = useRef(false)
  return (
    <Dialog open={open} onOpenChange={value => { if (!saving.current) setOpen(value) }}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={busy}><FolderGit2 />选择仓库</Button>
      </DialogTrigger>
      {open && <RepositoryPicker {...props} account={account} saving={saving} onClose={() => setOpen(false)}
        onSaved={repos => { onSaved(repos); setOpen(false) }} />}
    </Dialog>
  )
}

function RepositoryPicker({ client, account, repositories, defaultRepository, report, saving, onSaved, onClose }: Omit<DialogProps, 'busy'> & {
  saving: { current: boolean }; onSaved: (selection: RepositorySelection) => void; onClose: () => void
}) {
  const cached = useRef(repoCache?.accountId === account.id && Date.now() - repoCache.time < 300000 ? repoCache : undefined).current
  const observed = useRef(new Map(cached?.items.map(repo => [repo.name.toLowerCase(), repo])))
  const nextPage = useRef(1)
  const generation = useRef(0)
  const loading = useRef(false)
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState(() => ({
    draft: new Map(repositories.map(repo => [repo.name.toLowerCase(), repo])),
    defaultKey: defaultRepository.toLowerCase(),
  }))
  const { draft, defaultKey } = selection
  const [found, setFound] = useState(cached?.items ?? [])
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>(cached ? 'done' : 'loading')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function list(refresh = false) {
    if (loading.current || saving.current) return
    if (refresh) {
      repoCache = undefined
      nextPage.current = 1
      observed.current.clear()
      setFound([])
    }
    const request = ++generation.current
    loading.current = true
    setStatus('loading')
    setError('')
    try {
      while (request === generation.current) {
        const page = await client.request('repositories', { accountId: account.id, page: nextPage.current })
        if (request !== generation.current) return
        for (const repo of page.items) observed.current.set(repo.name.toLowerCase(), repo)
        nextPage.current++
        const items = [...observed.current.values()]
        setFound(items)
        if (!page.hasNext) {
          repoCache = { accountId: account.id, time: Date.now(), items }
          setStatus('done')
          return
        }
      }
    } catch (cause) {
      if (request === generation.current && !report(cause)) {
        setError(errorMessage(cause))
        setStatus('error')
      }
    } finally {
      if (request === generation.current) loading.current = false
    }
  }

  useEffect(() => {
    if (!cached) void list()
    return () => { generation.current++ }
    // The dialog mounts with a fixed account and its initial cache snapshot.
  }, [])

  const groups = useMemo(() => {
    const combined = new Map(repositories.map(repo => [repo.name.toLowerCase(), repo]))
    for (const repo of found) combined.set(repo.name.toLowerCase(), repo)
    const batches = new Map<string, Repository[]>()
    for (const repo of [...combined.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!repo.name.toLowerCase().includes(query.trim().toLowerCase())) continue
      const title = (repo.organization ? '组织' : '个人') + ' · ' + repo.owner
      const batch = batches.get(title) ?? []
      batch.push(repo)
      batches.set(title, batch)
    }
    return [...batches.entries()]
  }, [found, query, repositories])

  function toggle(repo: Repository, checked: boolean) {
    setSelection(current => {
      const updated = new Map(current.draft)
      const key = repo.name.toLowerCase()
      if (checked) updated.set(key, repo)
      else updated.delete(key)
      return { draft: updated, defaultKey: updated.has(current.defaultKey) ? current.defaultKey : (updated.keys().next().value ?? '') }
    })
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving.current) return
    saving.current = true
    setSubmitting(true)
    setError('')
    try {
      const repos = [...draft].map(([key, value]) => observed.current.get(key) ?? value)
      const next = { repositories: repos, defaultRepository: getDefaultRepository(repos, defaultKey) }
      await saveRepositories(client, account, next)
      onSaved(next)
    } catch (cause) {
      if (!report(cause)) setError(errorMessage(cause))
    } finally {
      saving.current = false
      setSubmitting(false)
    }
  }

  return (
    <DialogContent className="flex h-[640px] max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-xl" showCloseButton={!submitting}
      onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus() }}>
      <DialogHeader className="shrink-0">
        <DialogTitle>选择仓库</DialogTitle>
        <DialogDescription>勾选要跟进的仓库，并指定工作台打开时显示的默认仓库。</DialogDescription>
      </DialogHeader>
      <form className="flex min-h-0 flex-1 flex-col gap-3" onSubmit={save}>
        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute inset-s-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <Input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)}
            aria-label="搜索仓库" placeholder="搜索 owner/repo" className="ps-9" />
        </div>
        <div className="flex h-8 shrink-0 items-center justify-between gap-2" role="status">
          <span className="text-xs text-muted-foreground">{status === 'loading' ? '正在加载仓库 · ' : ''}已读取 {found.length} 个仓库</span>
          {status !== 'loading' && <Button type="button" size="sm" variant="ghost" disabled={submitting}
            onClick={() => void list(status === 'done')}><RefreshCw />{status === 'done' ? '刷新列表' : '继续加载'}</Button>}
        </div>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-lg border" aria-busy={status === 'loading'}>
          {groups.map(([group, repos]) => (
            <fieldset key={group} className="m-2 rounded-md border border-transparent">
              <legend className="px-2 text-xs font-medium text-muted-foreground">{group}</legend>
              {repos.map(repo => {
                const key = repo.name.toLowerCase()
                const checked = draft.has(key)
                const available = observed.current.has(key)
                return (
                  <div key={key} className="flex items-center gap-2 rounded-md px-2 hover:bg-accent/60">
                    <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5">
                      <Checkbox checked={checked} disabled={submitting || (!checked && (!repo.issues || !available))}
                        onCheckedChange={value => toggle(repo, value === true)} aria-label={repo.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm" title={repo.name}>{repo.name}</span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {roles[repo.role]} · {repo.private ? '私有' : '公开'}{repo.issues ? '' : ' · Issues 已关闭'}
                          {!available && status === 'done' ? ' · 当前账号不可访问' : ''}
                        </span>
                      </span>
                      {repo.archived && <Badge variant="outline" className="shrink-0"><Archive />只读</Badge>}
                    </Label>
                    {checked && <Button type="button" size="xs" variant={defaultKey === key ? 'secondary' : 'ghost'} className="shrink-0"
                      disabled={submitting} aria-pressed={defaultKey === key} aria-label={'设为默认仓库 ' + repo.name}
                      onClick={() => setSelection(current => current.defaultKey === key ? current : { ...current, defaultKey: key })}>
                      {defaultKey === key ? <><Star />默认</> : '设为默认'}
                    </Button>}
                  </div>
                )
              })}
            </fieldset>
          ))}
          {!groups.length && (status === 'loading'
            ? <div className="space-y-3 p-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div>
            : <Empty className="p-5"><EmptyHeader><EmptyMedia variant="icon"><FolderGit2 /></EmptyMedia>
              <EmptyTitle>没有匹配的仓库</EmptyTitle><EmptyDescription>可以换一个关键词或刷新列表。</EmptyDescription></EmptyHeader></Empty>)}
        </div>
        <DialogFooter className="flex shrink-0 flex-row flex-wrap items-center gap-2 sm:justify-between">
          <Badge variant="secondary" role="status">已选 {draft.size} 个仓库</Badge>
          <div className="ms-auto flex gap-2">
            <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={submitting}>{submitting && <LoaderCircle className="animate-spin" />}保存选择</Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

export function CreateIssue({ client, account, repositories, defaultRepository, busy, report, onCreated, startWrite, finishWrite }: DialogProps & {
  onCreated: (repo: string, issue: FullIssue) => void; startWrite: () => boolean; finishWrite: () => void
}) {
  const eligible = repositories.filter(repo => repo.issues && !repo.archived).sort((a, b) => a.name.localeCompare(b.name))
  const [open, setOpen] = useState(false)
  const [repo, setRepo] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const titleEntry = useRef<HTMLInputElement>(null)

  function toggle(value: boolean) {
    if (saving) return
    if (value) {
      setRepo(getDefaultRepository(eligible, defaultRepository))
      setTitle('')
      setBody('')
      setError('')
    }
    setOpen(value)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!repo || !title.trim() || !startWrite()) return
    setSaving(true)
    setError('')
    try {
      const saved = await client.request('create', { repo, accountId: account.id, title: title.trim(), body })
      setOpen(false)
      onCreated(repo, saved)
    } catch (cause) {
      if (!report(cause)) setError(errorMessage(cause))
    } finally {
      setSaving(false)
      finishWrite()
    }
  }

  return (
    <Dialog open={open} onOpenChange={toggle}>
      <DialogTrigger asChild><Button type="button" disabled={busy || !eligible.length}><Plus />新建 Issue</Button></DialogTrigger>
      <DialogContent showCloseButton={!saving} onOpenAutoFocus={event => { event.preventDefault(); titleEntry.current?.focus() }}>
        <DialogHeader><DialogTitle>新建 Issue</DialogTitle><DialogDescription>Issue 会直接创建到所选 GitHub 仓库。</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="new-repo">目标仓库</Label>
            <Select value={repo} onValueChange={setRepo} disabled={saving}>
              <SelectTrigger id="new-repo" className="w-full min-w-0"><SelectValue placeholder="选择仓库" /></SelectTrigger>
              <SelectContent>{eligible.map(item => <SelectItem key={item.name} value={item.name}>{item.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2"><Label htmlFor="new-title">标题</Label>
            <Input id="new-title" ref={titleEntry} maxLength={256} required value={title} disabled={saving} onChange={event => setTitle(event.target.value)} />
          </div>
          <div className="grid gap-2"><Label htmlFor="new-body">正文<span className="text-muted-foreground">（可选）</span></Label>
            <Textarea id="new-body" rows={5} maxLength={50000} value={body} disabled={saving} onChange={event => setBody(event.target.value)} />
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => toggle(false)}>取消</Button>
            <Button type="submit" disabled={saving || !title.trim() || !repo}>{saving && <LoaderCircle className="animate-spin" />}创建 Issue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
