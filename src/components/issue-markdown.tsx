import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function IssueMarkdown({ body, baseUrl }: { body: string; baseUrl: string }) {
  return <div className="issue-markdown text-sm leading-relaxed wrap-anywhere">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml
      urlTransform={(value, key) => {
        const safeValue = defaultUrlTransform(value)
        if (!safeValue) return undefined
        try {
          const url = new URL(safeValue, baseUrl)
          if (key === 'src') return url.protocol === 'https:' ? url.href : undefined
          if (['https:', 'http:', 'mailto:'].includes(url.protocol)) return url.href
        } catch {
          return undefined
        }
      }}
      components={{
        a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <>{children}</>,
        img: ({ src, alt, title }) => src ? <img src={src} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" /> : <>{alt}</>,
        table: ({ children }) => <div className="issue-markdown-table" role="region" aria-label="Markdown 表格" tabIndex={0}><table>{children}</table></div>,
      }}>{body}</Markdown>
  </div>
}
