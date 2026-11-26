'use strict';

const { spawn } = require('node:child_process');

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const REPO = /^(?!\.{1,2}$)[a-z0-9._-]{1,100}$/i;
const API_TIMEOUT = 15000;
const PAGE_SIZE = 50;
const MAX_OUTPUT = 20 * 1024 * 1024;

class GitHubError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function rejectUnless(condition) {
  if (!condition) throw new GitHubError('INVALID_INPUT', '请求参数无效，请刷新页面后重试。');
}

function runGh(args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|GH_DEBUG|DEBUG)$/i.test(key)));
  env.GH_PROMPT_DISABLED = '1';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  env.NO_COLOR = '1';
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let failure;
    const stdout = [];
    let size = 0;
    const timer = setTimeout(() => {
      failure = new GitHubError('TIMEOUT', 'GitHub 请求超时。');
      child.kill();
    }, API_TIMEOUT);
    child.on('error', error => {
      failure = error.code === 'ENOENT'
        ? new GitHubError('CLI_MISSING', '找不到 GitHub CLI。安装 gh 并重启 Cindy，再点击「重新检测」。')
        : new GitHubError('CLI_FAILED', '无法启动 GitHub CLI，请检查本机安装。');
    });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        failure = new GitHubError('RESPONSE_LIMIT', 'GitHub 响应过大，请在 GitHub 网页中查看。');
        child.kill();
      } else stdout.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8') });
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function decodeResponse(stdout) {
  const normalized = stdout.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n\n');
  if (end < 0) return { status: 0, headers: new Map(), body: '' };
  const [statusLine, ...headerLines] = normalized.slice(0, end).split('\n');
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(statusLine)?.[1] || 0);
  const headers = new Map();
  for (const line of headerLines) {
    const index = line.indexOf(':');
    if (index > 0) headers.set(line.slice(0, index).toLowerCase(), line.slice(index + 1).trim());
  }
  return { status, headers, body: normalized.slice(end + 2) };
}

function responseError(status, headers) {
  if (status === 401) return new GitHubError('AUTH', 'GitHub 登录已失效。请运行 gh auth login --hostname github.com。');
  if (status === 429 || (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')))) {
    const retryAfter = Number(headers.get('retry-after'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    const minutes = Math.ceil((retryAfter > 0 ? retryAfter : reset - Date.now() / 1000) / 60);
    const advice = minutes > 0 ? '约 ' + minutes + ' 分钟后重试。' : '请稍后重试。';
    return new GitHubError('RATE_LIMIT', 'GitHub 请求已达限额，' + advice);
  }
  if (status === 403) {
    return new GitHubError('FORBIDDEN', headers.has('x-github-sso')
      ? '组织要求为当前 GitHub CLI 登录授权 SSO。请在 GitHub 上完成组织授权后再试。'
      : 'GitHub 拒绝了此操作。请检查仓库角色、组织策略或 Issue 是否锁定。');
  }
  if (status === 404 || status === 410 || status === 451) return new GitHubError('NOT_FOUND', '仓库或 Issue 不存在、已停用，或当前账号无权访问。');
  if (status === 409 || status === 422) return new GitHubError('VALIDATION', 'GitHub 无法应用此操作。请检查标题、标签、指派人和 Issue 状态。');
  return new GitHubError('GITHUB_ERROR', 'GitHub 请求失败（HTTP ' + status + '）。');
}

function createApi(execute = runGh) {
  return async function api(path, method = 'GET', input) {
    const args = ['api', '--hostname', 'github.com', '--method', method, '--include',
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', path];
    if (input !== undefined) args.push('--input', '-');
    let execution;
    try {
      execution = await execute(args, input);
    } catch (error) {
      if (method !== 'GET' && ['TIMEOUT', 'RESPONSE_LIMIT'].includes(error.code)) throw uncertainWrite();
      throw error;
    }
    const { status, headers, body } = decodeResponse(execution.stdout);
    if (status >= 200 && status < 300) {
      try {
        return { data: body.trim() ? JSON.parse(body) : null, headers };
      } catch {
        if (method !== 'GET') throw uncertainWrite();
        throw new GitHubError('RESPONSE', 'GitHub 返回了无法读取的响应。');
      }
    }
    if (status) {
      if (method !== 'GET' && status >= 500) throw uncertainWrite();
      throw responseError(status, headers);
    }
    if (execution.code === 4) throw new GitHubError('AUTH', '请运行 gh auth login --hostname github.com，再点击「重新检测」。');
    if (method !== 'GET') throw uncertainWrite();
    throw new GitHubError('NETWORK', '无法连接 GitHub，请检查网络和 gh auth status --hostname github.com。');
  };
}

function uncertainWrite() {
  return new GitHubError('WRITE_UNCERTAIN', '无法确认 GitHub 是否已保存。请先到 GitHub 核对结果，再决定是否重试。');
}

function pagePath(path, page, params = {}) {
  rejectUnless(Number.isSafeInteger(page) && page >= 1 && page <= 100000);
  return path + '?' + new URLSearchParams({ ...params, per_page: PAGE_SIZE, page }).toString();
}

function pageResult(response, map, filter = () => true) {
  if (!Array.isArray(response.data)) throw new GitHubError('RESPONSE', 'GitHub 返回了意外的列表响应。');
  return { items: response.data.filter(filter).map(map), hasNext: /\brel="next"/.test(response.headers.get('link') || '') };
}

function clip(text, max) {
  if (typeof text !== 'string') return '';
  return text.length > max ? text.slice(0, max) + '\n…' : text;
}

function repository(item) {
  const [owner, name] = String(item.full_name || '').split('/');
  return {
    name: owner + '/' + name, owner, organization: item.owner?.type === 'Organization',
    private: Boolean(item.private), archived: Boolean(item.archived), issues: Boolean(item.has_issues) && !item.disabled,
    role: ['admin', 'maintain', 'push', 'triage', 'pull'].find(role => item.permissions?.[role]) || 'unknown',
  };
}

function label(item) {
  return { name: clip(typeof item === 'string' ? item : item?.name, 100) };
}

function isIssue(item) {
  return item && !item.pull_request && Number.isSafeInteger(item.number) && item.number > 0;
}

function issue(item, full = false) {
  if (!isIssue(item)) throw new GitHubError('NOT_ISSUE', '此编号对应的是 Pull Request，已停止操作。');
  const result = {
    number: item.number, title: clip(item.title, 500), state: item.state === 'closed' ? 'closed' : 'open',
    updated: clip(item.updated_at, 35), author: clip(item.user?.login, 100), comments: Number(item.comments) || 0,
    labels: (item.labels || []).slice(0, 40).map(label),
    assignees: (item.assignees || []).slice(0, 20).map(a => clip(a?.login, 100)),
  };
  return full ? { ...result, body: clip(item.body, 65536), locked: Boolean(item.locked) } : result;
}

function comment(item) {
  return { id: item.id, author: clip(item.user?.login, 100), created: clip(item.created_at, 35), body: clip(item.body, 3900) };
}

function bodyText(value, max, optional = false) {
  rejectUnless(typeof value === 'string' && value.length <= max && (optional || value.trim()));
  return value;
}

function listText(value, max, pattern) {
  rejectUnless(Array.isArray(value) && value.length >= 1 && value.length <= 20);
  return [...new Set(value.map(item => {
    rejectUnless(typeof item === 'string' && item.trim() && item === item.trim() && item.length <= max && !/[\x00-\x1f\x7f]/.test(item) && (!pattern || pattern.test(item)));
    return item;
  }))];
}

function createService(api = createApi()) {
  async function activeAccount() {
    const result = await api('/user');
    const { id, login } = result.data || {};
    if (!Number.isSafeInteger(id) || id <= 0 || !OWNER.test(login || '')) throw new GitHubError('RESPONSE', '无法确认当前 GitHub 账号。');
    return { id, login };
  }

  async function assertAccount(expected) {
    rejectUnless(Number.isSafeInteger(expected) && expected > 0);
    if ((await activeAccount()).id !== expected) throw new GitHubError('ACCOUNT_CHANGED', '本机 GitHub CLI 账号已切换，请重新检测后再操作。');
  }

  return async function dispatch(action, args = {}) {
    if (action === 'account') return activeAccount();
    if (action === 'repositories') {
      await assertAccount(args.accountId);
      const result = await api(pagePath('/user/repos', args.page, {
        visibility: 'all', affiliation: 'owner,collaborator,organization_member', sort: 'full_name', direction: 'asc',
      }));
      await assertAccount(args.accountId);
      return pageResult(result, repository, item => {
        const pieces = String(item?.full_name || '').split('/');
        return pieces.length === 2 && OWNER.test(pieces[0]) && REPO.test(pieces[1]);
      });
    }
    const [owner, repo, extra] = typeof args.repo === 'string' ? args.repo.split('/') : [];
    rejectUnless(OWNER.test(owner || '') && REPO.test(repo || '') && extra === undefined);
    const base = '/repos/' + owner + '/' + repo + '/issues';
    if (action === 'issues') {
      rejectUnless(['open', 'closed', 'all'].includes(args.state));
      return pageResult(await api(pagePath(base, args.page, { state: args.state, sort: 'updated', direction: 'desc' })), issueSummary, isIssue);
    }
    if (action === 'create') {
      const title = bodyText(args.title, 256).trim();
      const body = bodyText(args.body, 50000, true);
      await assertAccount(args.accountId);
      return issue((await api(base, 'POST', { title, body })).data, true);
    }
    rejectUnless(Number.isSafeInteger(args.number) && args.number >= 1);
    const target = base + '/' + args.number;
    const getIssue = async () => issue((await api(target)).data, true);
    if (action === 'issue') return getIssue();
    if (action === 'comments') {
      await assertAccount(args.accountId);
      const result = await api(pagePath(target + '/comments', args.page));
      await assertAccount(args.accountId);
      return pageResult(result, comment);
    }

    await assertAccount(args.accountId);
    const current = await getIssue();
    // The account may change while a confirmation dialog or the issue read is pending.
    await assertAccount(args.accountId);
    if (action === 'comment') {
      const body = bodyText(args.body, 50000);
      return { id: (await api(target + '/comments', 'POST', { body })).data?.id };
    }
    if (action === 'state') {
      rejectUnless(['open', 'closed'].includes(args.state));
      if (current.state === args.state) return current;
      return issue((await api(target, 'PATCH', { state: args.state })).data, true);
    }
    if (action === 'addLabels') {
      const labels = listText(args.values, 100);
      await api(target + '/labels', 'POST', { labels });
    } else if (action === 'removeLabel') {
      const [name] = listText([args.value], 100);
      // GitHub's label endpoint normalizes dot path segments. Use a guarded refresh instead.
      rejectUnless(name !== '.' && name !== '..');
      try {
        await api(target + '/labels/' + encodeURIComponent(name), 'DELETE');
      } catch (error) {
        if (error.code !== 'NOT_FOUND') throw error;
        const updated = await getIssue();
        if (updated.labels.some(item => item.name === name)) throw error;
        return updated;
      }
    } else if (action === 'addAssignees' || action === 'removeAssignees') {
      const assignees = listText(args.values, 100, /^[a-z0-9][a-z0-9\-\[\]]*$/i);
      const updated = issue((await api(target + '/assignees', action === 'addAssignees' ? 'POST' : 'DELETE', { assignees })).data, true);
      const finalList = new Set(updated.assignees.map(login => login.toLowerCase()));
      const wanted = action === 'addAssignees';
      if (assignees.some(login => finalList.has(login.toLowerCase()) !== wanted)) {
        return { ...updated, warning: 'GitHub 没有应用全部指派变更，请查看当前指派名单。' };
      }
      return updated;
    } else {
      throw new GitHubError('INVALID_INPUT', '此 Issue 操作不可用。');
    }
    try {
      return await getIssue();
    } catch {
      return { ...current, warning: '变更已提交。请刷新 Issue 查看 GitHub 上的最新状态。' };
    }
  };
}

function issueSummary(item) { return issue(item); }

module.exports = { createApi, createService, decodeResponse, GitHubError, runGh };
