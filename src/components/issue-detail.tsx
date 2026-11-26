import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, CircleCheck, CircleDot, ExternalLink, LoaderCircle, MessageSquare, RefreshCw, X } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage, formatTime, hasErrorCode, issueUrl, type Account, type FullIssue, type GitHubClient, type IssueComment, type IssueMutation, type IssueState, type Reporter, type Repository } from '@/github'

export function IssueStatus({ state }: { state: IssueState }) {
  return state === 'open'
    ? <Badge className="issue-status-open" variant="secondary"><CircleDot />打开</Badge>
    : <Badge className="issue-status-closed" variant="secondary"><CircleCheck />已关闭</Badge>
}

function MetadataEditor({ label, entries, placeholder, disabled, add, remove }: {
  label: string; entries: string[]; placeholder: string; disabled: boolean
  add: (value: string) => Promise<boolean>; remove: (value: string) => void
}) {
  const id = useId()
  const [value, setValue] = useState('')
  return (
    <form className="grid min-w-0 content-start gap-2.5" onSubmit={event => {
      event.preventDefault()
      const input = value.trim()
      if (input) void add(input).then(saved => { if (saved) setValue(current => current === value ? '' : current) })
    }}>
      <Label htmlFor={id}>{label}</Label>
      {entries.length > 0 && <div className="flex flex-wrap gap-1.5">
        {entries.map(entry => <Button key={entry} variant="secondary" size="xs" type="button" className="max-w-full"
          aria-label={'移除' + label + ' ' + entry} disabled={disabled} onClick={() => remove(entry)}>
          <span className="truncate">{entry}</span><X />
        </Button>)}
      </div>}
      <div className="flex gap-2">
        <Input id={id} className="min-w-0" value={value} onChange={event => setValue(event.target.value)}
          disabled={disabled} placeholder={placeholder} maxLength={100} />
        <Button type="submit" variant="outline" disabled={disabled || !value.trim()}>添加</Button>
      </div>
    </form>
  )
}

type DetailProps = {
  client: GitHubClient; account: Account; repo: Repository; number: number; knownIssue?: FullIssue;
  writing: boolean; startWrite: () => boolean; finishWrite: () => void; report: Reporter;
  onUpdated: (issue: FullIssue) => void; onBack: () => void; draft: string; setDraft: (body: string) => void;
  focusHeading: boolean;
}

export function IssueDetail({ client, account, repo, number, knownIssue, writing, startWrite, finishWrite,
  report, onUpdated, onBack, draft, setDraft, focusHeading }: DetailProps) {
  const target = { repo: repo.name, number, accountId: account.id }
  const [issue, setIssue] = useState<FullIssue | undefined>(knownIssue)
  const [loading, setLoading] = useState(!knownIssue)
  const [comments, setComments] = useState<IssueComment[]>([])
  const [commentBusy, setCommentBusy] = useState(false)
  const [moreComments, setMoreComments] = useState(true)
  const [commentError, setCommentError] = useState<{ message: string; reload: boolean } | null>(null)
  const [detailError, setDetailError] = useState('')
  const [writeError, setWriteError] = useState('')
  const [writeStatus, setWriteStatus] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)
  const mounted = useRef(true)
  const nextCommentPage = useRef(1)
  const readingComments = useRef(false)
  const commentGeneration = useRef(0)
  const postedComments = useRef(new Map<number, IssueComment>())
  const heading = useRef<HTMLHeadingElement>(null)
  const loadGeneration = useRef(0)
  const latestIssue = useRef(issue)

  function publishIssue(value: FullIssue) {
    latestIssue.current = value
    setIssue(value)
  }

  async function readComments(reload = false) {
    if (!reload && (readingComments.current || !moreComments)) return
    const generation = ++commentGeneration.current
    const page = reload ? 1 : nextCommentPage.current
    readingComments.current = true
    setCommentBusy(true)
    setCommentError(null)
    try {
      const result = await client.request('comments', { ...target, page })
      if (!mounted.current || generation !== commentGeneration.current) return
      setComments(existing => {
        const merged = new Map(reload ? postedComments.current : existing.map(comment => [comment.id, comment]))
        for (const comment of result.items) merged.set(comment.id, comment)
        return [...merged.values()].sort((a, b) => a.id - b.id)
      })
      nextCommentPage.current = page + 1
      setMoreComments(result.hasNext)
    } catch (cause) {
      if (mounted.current && generation === commentGeneration.current && !report(cause)) setCommentError({ message: errorMessage(cause), reload })
    } finally {
      if (generation === commentGeneration.current) {
        readingComments.current = false
        if (mounted.current) setCommentBusy(false)
      }
    }
  }

  async function refresh() {
    const generation = ++loadGeneration.current
    setLoading(true)
    setDetailError('')
    try {
      await client.assertAccount(account.id)
      const result = await client.request('issue', { repo: repo.name, number })
      await client.assertAccount(account.id)
      if (generation !== loadGeneration.current || !mounted.current) return
      publishIssue(result)
      if (result.comments) void readComments(true)
      else {
        commentGeneration.current++
        nextCommentPage.current = 1
        readingComments.current = false
        setCommentBusy(false)
        setCommentError(null)
        setComments([])
        setMoreComments(true)
      }
    } catch (cause) {
      if (generation === loadGeneration.current && mounted.current && !report(cause)) setDetailError(errorMessage(cause))
    } finally {
      if (generation === loadGeneration.current && mounted.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    if (focusHeading) heading.current?.focus({ preventScroll: true })
    if (!knownIssue) void refresh()
    else if (knownIssue.comments) void readComments()
    return () => { mounted.current = false; loadGeneration.current++ }
    // Each mounted detail belongs to one account and one issue.
  }, [])

  async function edit(mutation: IssueMutation) {
    if (!latestIssue.current || !startWrite()) return false
    setWriteError('')
    setWriteStatus('')
    const isComment = mutation.action === 'comment'
    if (isComment) setSubmittingComment(true)
    // Do not let a refresh started before this write replace the newer response.
    loadGeneration.current++
    setLoading(false)
    try {
      let saved: FullIssue
      if (mutation.action === 'comment') {
        const comment = await client.request('comment', { ...target, ...mutation.args })
        if (!mounted.current) return true
        const prior = latestIssue.current
        if (!prior) return true
        saved = { ...prior, comments: prior.comments + 1 }
        setDraft('')
        if (comment.id) {
          postedComments.current.set(comment.id, comment)
          setComments(existing => existing.some(item => item.id === comment.id) ? existing : [...existing, comment])
        }
        setWriteStatus(comment.id ? '评论已发布。' : '评论已发布，可刷新详情查看。')
      } else {
        saved = await client.edit(target, mutation)
        if (!mounted.current) return true
        setWriteStatus(saved.warning || '已保存到 GitHub。')
      }
      publishIssue(saved)
      onUpdated(saved)
      return true
    } catch (cause) {
      if (mounted.current && !report(cause) && !hasErrorCode(cause, 'CANCELLED')) setWriteError(errorMessage(cause))
      return false
    } finally {
      if (mounted.current) setSubmittingComment(false)
      finishWrite()
    }
  }

  function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (draft.trim()) void edit({ action: 'comment', args: { body: draft } })
  }

  const readOnly = repo.archived || !repo.issues
  const canTriage = !readOnly && ['admin', 'maintain', 'push', 'triage', 'unknown'].includes(repo.role)
  const own = issue?.author.toLowerCase() === account.login.toLowerCase()
  return (
    <Card className="flex min-h-0 min-w-0 flex-1 flex-col gap-0 overflow-hidden py-0 shadow-none" aria-label="Issue 详情">
      <CardHeader className="issue-detail-header shrink-0 space-y-2 border-b px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" className="workspace-back -ms-2" disabled={writing} onClick={onBack}><ArrowLeft />返回列表</Button>
          <span className="break-all font-mono text-xs text-muted-foreground">{repo.name} #{number}</span>
          {issue && <IssueStatus state={issue.state} />}
        </div>
        <h2 ref={heading} tabIndex={-1} className="scroll-mt-4 text-xl leading-snug font-semibold tracking-tight break-words outline-none">
          {issue ? issue.title || '无标题' : 'Issue #' + number}
        </h2>
        {issue && <p className="text-xs text-muted-foreground">@{issue.author} · 更新于 {formatTime(issue.updated)}</p>}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm"><a href={issueUrl(repo.name, number)} target="_blank" rel="noreferrer"><ExternalLink />在 GitHub 打开</a></Button>
          <Button type="button" variant="ghost" size="sm" disabled={loading || writing} onClick={() => void refresh()}>
            <RefreshCw className={loading ? 'animate-spin' : undefined} />刷新详情
          </Button>
          {issue && (canTriage || (!readOnly && own)) && <Button type="button" variant="outline" size="sm" disabled={writing}
            onClick={() => void edit({ action: 'state', args: { state: issue.state === 'open' ? 'closed' : 'open' } })}>
            {issue.state === 'open' ? <CircleCheck /> : <CircleDot />}{issue.state === 'open' ? '关闭 Issue' : '重开 Issue'}
          </Button>}
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
        {detailError && <Alert variant="destructive"><AlertDescription>{detailError}</AlertDescription></Alert>}
        {loading && !issue && <div className="space-y-3" role="status" aria-label="正在加载详情">
          <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-2/3" />
        </div>}
        {issue && <>
          {readOnly && <p className="text-sm text-muted-foreground">此仓库当前仅可查看。</p>}
          {writeError && <Alert variant="destructive"><AlertDescription>{writeError}</AlertDescription></Alert>}
          {writeStatus && <p role="status" className="text-sm text-muted-foreground">{writeStatus}</p>}
          {issue.body && <p className="text-sm leading-7 whitespace-pre-wrap wrap-anywhere">{issue.body}</p>}
          <Separator />
          {canTriage ? <div className="grid gap-4 xl:grid-cols-2">
            <MetadataEditor label="标签" entries={issue.labels.map(item => item.name)} placeholder="输入仓库标签名" disabled={writing}
              add={name => edit({ action: 'addLabels', args: { values: [name] } })}
              remove={name => void edit({ action: 'removeLabel', args: { value: name } })} />
            <MetadataEditor label="指派人" entries={issue.assignees} placeholder="输入 GitHub 用户名" disabled={writing}
              add={name => edit({ action: 'addAssignees', args: { values: [name.replace(/^@/, '')] } })}
              remove={name => void edit({ action: 'removeAssignees', args: { values: [name] } })} />
          </div> : <p className="text-sm text-muted-foreground wrap-anywhere">标签 · {issue.labels.map(item => item.name).join('、') || '无'}　指派 · {issue.assignees.join('、') || '无'}</p>}
          <Separator />
          <section className="space-y-3" aria-label="评论">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><MessageSquare className="size-4 text-muted-foreground" />评论 <Badge variant="outline">{issue.comments}</Badge></h3>
            {comments.map(comment => <Card key={comment.id} className="gap-0 rounded-lg py-0 shadow-none">
              <CardContent className="space-y-1 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">@{comment.author} · {formatTime(comment.created)}</p>
                <p className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{comment.body}</p>
              </CardContent>
            </Card>)}
            {commentBusy && <Skeleton className="h-12 w-full" role="status" aria-label="正在加载评论" />}
            {commentError && <Alert variant="destructive"><AlertDescription>{commentError.message}</AlertDescription></Alert>}
            {(commentError || (Boolean(issue.comments) && moreComments)) && <Button type="button" size="sm" variant="outline" disabled={commentBusy}
              onClick={() => void readComments(commentError?.reload)}>{commentError ? '重试评论' : '加载更多评论'}</Button>}
          </section>
          {(!readOnly && (!issue.locked || canTriage)) && <form className="space-y-2.5" onSubmit={submitComment}>
            <Label htmlFor="issue-comment">发表评论</Label>
            <Textarea id="issue-comment" placeholder="写一条评论…" rows={3} maxLength={50000} value={draft}
              readOnly={submittingComment} onChange={event => setDraft(event.target.value)} />
            <Button type="submit" disabled={writing || !draft.trim()}>
              {submittingComment && <LoaderCircle className="animate-spin" />}发表评论
            </Button>
          </form>}
        </>}
      </CardContent>
    </Card>
  )
}
