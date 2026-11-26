import { createRoot } from 'react-dom/client'
import { Terminal } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useCindyTheme } from '@/theme'
import '@fontsource-variable/geist'
import './index.css'

function Settings() {
  useCindyTheme()
  return <main className="mx-auto max-w-2xl p-4 sm:p-6">
    <Card className="shadow-none">
      <CardHeader><CardTitle className="flex items-center gap-2"><Terminal className="size-4" />GitHub CLI</CardTitle>
        <CardDescription>工作台使用本机 GitHub CLI 的当前账号。</CardDescription></CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>登录账号 <code className="block rounded-md bg-muted px-3 py-2 font-mono wrap-anywhere">gh auth login --hostname github.com</code></p>
        <p>查看状态 <code className="block rounded-md bg-muted px-3 py-2 font-mono wrap-anywhere">gh auth status --hostname github.com</code></p>
      </CardContent>
    </Card>
  </main>
}

createRoot(document.getElementById('root')!).render(<Settings />)
