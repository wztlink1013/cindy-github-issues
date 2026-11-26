import { useEffect, useState } from 'react'

export function useCindyTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => readTheme())
  useEffect(() => {
    const root = document.documentElement
    const media = matchMedia('(prefers-color-scheme: dark)')
    function synchronize() {
      const value = readTheme()
      root.classList.toggle('dark', value === 'dark')
      setTheme(value)
    }
    synchronize()
    const observer = new MutationObserver(synchronize)
    observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true })
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'data-theme'] })
    media.addEventListener('change', synchronize)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', synchronize)
    }
  }, [])
  return theme
}

function readTheme() {
  const scheme = getComputedStyle(document.documentElement).colorScheme
  if (scheme === 'dark' || scheme === 'light') return scheme
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
