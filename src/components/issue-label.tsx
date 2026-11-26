import type { CSSProperties } from 'react'
import { Badge } from '@/components/ui/badge'
import type { IssueLabel } from '@/github'

const fallbackColors = ['9acde9', 'c3b5eb', '9cd8b4', 'edbf91', 'e9abc0', 'd8cd8b']

export function issueLabelStyle({ name, color }: IssueLabel) {
  let hash = 0
  for (const letter of name.toLowerCase()) hash = (Math.imul(hash, 31) + letter.codePointAt(0)!) >>> 0
  const hex = color && /^[0-9a-f]{6}$/i.test(color) ? color : fallbackColors[hash % fallbackColors.length]
  return { '--issue-label-color': '#' + hex } as CSSProperties
}

export function IssueLabelDot() {
  return <span aria-hidden="true" className="issue-label-dot" />
}

export function IssueLabelBadge({ label }: { label: IssueLabel }) {
  return <Badge variant="outline" style={issueLabelStyle(label)} className="issue-label max-w-full font-normal">
    <IssueLabelDot />
    <span className="truncate">{label.name}</span>
  </Badge>
}
