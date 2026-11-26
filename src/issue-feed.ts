import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, hasErrorCode, type GitHubClient, type Issue, type Reporter, type Repository, type StateFilter } from '@/github'

export type IssueRow = Issue & { repo: string }
type RepoPage = {
  repo: string
  items: Map<number, Issue>
  next: number
  hasNext: boolean
  error: string
  pendingEdits?: Map<number, Issue>
}
type Feed = { pages: Map<string, RepoPage>; busy: boolean; error: string }

function applyIssue(items: Map<number, Issue>, issue: Issue, state: StateFilter) {
  if (state === 'all' || state === issue.state) items.set(issue.number, issue)
  else items.delete(issue.number)
}

export function useIssueFeed(client: GitHubClient, accountId: number | null, repositories: Repository[], repoFilter: string, state: StateFilter, report: Reporter) {
  const current = useRef<Feed | null>(null)
  const [view, setView] = useState({ items: [] as IssueRow[], errors: [] as [string, string][], hasNext: false, busy: false, error: '' })

  const publish = useCallback((feed: Feed) => {
    if (feed !== current.current) return
    const pages = [...feed.pages.values()]
    const items = pages.flatMap(page => [...page.items.values()].map(issue => ({ ...issue, repo: page.repo })))
    items.sort((a, b) => b.updated.localeCompare(a.updated) || a.repo.localeCompare(b.repo) || b.number - a.number)
    setView({ items, errors: pages.filter(page => page.error).map(page => [page.repo, page.error]),
      hasNext: pages.some(page => page.hasNext), busy: feed.busy, error: feed.error })
  }, [])

  const load = useCallback(async (feed: Feed) => {
    if (accountId === null || feed.busy) return
    const pages = [...feed.pages.values()].filter(page => page.hasNext)
    if (!pages.length) return
    feed.busy = true
    feed.error = ''
    publish(feed)
    try {
      await client.assertAccount(accountId)
      let nextPage = 0
      async function readNext() {
        while (feed === current.current && nextPage < pages.length) {
          const page = pages[nextPage++]
          const pendingEdits = new Map<number, Issue>()
          page.pendingEdits = pendingEdits
          try {
            const result = await client.request('issues', { repo: page.repo, page: page.next, state })
            if (feed !== current.current) return
            for (const issue of result.items) page.items.set(issue.number, issue)
            for (const issue of pendingEdits.values()) applyIssue(page.items, issue, state)
            // GitHub may have moved an edited issue between pages while this page was in flight.
            page.next = pendingEdits.size ? 1 : page.next + 1
            page.hasNext = pendingEdits.size > 0 || result.hasNext
            page.error = ''
          } catch (error) {
            if (feed !== current.current) return
            page.error = errorMessage(error)
            if (hasErrorCode(error, 'RATE_LIMIT')) nextPage = pages.length
          } finally {
            page.pendingEdits = undefined
            publish(feed)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(2, pages.length) }, readNext))
      if (feed === current.current && client.retryAt() <= Date.now()) await client.assertAccount(accountId)
    } catch (error) {
      if (feed === current.current && !report(error)) feed.error = errorMessage(error)
    } finally {
      feed.busy = false
      publish(feed)
    }
  }, [accountId, client, publish, report, state])

  useEffect(() => {
    const feed: Feed = { pages: new Map(), busy: false, error: '' }
    for (const repo of repositories) {
      const key = repo.name.toLowerCase()
      if (!repoFilter || repoFilter === key) feed.pages.set(key, { repo: repo.name, items: new Map(), next: 1, hasNext: true, error: '' })
    }
    current.current = feed
    publish(feed)
    void load(feed)
    return () => { current.current = null }
  }, [load, publish, repoFilter, repositories])

  return {
    ...view,
    loadMore: () => { if (current.current) void load(current.current) },
    update(repo: string, issue: Issue) {
      const feed = current.current
      const page = feed?.pages.get(repo.toLowerCase())
      if (!feed || !page) return
      applyIssue(page.items, issue, state)
      page.pendingEdits?.set(issue.number, issue)
      publish(feed)
    },
  }
}

export function filterIssues(rows: IssueRow[], title: string, label: string, assignee: string) {
  const query = title.trim().toLowerCase()
  const tag = label.trim().toLowerCase()
  const login = assignee.trim().toLowerCase().replace(/^@/, '')
  return rows.filter(issue => (!query || issue.title.toLowerCase().includes(query) || String(issue.number) === query.replace(/^#/, ''))
    && (!tag || issue.labels.some(item => item.name.toLowerCase().includes(tag)))
    && (!login || issue.assignees.some(name => name.toLowerCase().includes(login))))
}
