// REST v3 (the GitHub API surface the suite exercises): repositories,
// branches, commits, contents, issues and pull requests, all on the same
// store the git server, GraphQL and MCP layers read.

import { isOid } from './gitcore.ts';
import { VIEWER } from './identity.ts';
import {
  FIXED_TS,
  commitTree,
  globalId,
  lookupDir,
  lookupPath,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly host: string;
  readonly body: Buffer | null;
}

export interface RestResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly extraHeaders?: Record<string, string>;
}

export const SCOPES_HEADER = 'repo,user';

const LABEL_COLORS: Record<string, string> = {
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  documentation: '0075ca',
  question: 'd876e3',
  'good first issue': '7057ff',
  'help wanted': '008672',
};

export const SEED_LABELS = Object.keys(LABEL_COLORS);

function json(status: number, value: unknown, extraHeaders?: Record<string, string>): RestResponse {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'),
    extraHeaders,
  };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

function notFound(message = 'Not Found'): RestResponse {
  return err(404, message);
}

function parseJsonBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: RestResponse } {
  if (req.body === null || req.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(req.body.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, response: err(400, 'Problems parsing JSON') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: err(400, 'Problems parsing JSON') };
  }
}

function stringField(value: Record<string, unknown>, field: string): string | null {
  const raw = value[field];
  return typeof raw === 'string' ? raw : null;
}

function boolField(value: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const raw = value[field];
  return typeof raw === 'boolean' ? raw : fallback;
}

// -- shapes ------------------------------------------------------------------

function userShape(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.login),
    avatar_url: `https://avatars.githubusercontent.invalid/u/${VIEWER.id}`,
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.invalid/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, id: VIEWER.id, node_id: globalId('User', repo.owner), type: 'User', site_admin: false },
    html_url: `https://github.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    pushed_at: FIXED_TS,
    git_url: `git://github.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelShape(name: string, color?: string): Record<string, unknown> {
  return {
    id: 1000 + SEED_LABELS.indexOf(name),
    node_id: globalId('Label', name),
    url: `/api/v3/labels/${encodeURIComponent(name)}`,
    name,
    color: color ?? LABEL_COLORS[name] ?? '000000',
    default: true,
    description: '',
  };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: 100000 + issue.number,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.login), type: 'User', site_admin: false },
    labels: issue.labels.map((name) => labelShape(name, repo.labels.get(name)?.color)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: issue.state === 'closed' ? FIXED_TS : null,
    author_association: 'OWNER',
    body: issue.body,
    reactions: { url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: '',
    performed_via_github_app: null,
    state_reason: null,
  };
}

function pullShape(repo: Repo, pull: PullRequest, mergeable: 'MERGEABLE' | 'CONFLICTING'): Record<string, unknown> {
  return {
    id: 200000 + pull.number,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.login), type: 'User', site_admin: false },
    body: pull.body,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: pull.state === 'closed' ? FIXED_TS : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`,
    review_comment_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${pull.headSha}/statuses`,
    head: { label: `${VIEWER.login}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: { login: VIEWER.login, id: VIEWER.id }, repo: repoShape(repo) },
    base: { label: `${VIEWER.login}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: { login: VIEWER.login, id: VIEWER.id }, repo: repoShape(repo) },
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: mergeable === 'MERGEABLE',
    rebaseable: true,
    mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : 'dirty',
    merged_by: pull.merged ? { login: VIEWER.login, id: VIEWER.id } : null,
  };
}

function commentShape(repo: Repo, issue: Issue, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: 300000 + comment.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.login), type: 'User', site_admin: false },
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

// -- pagination ---------------------------------------------------------------

interface Page {
  readonly perPage: number;
  readonly page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], page: Page, req: RestRequest): { items: T[]; link: string | null } {
  const total = items.length;
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const totalPages = Math.max(1, Math.ceil(total / page.perPage));
  if (totalPages <= 1) return { items: slice, link: null };
  const base = `http://${req.host}${req.path}`;
  const links: string[] = [];
  const make = (pageNumber: number, rel: string): string => `<${base}?per_page=${page.perPage}&page=${pageNumber}>; rel="${rel}"`;
  if (page.page < totalPages) links.push(make(page.page + 1, 'next'), make(totalPages, 'last'));
  if (page.page > 1) links.push(make(1, 'first'), make(page.page - 1, 'prev'));
  return { items: slice, link: links.join(', ') };
}

function jsonPage(status: number, items: unknown[], link: string | null): RestResponse {
  return json(status, items, link === null ? undefined : { link });
}

// -- routing ------------------------------------------------------------------

function repoOf(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

export function handleRest(store: Store, req: RestRequest): RestResponse {
  const path = req.path.replace(/\/+$/, '') || '/';
  const segments = path.split('/').filter((segment) => segment !== '');

  // GET /api/v3/ and /api/v3/meta
  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    return json(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.invalid/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}',
      commit_search_url: '/api/v3/search/commits?q={query}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/other_user}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}',
      notifications_url: '/api/v3/notifications',
      organization_repositories_url: '/api/v3/orgs/{org}/repos',
      organization_url: '/api/v3/orgs/{org}',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}',
      current_user_repositories_url: '/api/v3/user/repos',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/repos',
      user_search_url: '/api/v3/search/users?q={query}',
    });
  }
  if (req.method === 'GET' && path === '/api/v3/meta') {
    return json(200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
  }
  if (segments[0] !== 'api' || segments[1] !== 'v3') return notFound();

  // GET /api/v3/user and /api/v3/user/repos
  if (segments[2] === 'user' && segments.length === 3) {
    if (req.method === 'GET') return json(200, userShape());
    return err(405, 'Method Not Allowed');
  }
  if (segments[2] === 'user' && segments[3] === 'repos') {
    if (req.method === 'GET') {
      const { items, link } = paginate(store.listRepos(VIEWER.login).map((repo) => repoShape(repo)), pageOf(req.query), req);
      return jsonPage(200, items, link);
    }
    if (req.method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const name = stringField(parsed.value, 'name');
      if (name === null || name === '') return err(422, 'Validation Failed: name is required');
      if (store.getRepo(VIEWER.login, name) !== undefined) return err(422, 'Validation Failed: name already exists on this account');
      const repo = store.createRepo(VIEWER.login, name, stringField(parsed.value, 'description') ?? '', boolField(parsed.value, 'private', false));
      if (repo === null) return err(422, 'Validation Failed: name already exists on this account');
      for (const label of SEED_LABELS) repo.labels.set(label, { name: label, color: LABEL_COLORS[label] as string });
      return json(201, repoShape(repo));
    }
    return err(405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{name}/...
  if (segments[2] === 'repos' && segments.length >= 5) {
    const owner = decodeURIComponent(segments[3] as string);
    const name = decodeURIComponent(segments[4] as string);
    const repo = repoOf(store, owner, name);
    if (repo === null) return notFound();
    const rest = segments.slice(5);

    if (rest.length === 0) {
      if (req.method === 'GET') return json(200, repoShape(repo));
      if (req.method === 'PATCH') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const description = stringField(parsed.value, 'description');
        if (description !== null) repo.description = description;
        return json(200, repoShape(repo));
      }
      if (req.method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
      }
      return err(405, 'Method Not Allowed');
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && req.method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(ref), url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(ref)}` },
            protected: false,
          }));
        return json(200, branches);
      }
      if (rest.length === 2 && req.method === 'GET') {
        const branch = decodeURIComponent(rest[1] as string);
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return notFound();
        return json(200, {
          name: branch,
          commit: { sha: tip, url: `/api/v3/repos/${owner}/${name}/commits/${tip}` },
          protected: false,
        });
      }
      return err(405, 'Method Not Allowed');
    }

    if (rest[0] === 'commits') {
      if (rest.length === 1 && req.method === 'GET') {
        const sha = req.query.get('sha');
        const tip = sha === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null : store.resolveRef(repo, sha);
        if (tip === null) return json(200, []);
        const commits = store.listCommits(repo, tip).map((entry) => {
          const object = repo.objects.get(entry.sha);
          const message = entry.message;
          return {
            sha: entry.sha,
            node_id: globalId('Commit', entry.sha),
            commit: {
              author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TS },
              committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TS },
              message,
              tree: { sha: object !== undefined && object.type === 'commit' ? commitTree(repo.objects, entry.sha) : null },
              url: `/api/v3/repos/${owner}/${name}/commits/${entry.sha}`,
              comment_count: 0,
              verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
            },
            url: `/api/v3/repos/${owner}/${name}/commits/${entry.sha}`,
            html_url: `https://github.invalid/${owner}/${name}/commit/${entry.sha}`,
            comments_url: `/api/v3/repos/${owner}/${name}/commits/${entry.sha}/comments`,
            author: { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.login), type: 'User', site_admin: false },
            committer: { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.login), type: 'User', site_admin: false },
            parents: [],
          };
        });
        return json(200, commits);
      }
      return err(405, 'Method Not Allowed');
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && req.method === 'POST') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const ref = stringField(parsed.value, 'ref');
        const sha = stringField(parsed.value, 'sha');
        if (ref === null || sha === null || !isOid(sha)) return err(422, 'Validation Failed');
        if (!ref.startsWith('refs/heads/')) return err(422, 'Validation Failed: ref must start with refs/heads/');
        if (!repo.objects.has(sha)) return err(422, 'Validation Failed: sha does not exist');
        if (repo.refs.has(ref)) return err(422, 'Validation Failed: Reference already exists');
        repo.refs.set(ref, sha);
        return json(201, { ref, node_id: globalId('Ref', ref), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
      }
      if (rest.length >= 4 && req.method === 'GET') {
        const ref = decodeURIComponent(rest.slice(2).join('/'));
        const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
        const oid = repo.refs.get(fullRef);
        if (oid === undefined) return notFound();
        return json(200, { ref: fullRef, node_id: globalId('Ref', fullRef), url: `/api/v3/repos/${owner}/${name}/git/refs/${fullRef.slice(5)}`, object: { sha: oid, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${oid}` } });
      }
      return err(405, 'Method Not Allowed');
    }

    if (rest[0] === 'contents') {
      const rawPath = rest.slice(1).join('/');
      const contentPath = decodeURIComponent(rawPath);
      const queryBranch = req.query.get('ref') ?? undefined;
      if (req.method === 'GET') {
        const branch = queryBranch;
        const tip = branch === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null : store.resolveRef(repo, branch);
        if (tip === null) return notFound();
        const tree = commitTree(repo.objects, tip);
        const entry = lookupPath(repo.objects, tree, contentPath);
        if (entry !== null) {
          const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: contentPath.split('/').pop() ?? contentPath,
            path: contentPath,
            content: data.toString('base64'),
            sha: entry.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${entry.oid}`,
            html_url: `https://github.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${contentPath}`,
            download_url: null,
            _links: { git: `/api/v3/repos/${owner}/${name}/git/blobs/${entry.oid}`, self: `/api/v3/repos/${owner}/${name}/contents/${contentPath}`, html: `https://github.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${contentPath}` },
          });
        }
        const dir = lookupDir(repo.objects, tree, contentPath);
        if (dir !== null) {
          return json(200, dir.map((child) => ({
            type: child.mode === '40000' ? 'dir' : 'file',
            size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
            name: child.name,
            path: `${contentPath}/${child.name}`,
            sha: child.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}/${child.name}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/${child.mode === '40000' ? 'trees' : 'blobs'}/${child.oid}`,
            html_url: `https://github.invalid/${owner}/${name}/${child.mode === '40000' ? 'tree' : 'blob'}/${repo.defaultBranch}/${contentPath}/${child.name}`,
            download_url: null,
            _links: { git: `/api/v3/repos/${owner}/${name}/git/${child.mode === '40000' ? 'trees' : 'blobs'}/${child.oid}`, self: `/api/v3/repos/${owner}/${name}/contents/${contentPath}/${child.name}`, html: '' },
          })));
        }
        return notFound();
      }
      if (req.method === 'PUT') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const message = stringField(parsed.value, 'message') ?? 'Update file';
        const contentB64 = stringField(parsed.value, 'content');
        if (contentB64 === null) return err(422, 'Validation Failed: content is required');
        const content = Buffer.from(contentB64, 'base64');
        const sha = stringField(parsed.value, 'sha');
        const branch = stringField(parsed.value, 'branch') ?? queryBranch;
        const tip = branch === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null : store.resolveRef(repo, branch);
        if (tip !== null) {
          const tree = commitTree(repo.objects, tip);
          const existing = lookupPath(repo.objects, tree, contentPath);
          if (sha !== null) {
            if (existing === null || existing.oid !== sha) return err(409, 'Conflict: sha does not match the current file');
          }
        } else if (sha !== null) {
          return err(409, 'Conflict: sha does not match the current file');
        }
        const result = store.commitFile(repo, contentPath, content, message, branch);
        return json(result.status, {
          content: {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: contentPath.split('/').pop() ?? contentPath,
            path: contentPath,
            content: content.toString('base64'),
            sha: result.contentSha,
            url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${result.contentSha}`,
            html_url: `https://github.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${contentPath}`,
            download_url: null,
            _links: {},
          },
          commit: { sha: result.commitSha, node_id: globalId('Commit', result.commitSha), message, author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TS }, committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TS } },
        });
      }
      if (req.method === 'DELETE') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const message = stringField(parsed.value, 'message') ?? 'Delete file';
        const sha = stringField(parsed.value, 'sha');
        const branch = stringField(parsed.value, 'branch') ?? queryBranch;
        const tip = branch === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null : store.resolveRef(repo, branch);
        if (tip === null) return notFound();
        const tree = commitTree(repo.objects, tip);
        const existing = lookupPath(repo.objects, tree, contentPath);
        if (existing === null) return notFound();
        if (sha !== null && existing.oid !== sha) return err(409, 'Conflict: sha does not match the current file');
        const result = store.deleteFile(repo, contentPath, message, branch);
        if (result === null) return notFound();
        return json(200, { commit: { sha: result.commitSha, node_id: globalId('Commit', result.commitSha), message, author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TS }, committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TS } } });
      }
      return err(405, 'Method Not Allowed');
    }

    if (rest[0] === 'labels' && rest.length === 1) {
      if (req.method === 'GET') {
        return json(200, [...repo.labels.keys()].map((name) => labelShape(name, repo.labels.get(name)?.color)));
      }
      if (req.method === 'POST') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const name = stringField(parsed.value, 'name');
        if (name === null || name === '') return err(422, 'Validation Failed: name is required');
        const color = stringField(parsed.value, 'color');
        // Upsert: creating a label that already exists still answers 201.
        repo.labels.set(name, { name, color: color ?? LABEL_COLORS[name] ?? '000000' });
        return json(201, labelShape(name, repo.labels.get(name)?.color));
      }
      return err(405, 'Method Not Allowed');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (req.method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          const compare = sort === 'created'
            ? (a: Issue, b: Issue): number => (a.createdSeq - b.createdSeq) || (a.number - b.number)
            : (a: Issue, b: Issue): number => a.number - b.number;
          issues.sort((a, b) => (direction === 'asc' ? compare(a, b) : -compare(a, b)));
          const { items, link } = paginate(issues.map((issue) => issueShape(repo, issue)), pageOf(req.query), req);
          return jsonPage(200, items, link);
        }
        if (req.method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return parsed.response;
          const title = stringField(parsed.value, 'title');
          if (title === null || title === '') return err(422, 'Validation Failed: title is required');
          const body = stringField(parsed.value, 'body') ?? '';
          const labelsRaw = parsed.value.labels;
          const labels: string[] = Array.isArray(labelsRaw) ? labelsRaw.filter((label): label is string => typeof label === 'string') : [];
          const unknown = labels.filter((label) => !repo.labels.has(label));
          if (unknown.length > 0) return err(422, `Validation Failed: unknown label '${unknown[0]}'`);
          const issue = store.createIssue(repo, title, body, labels);
          return json(201, issueShape(repo, issue));
        }
        return err(405, 'Method Not Allowed');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number <= 0) return notFound();
      const issue = store.findIssue(repo, number);
      if (issue === undefined) return notFound();
      if (rest.length === 2) {
        if (req.method === 'GET') return json(200, issueShape(repo, issue));
        if (req.method === 'PATCH') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return parsed.response;
          const title = stringField(parsed.value, 'title');
          if (title !== null) issue.title = title;
          const body = stringField(parsed.value, 'body');
          if (body !== null) issue.body = body;
          const state = stringField(parsed.value, 'state');
          if (state === 'open' || state === 'closed') issue.state = state;
          const labelsRaw = parsed.value.labels;
          if (Array.isArray(labelsRaw)) {
            const labels = labelsRaw.filter((label): label is string => typeof label === 'string');
            const unknown = labels.filter((label) => !repo.labels.has(label));
            if (unknown.length > 0) return err(422, `Validation Failed: unknown label '${unknown[0]}'`);
            issue.labels = labels;
          }
          return json(200, issueShape(repo, issue));
        }
        return err(405, 'Method Not Allowed');
      }
      if (rest[2] === 'comments') {
        if (rest.length === 3 && req.method === 'GET') {
          return json(200, issue.comments.map((comment) => commentShape(repo, issue, comment)));
        }
        if (rest.length === 3 && req.method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return parsed.response;
          const body = stringField(parsed.value, 'body');
          if (body === null || body === '') return err(422, 'Validation Failed: body is required');
          const comment = { id: repo.nextCommentId, body };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          return json(201, commentShape(repo, issue, comment));
        }
        return err(405, 'Method Not Allowed');
      }
      return notFound();
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (req.method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.createdSeq - a.createdSeq);
          const { items, link } = paginate(pulls.map((pull) => pullShape(repo, pull, store.mergeable(repo, pull))), pageOf(req.query), req);
          return jsonPage(200, items, link);
        }
        if (req.method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return parsed.response;
          const title = stringField(parsed.value, 'title');
          const head = stringField(parsed.value, 'head');
          const base = stringField(parsed.value, 'base');
          if (title === null || head === null || base === null) return err(422, 'Validation Failed: title, head and base are required');
          if (store.refTip(repo, head) === null || store.refTip(repo, base) === null) {
            return err(422, 'Validation Failed: head or base branch does not exist');
          }
          const body = stringField(parsed.value, 'body') ?? '';
          const pull = store.createPull(repo, title, body, head, base);
          if (pull === null) return err(422, 'Validation Failed: head or base branch does not exist');
          return json(201, pullShape(repo, pull, store.mergeable(repo, pull)));
        }
        return err(405, 'Method Not Allowed');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number <= 0) return notFound();
      const pull = store.findPull(repo, number);
      if (pull === undefined) return notFound();
      if (rest.length === 2 && req.method === 'GET') {
        return json(200, pullShape(repo, pull, store.mergeable(repo, pull)));
      }
      if (rest.length === 3 && rest[2] === 'files' && req.method === 'GET') {
        return json(200, pull.files.map((file) => ({
          sha: '',
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
          patch: '',
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && req.method === 'PUT') {
        if (pull.state !== 'open' || pull.merged) return err(404, 'Not Found');
        const mergeable = store.mergeable(repo, pull);
        if (mergeable !== 'MERGEABLE') return err(405, 'Merge conflict: the pull request cannot be merged');
        const mergeSha = store.squashMerge(repo, pull);
        if (mergeSha === null) return err(405, 'Merge conflict: the pull request cannot be merged');
        return json(200, { merged: true, sha: mergeSha, message: `Pull request #${pull.number} successfully merged` });
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}
