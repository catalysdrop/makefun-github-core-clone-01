// MCP (Model Context Protocol), modern era 2026-07-28: `server/discover`
// first, then `tools/list` / `tools/call` over plain JSON-RPC 2.0. The six
// required tools act on the same store as REST and GraphQL, so a tool-made
// issue is visible over REST immediately.

import { VIEWER } from './identity.ts';
import { FIXED_TS, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
]);

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: 200000 + pull.number,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; isError?: boolean };

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

/** The first argument value found under any of these names. */
function pick(args: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function pickString(args: Record<string, unknown>, names: readonly string[]): string | undefined {
  const value = pick(args, names);
  return typeof value === 'string' ? value : undefined;
}

function pickNumber(args: Record<string, unknown>, names: readonly string[]): number | undefined {
  const value = pick(args, names);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const owner = pickString(args, ['owner', 'owner_login', 'org', 'user', 'login', 'account', 'namespace', 'owner_name']) ?? VIEWER.login;
  const repoName = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'project']);
  const fullName = pickString(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  const resolvedRepoName = repoName ?? (fullName !== undefined && fullName.includes('/') ? fullName.split('/')[1] : undefined);

  if (name === 'create_repo') {
    const repoNameArg = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
    if (repoNameArg === undefined || repoNameArg === '') return errorResult('Missing required argument: name');
    const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
    const isPrivate = pick(args, ['private', 'is_private']) === true;
    const repo = store.createRepo(VIEWER.login, repoNameArg, description, isPrivate);
    if (repo === null) return errorResult(`Repository ${VIEWER.login}/${repoNameArg} already exists`);
    for (const label of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
      repo.labels.set(label, { name: label, color: '000000' });
    }
    return okResult(repoJson(repo));
  }

  if (resolvedRepoName === undefined) return errorResult('Missing required argument: repo');
  if (owner !== VIEWER.login) return errorResult(`Repository ${owner}/${resolvedRepoName} not found`);
  const repo = store.getRepo(owner, resolvedRepoName);
  if (repo === undefined) return errorResult(`Repository ${owner}/${resolvedRepoName} not found`);

  if (name === 'get_repo') return okResult(repoJson(repo));

  if (name === 'create_issue') {
    const title = pickString(args, ['title', 'issue_title', 'subject']);
    if (title === undefined || title === '') return errorResult('Missing required argument: title');
    const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
    const issue = store.createIssue(repo, title, body, []);
    return okResult(issueJson(repo, issue));
  }

  if (name === 'list_issues') {
    const state = pickString(args, ['state', 'status']) ?? 'open';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    const list = issues.map((issue) => issueJson(repo, issue));
    return okResult(list);
  }

  if (name === 'create_pull_request') {
    const title = pickString(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
    const head = pickString(args, ['head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from', 'branch']);
    const base = pickString(args, ['base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into']);
    if (title === undefined || title === '') return errorResult('Missing required argument: title');
    if (head === undefined || head === '') return errorResult('Missing required argument: head');
    if (base === undefined || base === '') return errorResult('Missing required argument: base');
    const body = pickString(args, ['body', 'description', 'content', 'text']) ?? '';
    const pull = store.createPull(repo, title, body, head, base);
    if (pull === null) return errorResult(`Head branch ${head} or base branch ${base} does not exist`);
    return okResult(pullJson(repo, pull));
  }

  if (name === 'merge_pull_request') {
    const number = pickNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
    if (number === undefined) return errorResult('Missing required argument: pull_number');
    const pull = store.findPull(repo, number);
    if (pull === undefined) return errorResult(`Pull request #${number} not found`);
    if (pull.state !== 'open' || pull.merged) return errorResult(`Pull request #${number} is not open`);
    if (store.mergeable(repo, pull) !== 'MERGEABLE') return errorResult(`Pull request #${number} has a merge conflict`);
    const sha = store.squashMerge(repo, pull);
    if (sha === null) return errorResult(`Pull request #${number} could not be merged`);
    return okResult({ merged: true, number, sha, state: 'closed' });
  }

  return errorResult(`Unknown tool: ${name}`);
}

const KNOWN_TOOLS = new Set(TOOLS.map((tool) => tool.name));

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

export function handleMcp(store: Store, body: Buffer | null): { status: number; body: Buffer; contentType: string } {
  const contentType = 'application/json; charset=utf-8';
  if (body === null || body.length === 0) {
    return { status: 400, body: Buffer.from(JSON.stringify(rpcError(null, -32700, 'Parse error: empty request body')), 'utf8'), contentType };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: Buffer.from(JSON.stringify(rpcError(null, -32700, 'Parse error: request body is not valid JSON')), 'utf8'), contentType };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: Buffer.from(JSON.stringify(rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object')), 'utf8'), contentType };
  }
  const request = parsed as { id?: unknown; method?: unknown; params?: unknown };
  const id = 'id' in request ? request.id : undefined;
  const method = request.method;
  if (typeof method !== 'string') {
    if (id === undefined) return { status: 202, body: Buffer.alloc(0), contentType };
    return { status: 200, body: Buffer.from(JSON.stringify(rpcError(id, -32600, 'Invalid Request: method is required')), 'utf8'), contentType };
  }
  // Notifications carry no id and expect no answer.
  if (id === undefined) {
    return { status: 202, body: Buffer.alloc(0), contentType };
  }
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return {
      status: 200,
      body: Buffer.from(JSON.stringify(rpcResult(id, {
        protocolVersion: '2026-07-28',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      })), 'utf8'),
      contentType,
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: Buffer.from(JSON.stringify(rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      })), 'utf8'),
      contentType,
    };
  }
  if (method === 'ping') {
    return { status: 200, body: Buffer.from(JSON.stringify(rpcResult(id, {})), 'utf8'), contentType };
  }
  if (method === 'tools/list') {
    return {
      status: 200,
      body: Buffer.from(JSON.stringify(rpcResult(id, { tools: TOOLS })), 'utf8'),
      contentType,
    };
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof toolName !== 'string' || toolName === '') {
      return { status: 200, body: Buffer.from(JSON.stringify(rpcError(id, -32602, 'Invalid params: tools/call requires a tool name')), 'utf8'), contentType };
    }
    if (!KNOWN_TOOLS.has(toolName)) {
      return { status: 200, body: Buffer.from(JSON.stringify(rpcError(id, -32602, `Unknown tool: ${toolName}`)), 'utf8'), contentType };
    }
    const result = callTool(store, toolName, args);
    return { status: 200, body: Buffer.from(JSON.stringify(rpcResult(id, result)), 'utf8'), contentType };
  }
  return { status: 200, body: Buffer.from(JSON.stringify(rpcError(id, -32601, `Method not found: ${method}`)), 'utf8'), contentType };
}
