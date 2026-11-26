const channel = new BroadcastChannel('cindy-github-issues/v1')

channel.onmessage = async ({ data }) => {
  if (data?.type !== 'request' || typeof data.id !== 'string') return
  const { id, action, args } = data
  channel.postMessage({ type: 'ack', id })
  let result: unknown
  try {
    const response = await fetch('/__cindy_preview/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action, args }),
    })
    if (!response.ok) throw new Error('Preview request failed')
    result = await response.json()
  } catch {
    result = { ok: false, code: 'BRIDGE', message: '模拟预览请求失败，请刷新页面。' }
  }
  channel.postMessage({ type: 'result', id, result })
}

import.meta.hot?.dispose(() => channel.close())
