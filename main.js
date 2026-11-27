'use strict';

const channel = new BroadcastChannel('cindy-github-issues/v1');
const pending = new Map();
const reads = new Set(['account', 'quota', 'repositories', 'labels', 'issues', 'issue', 'comments']);
const writes = new Set(['create', 'comment', 'state', 'addLabels', 'removeLabel', 'addAssignees', 'removeAssignees']);

async function handle(action, args) {
  if (action === 'state') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(args.repo) || !Number.isSafeInteger(args.number) || !['open', 'closed'].includes(args.state)) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Issue 参数无效。' };
    }
    const verb = args.state === 'closed' ? '关闭' : '重开';
    const decision = await cindy.confirm({ body: verb + ' ' + args.repo + ' #' + args.number + '？', confirmText: verb });
    if (!decision?.ok) return { ok: false, code: 'CONFIRM', message: '无法打开确认弹窗，请稍后再试。' };
    if (!decision.confirmed) return { ok: false, code: 'CANCELLED', message: '已取消。' };
  }
  try {
    const result = await cindy.node.request({ method: 'github', params: { action, args }, timeoutMs: 80000 });
    if (result.ok && typeof result.result?.ok === 'boolean') return result.result;
  } catch {
    // A bridge failure may occur after GitHub receives a write.
  }
  return writes.has(action)
    ? { ok: false, code: 'WRITE_UNCERTAIN', message: '无法确认 GitHub 是否已保存。请先核对结果，再决定是否重试。' }
    : { ok: false, code: 'BRIDGE', message: '无法启动 GitHub 后台，请重新检测。' };
}

channel.onmessage = event => {
  const { type, id, action, args } = event.data || {};
  if (type !== 'request' || typeof id !== 'string' || !/^[\da-f]{32}$/.test(id) || (!reads.has(action) && !writes.has(action)) || !args || typeof args !== 'object') return;
  channel.postMessage({ type: 'ack', id });
  if (!pending.has(id)) {
    if (pending.size >= 1024) {
      channel.postMessage({ type: 'result', id, result: { ok: false, code: 'BUSY', message: '请求太多，请稍后再试。' } });
      return;
    }
    const completion = handle(action, args).catch(() => ({ ok: false, code: 'BRIDGE', message: 'GitHub 操作失败，请刷新后再试。' }));
    pending.set(id, completion);
    void completion.finally(() => setTimeout(() => pending.delete(id), 30000));
  }
  void pending.get(id).then(result => channel.postMessage({ type: 'result', id, result }));
};
