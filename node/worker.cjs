'use strict';

const { createInterface } = require('node:readline');
const { createApi, createService, GitHubError } = require('./github.cjs');

const api = createApi();
const dispatch = createService(api);
const ACTIONS = new Set(['account', 'quota', 'repositories', 'issues', 'issue', 'comments', 'create',
  'comment', 'state', 'addLabels', 'removeLabel', 'addAssignees', 'removeAssignees']);

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { ...result, quota: api.quotaSnapshot() } }) + '\n');
}

createInterface({ input: process.stdin }).on('line', async line => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n');
    return;
  }
  if (!request || !Object.hasOwn(request, 'id')) return;
  if (request.method !== 'github' || !ACTIONS.has(request.params?.action)) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32601, message: 'Method not found' } }) + '\n');
    return;
  }
  try {
    reply(request.id, { ok: true, data: await dispatch(request.params.action, request.params.args) });
  } catch (error) {
    reply(request.id, error instanceof GitHubError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'INTERNAL', message: 'GitHub 操作失败，请刷新后再试。' });
  }
});
