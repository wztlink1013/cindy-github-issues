import { useEffect, useRef, useState } from 'react'
import { errorMessage, type GitHubClient, type IssueLabel, type Reporter, type Repository } from '@/github'

const cacheDuration = 5 * 60 * 1000
type Catalog = {
  items: Map<string, IssueLabel>
  incoming?: Map<string, IssueLabel>
  next: number
  expiresAt: number
  pending?: Promise<void>
}

export function useRepositoryLabels(client: GitHubClient, accountId: number | null, repositories: Repository[], open: boolean, report: Reporter) {
  const cache = useRef(new Map<string, Catalog>())
  const [attempt, setAttempt] = useState(0)
  const [, setCatalogVersion] = useState(0)
  const [status, setStatus] = useState<{ scope: Repository[]; accountId: number; busy: boolean; error: string }>()

  useEffect(() => {
    if (accountId === null) { cache.current.clear(); return }
    if (!open || !repositories.length) return
    const expectedAccount = accountId
    let active = true
    let cursor = 0
    let error = ''
    setStatus({ scope: repositories, accountId, busy: true, error: '' })

    async function readRepositories() {
      while (active && cursor < repositories.length) {
        const repo = repositories[cursor++].name
        const key = expectedAccount + ':' + repo.toLowerCase()
        let catalog = cache.current.get(key)
        if (!catalog) {
          catalog = { items: new Map(), next: 1, expiresAt: 0 }
          cache.current.set(key, catalog)
        }
        if (catalog.expiresAt > Date.now()) continue
        const entry = catalog
        // Keep cached options visible during refresh and remove deleted labels only after the last page.
        entry.incoming ??= new Map()
        try {
          while (active && entry.incoming) {
            const incoming = entry.incoming
            entry.pending ??= client.request('labels', { repo, accountId: expectedAccount, page: entry.next }).then(result => {
              for (const item of result.items) {
                const name = item.name.toLowerCase()
                incoming.set(name, item)
                entry.items.set(name, item)
              }
              if (result.hasNext) entry.next++
              else {
                entry.items = incoming
                entry.incoming = undefined
                entry.next = 1
                entry.expiresAt = Date.now() + cacheDuration
              }
              setCatalogVersion(count => count + 1)
            }).finally(() => { entry.pending = undefined })
            await entry.pending
          }
        } catch (cause) {
          if (!active) return
          if (report(cause)) return
          error ||= errorMessage(cause)
        }
      }
    }

    void Promise.all(Array.from({ length: Math.min(2, repositories.length) }, readRepositories)).then(() => {
      if (active) setStatus({ scope: repositories, accountId, busy: false, error })
    })
    return () => { active = false }
  }, [accountId, attempt, client, open, report, repositories])

  const byName = new Map<string, IssueLabel>()
  for (const repo of repositories) {
    const entry = cache.current.get(accountId + ':' + repo.name.toLowerCase())
    if (!entry) continue
    for (const [name, item] of entry.items) if (!byName.has(name)) byName.set(name, item)
  }
  const current = status?.scope === repositories && status.accountId === accountId ? status : undefined
  return {
    items: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    error: current?.error ?? '',
    busy: Boolean(open && repositories.length && (current?.busy ?? true)),
    retry: () => setAttempt(count => count + 1),
    observe(repo: string, labels: IssueLabel[]) {
      const entry = cache.current.get(accountId + ':' + repo.toLowerCase())
      if (!entry) return
      for (const item of labels) {
        const name = item.name.toLowerCase()
        entry.items.set(name, item)
        entry.incoming?.set(name, item)
      }
      setCatalogVersion(count => count + 1)
    },
  }
}
