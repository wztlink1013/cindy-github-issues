'use strict';

const $ = id => document.getElementById(id);
const channel = new BroadcastChannel('cindy-github-issues/v1');
const calls = new Map();
const mutations = new Set(['create', 'comment', 'state', 'addLabels', 'removeLabel', 'addAssignees', 'removeAssignees']);
const roles = { admin: '管理员', maintain: '维护', push: '写入', triage: '分流', pull: '读取', unknown: '角色未知' };
const repoPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/i;
const REPO_CACHE_MS = 5 * 60 * 1000;
const FOCUS_CHECK_MS = 60 * 1000;
const key = value => value.toLowerCase();
const stateName = value => value === 'open' ? '打开' : '已关闭';
const time = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : '';
const current = { account: null, selected: new Map(), issuePages: new Map(), detail: null, generation: 0, listGeneration: 0, selection: null, reading: false, writing: false };
let repoCache = null;
let quotaSnapshot = null;
let quotaBusy = false;
let quotaTimer;
let lastAccountCheck = 0;

function renderQuota() {
  const now = Date.now();
  const core = quotaSnapshot?.core;
  const cooldown = quotaSnapshot?.cooldown?.until > now ? quotaSnapshot.cooldown : null;
  const low = Boolean(core && core.reset > now && core.remaining <= Math.max(10, core.limit * 0.05));
  $('quota').dataset.low = String(low || Boolean(cooldown));
  $('quota-count').textContent = core ? 'GitHub REST API 剩余 ' + core.remaining.toLocaleString() + ' / ' + core.limit.toLocaleString()
    : 'GitHub REST API 额度 · 暂无数据';
  const details = [];
  if (core) {
    details.push((core.reset <= now ? '上次额度周期已结束，刷新可查看新额度' : '重置于 ' + time(core.reset)) + ' · 更新于 ' + time(core.observedAt));
  }
  if (cooldown) details.push((cooldown.kind === 'primary' ? '额度已用完' : '请求频率受限') + '，请在 ' + time(cooldown.until) + ' 后重试');
  else if (low) details.push('剩余额度偏低');
  $('quota-detail').textContent = details.join('。');
  $('quota-refresh').disabled = !current.account || quotaBusy || Boolean(cooldown);
  clearTimeout(quotaTimer);
  const nextChange = Math.min(cooldown?.until ?? Infinity, core?.reset > now ? core.reset : Infinity);
  if (Number.isFinite(nextChange)) quotaTimer = setTimeout(renderQuota, Math.min(nextChange - now + 50, 2147483647));
}

function receiveQuota(snapshot, accountId) {
  if (!snapshot || (snapshot.accountId != null && snapshot.accountId !== accountId)) return;
  if (snapshot.core || snapshot.cooldown || quotaSnapshot) {
    quotaSnapshot = { ...snapshot, core: snapshot.core || quotaSnapshot?.core };
    renderQuota();
  }
}

async function refreshQuota() {
  if (!current.account || quotaBusy) return;
  quotaBusy = true;
  renderQuota();
  try {
    await rpc('quota', { accountId: current.account.id });
  } catch (error) {
    if (!handleAccountChange(error)) notice(error.message);
  } finally {
    quotaBusy = false;
    renderQuota();
  }
}

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, handler, className) {
  const element = make('button', text, className);
  element.type = 'button';
  element.onclick = handler;
  return element;
}

function option(text, value) {
  const element = make('option', text);
  element.value = value;
  return element;
}

function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

channel.onmessage = ({ data }) => {
  const call = calls.get(data?.id);
  if (!call) return;
  if (data.type === 'ack') clearInterval(call.retry);
  if (data.type === 'result') {
    call.close();
    if (call.generation === current.generation && call.action !== 'account' && current.account) {
      receiveQuota(data.result?.quota, current.account.id);
    }
    if (call.action === 'account' && call.generation === current.generation && current.account && data.result?.data?.id === current.account.id) {
      receiveQuota(data.result?.quota, current.account.id);
    }
    if (data.result?.ok === true) {
      if (call.action === 'account') lastAccountCheck = Date.now();
      call.resolve(call.includeQuota ? { ...data.result.data, quota: data.result.quota } : data.result.data);
    } else {
      const error = rpcError(data.result?.code, data.result?.message || '请求失败。');
      error.quota = data.result?.quota;
      call.reject(error);
    }
  }
};

async function rpc(action, args = {}) {
  const blockedUntil = quotaSnapshot?.cooldown?.until;
  if (blockedUntil > Date.now()) throw rpcError('RATE_LIMIT', 'GitHub 当前限流，请在 ' + time(blockedUntil) + ' 后重试。');
  const generation = current.generation;
  let wake;
  try { wake = await fetch('/wake'); } catch { /* handled below */ }
  if (!wake?.ok) throw rpcError('BRIDGE', '无法唤醒插件，请重新检测。');
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  const message = { type: 'request', id, action, args };
  return new Promise((resolve, reject) => {
    const retry = setInterval(() => channel.postMessage(message), 450);
    const timeout = setTimeout(() => {
      close();
      reject(mutations.has(action)
        ? rpcError('WRITE_UNCERTAIN', '无法确认 GitHub 是否已保存。请先到 GitHub 核对结果，再决定是否重试。')
        : rpcError('TIMEOUT', 'GitHub 后台响应超时，请重试。'));
    }, action === 'state' ? 177000 : 88000);
    function close() {
      clearInterval(retry);
      clearTimeout(timeout);
      calls.delete(id);
    }
    calls.set(id, { action, generation, includeQuota: args.includeQuota === true, resolve, reject, retry, close });
    channel.postMessage(message);
  });
}

async function readSettings() {
  const response = await fetch('/kv');
  if (!response.ok) throw Error('无法读取已保存的仓库选择。');
  return await response.json();
}

function savedRepositories(config, account) {
  const entries = config.accounts?.[String(account.id)]?.repositories;
  if (!Array.isArray(entries)) return [];
  return entries.filter(repo => typeof repo?.name === 'string' && repoPattern.test(repo.name));
}

function updateControls() {
  $('choose').disabled = !current.account || current.writing;
  $('workspace').hidden = !current.account;
  $('create').disabled = current.writing || ![...current.selected.values()].some(repo => !repo.archived && repo.issues);
  $('refresh').disabled = current.writing;
  renderQuota();
}

async function detect() {
  if (quotaSnapshot?.cooldown?.until > Date.now()) {
    notice('GitHub 当前限流，请在 ' + time(quotaSnapshot.cooldown.until) + ' 后重新检测。');
    return;
  }
  const generation = ++current.generation;
  ++current.listGeneration;
  current.account = null;
  current.selected = new Map();
  current.issuePages.clear();
  current.detail = null;
  current.reading = false;
  current.selection = null;
  quotaSnapshot = null;
  if ($('chooser').open) $('chooser').close();
  if ($('new-issue').open) $('new-issue').close();
  $('account').textContent = '正在检查 GitHub CLI…';
  updateControls();
  $('refresh').disabled = true;
  notice();
  try {
    const account = await rpc('account', { includeQuota: true });
    const config = await readSettings();
    if (generation !== current.generation) return;
    current.account = account;
    if (repoCache?.accountId !== account.id) repoCache = null;
    receiveQuota(account.quota, account.id);
    for (const id of ['query', 'label-filter', 'assignee-filter']) $(id).value = '';
    $('state-filter').value = 'open';
    $('repo-filter').value = '';
    current.selected = new Map(savedRepositories(config, account).map(repo => [key(repo.name), repo]));
    $('account').textContent = '@' + account.login + ' · 本机 GitHub CLI';
    renderRepoFilter();
    renderDetail();
    void reloadIssues();
  } catch (error) {
    if (generation !== current.generation) return;
    $('account').textContent = 'GitHub CLI 未连接';
    if (error.code === 'RATE_LIMIT' && error.quota?.cooldown) receiveQuota(error.quota, error.quota.accountId);
    notice(error.message);
  } finally {
    if (generation === current.generation) updateControls();
  }
}

function handleAccountChange(error) {
  if (error.code !== 'ACCOUNT_CHANGED') return false;
  void detect();
  return true;
}

function renderRepoFilter() {
  const selected = $('repo-filter').value;
  const options = [...current.selected.values()].sort((a, b) => a.name.localeCompare(b.name));
  $('repo-filter').replaceChildren(option('全部仓库', ''), ...options.map(repo => option(repo.name, repo.name)));
  if (options.some(repo => repo.name === selected)) $('repo-filter').value = selected;
}

function openChooser() {
  if (!current.account || current.writing) return;
  const cached = repoCache?.accountId === current.account.id && Date.now() - repoCache.loadedAt < REPO_CACHE_MS ? repoCache : null;
  const selection = { account: current.account, observed: new Map(cached?.items), original: new Map(current.selected),
    draft: new Map(current.selected), page: 1, status: cached ? 'done' : 'idle', error: '', saving: false, cached: Boolean(cached) };
  for (const [id, repo] of selection.observed) if (selection.draft.has(id)) selection.draft.set(id, repo);
  current.selection = selection;
  $('repo-query').value = '';
  $('chooser').showModal();
  renderChooser();
  if (!cached) void listRepositories(selection);
}

function refreshRepositories() {
  const selection = current.selection;
  if (!selection || selection.saving || selection.status === 'loading') return;
  repoCache = null;
  Object.assign(selection, { observed: new Map(), page: 1, cached: false });
  void listRepositories(selection);
}

function renderChooser() {
  const selection = current.selection;
  if (!selection || !$('chooser').open) return;
  const query = key($('repo-query').value.trim());
  const grouped = new Map();
  const seen = new Map([...selection.original, ...selection.observed]);
  for (const repo of [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!key(repo.name).includes(query)) continue;
    const heading = (repo.organization ? '组织 · ' : '个人 · ') + repo.owner;
    if (!grouped.has(heading)) grouped.set(heading, []);
    grouped.get(heading).push(repo);
  }
  const focused = document.activeElement?.dataset.repo;
  const sets = [];
  for (const [heading, repositories] of grouped) {
    const fieldset = make('fieldset', null, 'repo-group');
    fieldset.append(make('legend', heading));
    for (const repo of repositories) {
      const id = key(repo.name);
      const row = make('label', null, 'repo-row');
      const checkbox = make('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.repo = id;
      checkbox.checked = selection.draft.has(id);
      checkbox.disabled = selection.saving || (!checkbox.checked && (!repo.issues || !selection.observed.has(id)));
      const info = [roles[repo.role] || roles.unknown, repo.private ? '私有' : '公开'];
      if (!repo.issues) info.push('Issues 已关闭');
      if (repo.archived) info.push('已归档 · 只读');
      if (!selection.observed.has(id) && selection.status === 'done') info.push('当前账号不可访问');
      const description = make('span');
      description.append(make('span', repo.name), make('span', info.join(' · '), 'muted'));
      checkbox.onchange = () => {
        if (checkbox.checked) selection.draft.set(id, repo);
        else selection.draft.delete(id);
        if (!checkbox.checked && (!repo.issues || !selection.observed.has(id))) checkbox.disabled = true;
        $('selected-count').textContent = '已选 ' + selection.draft.size + ' 个仓库';
      };
      row.append(checkbox, description);
      fieldset.append(row);
    }
    sets.push(fieldset);
  }
  const container = $('repo-choices');
  const scrollTop = container.scrollTop;
  container.replaceChildren(...sets);
  container.scrollTop = scrollTop;
  if (focused) [...container.querySelectorAll('input')].find(el => el.dataset.repo === focused)?.focus({ preventScroll: true });
  const loaded = '已读取 ' + selection.observed.size + ' 个仓库';
  $('chooser-status').textContent = selection.error || (selection.status === 'loading' ? loaded + '，正在读取下一页…'
    : loaded + (selection.cached ? '（近期缓存）' : '') + (sets.length ? '。' : '，没有匹配的结果。'));
  $('retry-choices').hidden = selection.status !== 'error';
  $('retry-choices').disabled = selection.saving;
  $('refresh-choices').hidden = selection.status !== 'done';
  $('refresh-choices').disabled = selection.saving;
  $('save-choice').disabled = selection.saving;
  $('cancel-choice').disabled = selection.saving;
  $('selected-count').textContent = '已选 ' + selection.draft.size + ' 个仓库';
}

async function listRepositories(selection) {
  if (!selection || selection !== current.selection || selection.status === 'loading') return;
  selection.status = 'loading';
  selection.error = '';
  renderChooser();
  try {
    while (selection === current.selection && !selection.saving) {
      const page = await rpc('repositories', { accountId: selection.account.id, page: selection.page });
      if (selection !== current.selection || selection.saving) return;
      for (const repo of page.items) {
        const id = key(repo.name);
        selection.observed.set(id, repo);
        if (selection.draft.has(id)) selection.draft.set(id, repo);
      }
      selection.page++;
      if (!page.hasNext) {
        selection.status = 'done';
        repoCache = { accountId: selection.account.id, items: new Map(selection.observed), loadedAt: Date.now() };
        break;
      }
      renderChooser();
    }
  } catch (error) {
    if (selection !== current.selection || handleAccountChange(error)) return;
    selection.status = 'error';
    selection.error = error.message;
  }
  if (selection.status === 'loading') selection.status = 'idle';
  if (selection === current.selection) renderChooser();
}

async function saveChoice() {
  const selection = current.selection;
  if (!selection || selection.saving) return;
  selection.saving = true;
  selection.error = '';
  renderChooser();
  try {
    if ((await rpc('account')).id !== selection.account.id) throw rpcError('ACCOUNT_CHANGED', '账号已切换。');
    const cfg = await readSettings();
    const repositories = [...selection.draft.values()];
    const accounts = { ...cfg.accounts, [String(selection.account.id)]: { repositories } };
    const response = await fetch('/kv', { method: 'PUT', body: JSON.stringify({ accounts }) });
    if (!response.ok) throw Error(response.status === 413 ? '仓库选择超过保存上限，请减少选择。' : '无法保存仓库选择。');
    if (selection !== current.selection) return;
    current.selected = new Map(repositories.map(repo => [key(repo.name), repo]));
    if (current.detail && !current.selected.has(key(current.detail.repo))) current.detail = null;
    $('chooser').close();
    renderRepoFilter();
    updateControls();
    renderDetail();
    void reloadIssues();
  } catch (error) {
    if (selection !== current.selection || handleAccountChange(error)) return;
    selection.error = error.message;
  } finally {
    selection.saving = false;
    if (selection === current.selection) {
      renderChooser();
      if (selection.status === 'idle') void listRepositories(selection);
    }
  }
}

async function reloadIssues() {
  ++current.listGeneration;
  current.reading = false;
  current.issuePages.clear();
  const filter = $('repo-filter').value;
  for (const repo of current.selected.values()) {
    if (filter && key(repo.name) !== key(filter)) continue;
    current.issuePages.set(repo.name, { list: [], page: 1, hasNext: true, error: '', duringRead: null });
  }
  await readIssuePages(false);
}

async function readIssuePages(retry) {
  if (current.reading) return;
  const generation = current.listGeneration;
  const account = current.account;
  const status = $('state-filter').value;
  const entries = [...current.issuePages].filter(([, page]) => page.hasNext && (retry || !page.error));
  if (!entries.length) { renderIssues(); return; }
  current.reading = true;
  renderIssues();
  try {
    if ((await rpc('account')).id !== account.id) throw rpcError('ACCOUNT_CHANGED', '账号已切换。');
    let index = 0;
    async function readNext() {
      while (generation === current.listGeneration && index < entries.length) {
        const [repo, data] = entries[index++];
        data.duringRead = new Map();
        try {
          const result = await rpc('issues', { repo, page: data.page, state: status });
          if (generation !== current.listGeneration) return;
          const merged = new Map(data.list.map(issue => [issue.number, issue]));
          for (const issue of result.items) merged.set(issue.number, { ...issue, repo });
          for (const issue of data.duringRead.values()) mergeIssue(merged, issue, status);
          const changed = data.duringRead.size > 0;
          Object.assign(data, { list: [...merged.values()], page: changed ? 1 : data.page + 1, hasNext: changed || result.hasNext, error: '' });
        } catch (error) {
          data.error = error.message;
          if (error.code === 'RATE_LIMIT') index = entries.length;
        } finally {
          data.duringRead = null;
        }
        if (generation === current.listGeneration) renderIssues();
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, entries.length) }, readNext));
    if (generation === current.listGeneration && !(quotaSnapshot?.cooldown?.until > Date.now()) && (await rpc('account')).id !== account.id) throw rpcError('ACCOUNT_CHANGED', '账号已切换。');
  } catch (error) {
    if (generation === current.listGeneration && !handleAccountChange(error)) notice(error.message);
  } finally {
    if (generation === current.listGeneration) {
      current.reading = false;
      renderIssues();
    }
  }
}

function mergeIssue(issues, issue, state) {
  if (state === 'all' || issue.state === state) issues.set(issue.number, issue);
  else issues.delete(issue.number);
}

function updateIssueRow(repo, issue) {
  const page = current.issuePages.get(repo);
  if (!page) return;
  const { body, locked, warning, ...summary } = issue;
  const item = { ...summary, repo };
  const issues = new Map(page.list.map(row => [row.number, row]));
  mergeIssue(issues, item, $('state-filter').value);
  page.list = [...issues.values()];
  if (page.duringRead) page.duringRead.set(item.number, item);
  else if (page.hasNext) page.page = 1;
  renderIssues();
}

function renderIssues() {
  const query = key($('query').value.trim());
  const name = key($('label-filter').value.trim());
  const assignee = key($('assignee-filter').value.trim()).replace(/^@/, '');
  const loaded = [...current.issuePages.values()].flatMap(page => page.list);
  const filtered = loaded.filter(issue =>
    (!query || key(issue.title).includes(query) || String(issue.number) === query.replace(/^#/, '')) &&
    (!name || issue.labels.some(label => key(label.name).includes(name))) &&
    (!assignee || issue.assignees.some(login => key(login).includes(assignee))));
  filtered.sort((a, b) => b.updated.localeCompare(a.updated) || a.repo.localeCompare(b.repo) || b.number - a.number);
  const results = filtered.map(issue => {
    const li = make('li');
    const open = button(null, () => void openIssue(issue.repo, issue.number, true), 'issue-item');
    if (current.detail?.repo === issue.repo && current.detail.number === issue.number) open.setAttribute('aria-current', 'true');
    const meta = make('div', issue.repo + ' #' + issue.number + ' · ' + stateName(issue.state) + (issue.updated ? ' · ' + time(issue.updated) : ''), 'subline');
    open.append(make('strong', issue.title || '无标题'), meta);
    if (issue.labels.length || issue.assignees.length) {
      const tags = make('div', null, 'chips');
      tags.append(...issue.labels.map(item => make('span', item.name, 'chip')), ...issue.assignees.map(login => make('span', '@' + login, 'chip')));
      open.append(tags);
    }
    li.append(open);
    return li;
  });
  $('issues').replaceChildren(...results);
  const errors = [...current.issuePages].filter(([, page]) => page.error).map(([repo, page]) => make('li', repo + ' · ' + page.error));
  $('repo-errors').replaceChildren(...errors);
  $('repo-errors').hidden = !errors.length;
  $('list-status').textContent = !current.selected.size ? '点击「选择仓库」开始。' : (current.reading ? '正在加载 · ' : '') + '显示 ' + results.length + ' / 已加载 ' + loaded.length + ' 条';
  const more = $('more-issues');
  more.hidden = ![...current.issuePages.values()].some(page => page.hasNext);
  more.disabled = current.reading;
  more.textContent = errors.length ? '加载更多 / 重试失败仓库' : '加载更多 Issues';
}

function githubLink(repo, number) {
  const a = make('a', '在 GitHub 打开 ↗');
  a.href = 'https://github.com/' + repo.split('/').map(encodeURIComponent).join('/') + '/issues/' + number;
  return a;
}

async function openIssue(repo, number, focus = false, knownIssue = null) {
  if (current.writing || !current.account) return;
  const detail = { repo, number, accountId: current.account.id, loading: !knownIssue, issue: knownIssue, comments: [], commentPage: 1, commentNext: true, draft: '' };
  current.detail = detail;
  renderIssues();
  renderDetail();
  if (focus) {
    $('detail').focus({ preventScroll: true });
    if (matchMedia('(max-width: 720px)').matches) $('detail').scrollIntoView({ block: 'start' });
  }
  if (knownIssue) return;
  try {
    if ((await rpc('account')).id !== detail.accountId) throw rpcError('ACCOUNT_CHANGED', '账号已切换。');
    const issue = await rpc('issue', { repo, number });
    if ((await rpc('account')).id !== detail.accountId) throw rpcError('ACCOUNT_CHANGED', '账号已切换。');
    if (detail === current.detail) detail.issue = issue;
  } catch (error) {
    if (detail !== current.detail || handleAccountChange(error)) return;
    detail.error = error.message;
  } finally {
    detail.loading = false;
    if (detail === current.detail) renderDetail();
  }
  if (detail === current.detail && detail.issue?.comments) void loadComments(detail);
}

async function loadComments(detail) {
  if (detail.commentLoading || !detail.commentNext) return;
  detail.commentLoading = true;
  detail.commentError = '';
  renderDetail();
  try {
    const data = await rpc('comments', { accountId: detail.accountId, repo: detail.repo, number: detail.number, page: detail.commentPage });
    const merged = new Map(detail.comments.map(item => [item.id, item]));
    for (const item of data.items) merged.set(item.id, item);
    detail.comments = [...merged.values()].sort((a, b) => a.id - b.id);
    detail.commentPage++;
    detail.commentNext = data.hasNext;
  } catch (error) {
    if (detail === current.detail && !handleAccountChange(error)) detail.commentError = error.message;
  } finally {
    detail.commentLoading = false;
    if (detail === current.detail) renderDetail();
  }
}

function disableWhileWriting(container) {
  if (current.writing) for (const el of container.querySelectorAll('button, input, select, textarea')) el.disabled = true;
}

function editor(title, values, placeholder, add, remove) {
  const section = make('section', null, 'stack section');
  const items = make('div', null, 'chips');
  for (const name of values) {
    const control = button(name + ' ×', () => remove(name), 'chip');
    control.setAttribute('aria-label', '移除' + title + ' ' + name);
    items.append(control);
  }
  const form = make('form', null, 'inline-form');
  const input = make('input');
  input.required = true;
  input.maxLength = 100;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  const submit = make('button', '添加');
  submit.type = 'submit';
  form.onsubmit = event => {
    event.preventDefault();
    if (input.value.trim()) add(input.value.trim());
  };
  form.append(input, submit);
  section.append(make('h3', title), items, form);
  return section;
}

function renderDetail() {
  const detail = current.detail;
  const panel = $('detail');
  if (!detail) { panel.replaceChildren(make('p', '选择一个 Issue 查看详情。', 'muted')); return; }
  if (detail.loading) { panel.replaceChildren(make('p', '正在加载 ' + detail.repo + ' #' + detail.number + '…')); return; }
  if (!detail.issue) {
    panel.replaceChildren(make('p', detail.error || '无法加载 Issue。'), button('重试', () => void openIssue(detail.repo, detail.number)), githubLink(detail.repo, detail.number));
    return;
  }
  const issue = detail.issue;
  const repo = current.selected.get(key(detail.repo));
  const archived = repo?.archived || !repo?.issues;
  const canTriage = !archived && ['admin', 'maintain', 'push', 'triage', 'unknown'].includes(repo?.role);
  const own = key(issue.author) === key(current.account.login);
  const layout = make('div', null, 'stack');
  layout.append(make('p', detail.repo + ' #' + detail.number, 'muted'), make('h2', issue.title),
    make('p', stateName(issue.state) + ' · @' + issue.author + ' · ' + time(issue.updated), 'muted'));
  const actions = make('div', null, 'actions');
  actions.append(githubLink(detail.repo, detail.number), button('刷新详情', () => void openIssue(detail.repo, detail.number)));
  if (!archived && (canTriage || own)) {
    actions.append(button(issue.state === 'open' ? '关闭 Issue' : '重开 Issue',
      () => void edit(detail, 'state', { state: issue.state === 'open' ? 'closed' : 'open' })));
  }
  layout.append(actions);
  if (archived) layout.append(make('p', '此仓库当前仅可查看。', 'muted'));
  if (detail.status) layout.append(make('p', detail.status, 'notice'));
  if (issue.body) layout.append(make('div', issue.body, 'prose section'));
  if (canTriage) {
    layout.append(editor('标签', issue.labels.map(l => l.name), '输入仓库中的标签名',
      name => void edit(detail, 'addLabels', { values: [name] }), name => void edit(detail, 'removeLabel', { value: name })));
    layout.append(editor('指派人', issue.assignees, '输入 GitHub 用户名',
      name => void edit(detail, 'addAssignees', { values: [name.replace(/^@/, '')] }),
      name => void edit(detail, 'removeAssignees', { values: [name] })));
  } else {
    layout.append(make('p', '标签 · ' + (issue.labels.map(l => l.name).join('、') || '无') + '　指派 · ' + (issue.assignees.join('、') || '无'), 'muted'));
  }
  const comments = make('section', null, 'stack section');
  comments.append(make('h3', '评论 · ' + issue.comments));
  for (const item of detail.comments) {
    const card = make('article', null, 'comment-box');
    card.append(make('p', '@' + item.author + ' · ' + time(item.created), 'muted'), make('div', item.body, 'prose'));
    comments.append(card);
  }
  if (detail.commentLoading) comments.append(make('p', '正在加载评论…', 'muted'));
  if (detail.commentError) comments.append(make('p', detail.commentError, 'notice'));
  if (!detail.commentLoading && (detail.commentError || issue.comments && detail.commentNext)) {
    comments.append(button(detail.commentError ? '重试评论' : '加载更多评论', () => void loadComments(detail)));
  }
  if (!archived && (!issue.locked || canTriage)) {
    const form = make('form', null, 'stack');
    const label = make('label', '评论 ' + detail.repo + ' #' + detail.number);
    const text = make('textarea');
    text.required = true;
    text.rows = 3;
    text.maxLength = 50000;
    text.value = detail.draft;
    text.oninput = () => { detail.draft = text.value; };
    label.append(text);
    const submit = make('button', '发表评论', 'primary');
    submit.type = 'submit';
    form.onsubmit = event => {
      event.preventDefault();
      if (detail.draft.trim()) void edit(detail, 'comment', { body: detail.draft });
    };
    form.append(label, submit);
    comments.append(form);
  }
  layout.append(comments);
  disableWhileWriting(layout);
  panel.replaceChildren(layout);
}

async function edit(detail, action, fields) {
  if (detail !== current.detail || current.writing) return;
  current.writing = true;
  detail.status = '正在处理 ' + detail.repo + ' #' + detail.number + '…';
  renderDetail();
  updateControls();
  try {
    const args = { repo: detail.repo, number: detail.number, accountId: detail.accountId };
    const saved = await rpc(action, { ...args, ...fields });
    detail.status = saved?.warning || '已保存到 GitHub。';
    if (action === 'comment') {
      detail.draft = '';
      if (saved.id && !detail.comments.some(item => item.id === saved.id)) {
        detail.comments.push(saved);
        detail.issue = { ...detail.issue, comments: detail.issue.comments + 1 };
      } else if (!saved.id) detail.status = '评论已发送。请刷新详情查看。';
    } else detail.issue = saved;
    if (detail === current.detail) updateIssueRow(detail.repo, detail.issue);
  } catch (error) {
    if (!handleAccountChange(error)) detail.status = error.message;
  } finally {
    current.writing = false;
    updateControls();
    if (detail === current.detail) renderDetail();
  }
}

function openCreate() {
  const form = $('new-form');
  form.reset();
  form.elements.repo.replaceChildren(...[...current.selected.values()].filter(repo => repo.issues && !repo.archived)
    .sort((a, b) => a.name.localeCompare(b.name)).map(repo => option(repo.name, repo.name)));
  $('create-status').textContent = '';
  $('new-issue').showModal();
  form.elements.title.focus();
}

async function createIssue(event) {
  event.preventDefault();
  if (current.writing) return;
  const form = event.currentTarget;
  const repo = form.elements.repo.value;
  const title = form.elements.title.value.trim();
  if (!title) { $('create-status').textContent = '请输入标题。'; return; }
  const args = { repo, title, body: form.elements.body.value, accountId: current.account.id };
  current.writing = true;
  updateControls();
  disableWhileWriting(form);
  $('create-status').textContent = '正在向 ' + repo + ' 提交…';
  let issue;
  try {
    issue = await rpc('create', args);
    $('new-issue').close();
  } catch (error) {
    if (!handleAccountChange(error)) $('create-status').textContent = error.message;
  } finally {
    current.writing = false;
    updateControls();
    for (const el of form.querySelectorAll('button, input, select, textarea')) el.disabled = false;
  }
  if (issue) {
    notice('已创建 ' + repo + ' #' + issue.number + '。');
    updateIssueRow(repo, issue);
    void openIssue(repo, issue.number, true, issue);
  }
}

$('choose').onclick = openChooser;
$('refresh').onclick = () => void detect();
$('quota-refresh').onclick = () => void refreshQuota();
$('create').onclick = openCreate;
$('new-form').onsubmit = createIssue;
$('cancel-create').onclick = () => $('new-issue').close();
$('new-issue').oncancel = event => { if (current.writing) event.preventDefault(); };
$('cancel-choice').onclick = () => $('chooser').close();
$('chooser').oncancel = event => { if (current.selection?.saving) event.preventDefault(); };
$('chooser').onclose = () => { if (!$('chooser').open) current.selection = null; };
$('save-choice').onclick = () => void saveChoice();
$('retry-choices').onclick = () => void listRepositories(current.selection);
$('refresh-choices').onclick = refreshRepositories;
$('repo-query').oninput = renderChooser;
$('more-issues').onclick = () => void readIssuePages(true);
for (const id of ['query', 'label-filter', 'assignee-filter']) $(id).oninput = renderIssues;
for (const id of ['repo-filter', 'state-filter']) $(id).onchange = () => void reloadIssues();
window.addEventListener('focus', () => {
  const account = current.account;
  if (!account || current.writing || quotaSnapshot?.cooldown?.until > Date.now() || Date.now() - lastAccountCheck < FOCUS_CHECK_MS) return;
  lastAccountCheck = Date.now();
  void rpc('account').then(fresh => {
    if (account === current.account && fresh.id !== account.id) void detect();
  }).catch(error => { if (account === current.account) notice(error.message); });
});
void detect();
