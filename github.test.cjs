'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApi, createService, decodeResponse, GitHubError } = require('./node/github.cjs');

const repo = 'octo/demo';
const args = { accountId: 42, repo, number: 3 };
const apiIssue = { number: 3, title: 'A title', body: '<img src=x onerror=alert(1)>', state: 'open', user: { login: 'octo' }, labels: [{ name: 'keep' }], assignees: [{ login: 'octo' }] };
const wrap = (data, next = false) => ({ data, headers: new Map(next ? [['link', '<https://api.github.com/example?page=2>; rel="next"']] : []) });

function fixture(respond) {
  const requests = [];
  let id = 42;
  const service = createService(async (path, method = 'GET', body) => {
    requests.push({ path, method, body });
    if (path === '/user') return wrap({ id, login: id === 42 ? 'octo' : 'other' });
    return respond(path, method, body);
  });
  return { service, requests, switchAccount: () => { id = 99; } };
}

test('repository pagination includes organization and individual repositories and exposes roles', async () => {
  const { service, requests } = fixture(() => wrap([
    { full_name: repo, owner: { type: 'User' }, has_issues: true, permissions: { admin: true } },
    { full_name: 'org/archives', owner: { type: 'Organization' }, has_issues: true, archived: true, private: true, permissions: { triage: true } },
    { full_name: 'org/no-issues', owner: { type: 'Organization' }, has_issues: false },
    { full_name: 'unsafe/../path' },
  ], true));
  const list = await service('repositories', { accountId: 42, page: 2 });
  assert.deepEqual(list.items.map(({ name, role, archived, issues, organization }) => [name, role, archived, issues, organization]),
    [[repo, 'admin', false, true, false], ['org/archives', 'triage', true, true, true], ['org/no-issues', 'unknown', false, false, true]]);
  assert.equal(list.hasNext, true);
  assert.equal(new URL(requests[1].path, 'https://api.github.com').searchParams.get('affiliation'), 'owner,collaborator,organization_member');
  assert.match(requests[1].path, /page=2/);
  assert.match(requests[1].path, /per_page=100/);
});

test('issue list drops pull requests and keeps pagination even for a PR-only page', async () => {
  const { service } = fixture(() => wrap([{ ...apiIssue, pull_request: {} }], true));
  assert.deepEqual(await service('issues', { repo, page: 1, state: 'open' }), { items: [], hasNext: true });
});

test('a failure for one repository leaves other repositories usable', async () => {
  const { service } = fixture(path => {
    if (path.startsWith('/repos/blocked/')) throw new GitHubError('FORBIDDEN', 'Blocked');
    return wrap([apiIssue]);
  });
  const input = { page: 1, state: 'open' };
  const [blocked, open] = await Promise.allSettled([service('issues', { ...input, repo: 'blocked/demo' }), service('issues', { ...input, repo })]);
  assert.equal(blocked.reason.code, 'FORBIDDEN');
  assert.equal(open.value.items[0].number, 3);
});

test('a switched account blocks writes before any repository request', async () => {
  const { service, requests, switchAccount } = fixture(() => assert.fail('unexpected repository request'));
  switchAccount();
  await assert.rejects(service('create', { ...args, title: 'Test', body: '' }), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(service('repositories', { accountId: 42, page: 1 }), { code: 'ACCOUNT_CHANGED' });
  assert.deepEqual(requests.map(r => r.path), ['/user', '/user']);
});

test('create, comment, and state changes use explicit narrow payloads and do not alter PRs', async () => {
  const { service, requests } = fixture((path, method, body) => {
    if (method === 'GET') return wrap(path.endsWith('/7') ? { ...apiIssue, pull_request: {} } : apiIssue);
    if (path.endsWith('/comments')) return wrap({ id: 8 });
    return wrap({ ...apiIssue, ...body });
  });
  await service('create', { ...args, title: ' New ', body: 'Test' });
  await service('comment', { ...args, body: 'Test' });
  await service('state', { ...args, state: 'closed' });
  await assert.rejects(service('state', { ...args, number: 7, state: 'closed' }), { code: 'NOT_ISSUE' });
  assert.deepEqual(requests.filter(r => r.method !== 'GET'), [
    { path: '/repos/octo/demo/issues', method: 'POST', body: { title: 'New', body: 'Test' } },
    { path: '/repos/octo/demo/issues/3/comments', method: 'POST', body: { body: 'Test' } },
    { path: '/repos/octo/demo/issues/3', method: 'PATCH', body: { state: 'closed' } },
  ]);
});

test('label and assignee updates preserve unrelated values and escape label paths', async () => {
  const labels = ['keep'];
  const assigned = ['octo'];
  const { service, requests } = fixture((path, method, body) => {
    if (method === 'POST' && path.endsWith('/labels')) labels.push(...body.labels);
    if (method === 'DELETE' && path.includes('/labels/')) labels.splice(labels.indexOf(decodeURIComponent(path.split('/').at(-1))), 1);
    if (method === 'POST' && path.endsWith('/assignees')) assigned.push(...body.assignees);
    if (method === 'DELETE' && path.endsWith('/assignees')) assigned.splice(assigned.indexOf(body.assignees[0]), 1);
    return wrap({ ...apiIssue, labels: labels.map(name => ({ name })), assignees: assigned.map(login => ({ login })) });
  });
  await service('addLabels', { ...args, values: ['a/b ?'] });
  await service('removeLabel', { ...args, value: 'a/b ?' });
  await service('addAssignees', { ...args, values: ['teammate'] });
  await service('removeAssignees', { ...args, values: ['teammate'] });
  assert.deepEqual(labels, ['keep']);
  assert.deepEqual(assigned, ['octo']);
  assert.ok(requests.some(r => r.path.endsWith('/labels/a%2Fb%20%3F')));
  await assert.rejects(service('removeLabel', { ...args, value: '..' }), { code: 'INVALID_INPUT' });
});

test('reopens an issue and recognizes a refused assignee change', async () => {
  const { service } = fixture((path, method, body) => wrap({ ...apiIssue, state: body?.state || 'closed' }));
  assert.equal((await service('state', { ...args, state: 'open' })).state, 'open');
  assert.ok((await service('addAssignees', { ...args, values: ['other'] })).warning);
});

test('CLI requests only target github.com and pass JSON through stdin', async () => {
  const makeRequest = createApi(async (args, body) => {
    assert.equal(args[args.indexOf('--hostname') + 1], 'github.com');
    assert.deepEqual(args.slice(-2), ['--input', '-']);
    assert.deepEqual(body, { body: 'hello' });
    assert.ok(!args.includes('hello'));
    return { code: 0, stdout: 'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"id":8}' };
  });
  assert.equal((await makeRequest('/example', 'POST', { body: 'hello' })).data.id, 8);
  assert.equal(decodeResponse('HTTP/2.0 204 No Content\nX-A: b\n\n').headers.get('x-a'), 'b');
});

test('invalid authentication and rate limits yield actionable errors', async () => {
  for (const [code, stdout, expected] of [[4, '', 'AUTH'], [1, 'HTTP/2 401\n\n', 'AUTH'],
    [1, 'HTTP/2 403\nX-RateLimit-Remaining: 0\n\n', 'RATE_LIMIT'], [1, 'HTTP/2 403\nX-GitHub-SSO: required\n\n', 'FORBIDDEN']]) {
    await assert.rejects(createApi(async () => ({ code, stdout }))('/user'), { code: expected });
  }
});

test('write timeout is uncertain and is not retried', async () => {
  let attempts = 0;
  const makeRequest = createApi(async () => { attempts++; throw new GitHubError('TIMEOUT', 'timeout'); });
  await assert.rejects(makeRequest('/example', 'POST', { title: 'test' }), { code: 'WRITE_UNCERTAIN' });
  assert.equal(attempts, 1);
});

function http(status, body, headers = {}) {
  const lines = Object.entries(headers).map(([name, value]) => name + ': ' + value);
  return { code: status >= 400 ? 1 : 0,
    stdout: ['HTTP/2 ' + status, ...lines, '', JSON.stringify(body)].join('\n') };
}

test('ordinary core headers populate quota, other resources do not override it, and explicit refresh reads core', async () => {
  const now = 1700000000000;
  const reset = now / 1000 + 360;
  const responses = [
    http(200, { id: 42, login: 'octo' }, { 'X-RateLimit-Resource': 'core', 'X-RateLimit-Limit': 5000, 'X-RateLimit-Remaining': 17, 'X-RateLimit-Reset': reset }),
    http(200, [], { 'X-RateLimit-Resource': 'search', 'X-RateLimit-Limit': 30, 'X-RateLimit-Remaining': 3, 'X-RateLimit-Reset': reset }),
    http(200, { id: 42, login: 'octo' }),
    http(200, { resources: { core: { limit: 5000, remaining: 13, reset } } }),
  ];
  const calls = [];
  const api = createApi(async argv => { calls.push(argv.at(-1)); return responses.shift(); }, () => now);
  const service = createService(api);
  await service('account');
  assert.equal(api.quotaSnapshot().accountId, 42);
  assert.deepEqual(api.quotaSnapshot().core, { limit: 5000, remaining: 17, reset: reset * 1000, observedAt: now });
  await api('/search/issues');
  assert.equal(api.quotaSnapshot().core.remaining, 17);
  await service('quota', { accountId: 42 });
  assert.equal(api.quotaSnapshot().core.remaining, 13);
  assert.deepEqual(calls, ['/user', '/search/issues', '/user', '/rate_limit']);
});

test('secondary limits pause requests including writes until Retry-After, then allow the next explicit request', async () => {
  let now = 1700000000000;
  let calls = 0;
  const api = createApi(async () => ++calls === 1
    ? http(403, { message: 'You have exceeded a secondary rate limit' }, { 'Retry-After': 45 })
    : http(200, []), () => now);
  await assert.rejects(api('/repos/octo/demo/issues'), { code: 'RATE_LIMIT' });
  assert.deepEqual(api.quotaSnapshot().cooldown, { kind: 'secondary', until: now + 45000 });
  await assert.rejects(api('/repos/octo/demo/issues', 'POST', {}), { code: 'RATE_LIMIT' });
  assert.equal(calls, 1);
  now += 45001;
  await api('/repos/octo/demo/issues');
  assert.equal(calls, 2);
  assert.equal(api.quotaSnapshot().cooldown, null);
});

test('last successful core request exhausts quota without replaying the following request', async () => {
  let now = 1700000000000;
  let calls = 0;
  const reset = now / 1000 + 90;
  const api = createApi(async () => ++calls === 1
    ? http(200, [], { 'X-RateLimit-Resource': 'core', 'X-RateLimit-Remaining': 0, 'X-RateLimit-Limit': 5000, 'X-RateLimit-Reset': reset })
    : http(200, []), () => now);
  await api('/repos/octo/demo/issues');
  assert.deepEqual(api.quotaSnapshot().cooldown, { kind: 'primary', until: reset * 1000 });
  await assert.rejects(api('/repos/octo/demo/issues'), { code: 'RATE_LIMIT' });
  assert.equal(calls, 1);
  now = reset * 1000 + 1;
  await api('/repos/octo/demo/issues');
  assert.equal(calls, 2);
});

test('concurrent account reads share a request, while a subsequent check detects a switched account', async () => {
  const { service, switchAccount, requests } = fixture(() => assert.fail('unexpected repository request'));
  const [a, b] = await Promise.all([service('account'), service('account')]);
  assert.equal(a.id, b.id);
  assert.equal(requests.length, 1);
  switchAccount();
  assert.equal((await service('account')).id, 99);
  assert.equal(requests.length, 2);
});
