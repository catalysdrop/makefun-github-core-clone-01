// GraphQL v4: a small document parser and executor covering the gh-shaped
// documents the suite sends — viewer, repository, issues, pull requests,
// the five mutations, Relay node(id:), introspection probes and batched
// operation arrays. Unknown fields are GraphQL errors (HTTP 200), never
// HTTP 400s; an unknown repository is data.repository = null with no errors.

import { VIEWER } from './identity.ts';
import {
  FIXED_TS,
  commentGlobalId,
  globalId,
  issueGlobalId,
  parseGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Lexer + parser (documents only; no schema validation beyond field checks)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      i += 1;
      continue;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1] as string;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let value = '';
      while (i < source.length && /[0-9.]/.test(source[i] as string)) {
        value += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) {
        value += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    if (char === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    tokens.push({ kind: 'punct', value: char });
    i += 1;
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; selections: SelectionNode[] };

interface Operation {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selections: SelectionNode[];
}

class ParseError extends Error {}

class Parser {
  #tokens: Token[];
  #pos = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  peek(): Token | null {
    return this.#tokens[this.#pos] ?? null;
  }

  next(): Token {
    const token = this.#tokens[this.#pos];
    if (token === undefined) throw new ParseError('Unexpected end of document');
    this.#pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new ParseError(`Expected ${value}`);
  }

  skipVariableDefinitions(): void {
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      let depth = 0;
      while (this.#pos < this.#tokens.length) {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        if (token.kind === 'punct' && token.value === ')') {
          depth -= 1;
          if (depth === 0) return;
        }
      }
      throw new ParseError('Unbalanced variable definitions');
    }
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new ParseError('Expected variable name');
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.next();
        if (name.kind !== 'name') throw new ParseError('Expected object field name');
        this.expectPunct(':');
        fields.push({ name: name.value, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new ParseError(`Unexpected token ${JSON.stringify(token)}`);
  }

  parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const name = this.next();
        if (name.kind !== 'name') throw new ParseError('Expected argument name');
        this.expectPunct(':');
        args.push({ name: name.value, value: this.parseValue() });
      }
      this.next();
    }
    return args;
  }

  parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '...') {
        const next = this.next();
        if (next.kind === 'name' && next.value === 'on') {
          const typeName = this.next();
          if (typeName.kind !== 'name') throw new ParseError('Expected type condition');
          selections.push({ kind: 'fragment', typeCondition: typeName.value, selections: this.parseSelections() });
        } else if (next.kind === 'name') {
          selections.push({ kind: 'fragment', typeCondition: null, selections: [] });
          void next;
        } else {
          throw new ParseError('Unexpected fragment spread');
        }
        continue;
      }
      if (token.kind !== 'name') throw new ParseError('Expected field name');
      let alias: string | null = null;
      let name = token.value;
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
        this.next();
        const real = this.next();
        if (real.kind !== 'name') throw new ParseError('Expected field name after alias');
        alias = name;
        name = real.value;
      }
      const args = this.parseArguments();
      let sub: SelectionNode[] = [];
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') sub = this.parseSelections();
      selections.push({ kind: 'field', field: { alias, name, args, selections: sub } });
    }
    this.next();
    return selections;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== null) {
      const token = this.next();
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') {
          name = (this.next() as { value: string }).value;
        }
        this.skipVariableDefinitions();
        operations.push({ type: token.value, name, selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragment: skip its name, type condition and body.
        this.next();
        this.next();
        this.next();
        this.parseSelections();
        continue;
      }
      if (token.kind === 'punct' && token.value === '{') {
        this.#pos -= 1;
        operations.push({ type: 'query', name: null, selections: this.parseSelections() });
        continue;
      }
      throw new ParseError(`Unexpected token ${token.kind} ${JSON.stringify(token)}`);
    }
    return operations;
  }
}

// ---------------------------------------------------------------------------
// Schema (the fields the suite introspects)
// ---------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url', 'resourcePath', 'repository', 'closedAt', 'assignees'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'url', 'resourcePath', 'repository', 'commits'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'visibility', 'forkCount', 'stargazerCount'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['id', 'name', 'target', 'prefix'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PULL_REQUEST', 'WIKI', 'APP'];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface Resolved {
  readonly typename: string;
  readonly data: unknown;
}

interface Context {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
  readonly errors: Array<{ message: string }>;
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function cursorFor(kind: string, number: number): string {
  return Buffer.from(`${kind}:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string | null | undefined, kind: string): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const [prefix, value] = text.split(':');
    if (prefix !== kind) return null;
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

function userResolved(): Resolved {
  return { typename: 'User', data: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } };
}

function repoResolved(repo: Repo): Resolved {
  return { typename: 'Repository', data: repo };
}

function issueResolved(repo: Repo, issue: Issue): Resolved {
  return { typename: 'Issue', data: { repo, issue } };
}

function pullResolved(repo: Repo, pull: PullRequest): Resolved {
  return { typename: 'PullRequest', data: { repo, pull } };
}

function connectionResolved<T>(typename: string, nodes: T[], makeNode: (item: T) => Resolved, first: number | null, afterCursor: string | null, cursorKind: string, cursorOf: (item: T) => number): Resolved {
  let items = nodes;
  if (afterCursor !== null) {
    const after = cursorNumber(afterCursor, cursorKind);
    if (after !== null) items = items.filter((item) => cursorOf(item) > after);
  }
  const hasNextPage = first !== null && items.length > first;
  const page = first === null ? items : items.slice(0, first);
  const endCursor = page.length === 0 ? null : cursorFor(cursorKind, cursorOf(page[page.length - 1] as T));
  const data = {
    nodes: page.map((item) => makeNode(item)),
    edges: page.map((item) => ({ node: makeNode(item), cursor: cursorFor(cursorKind, cursorOf(item)) })),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length === 0 ? null : cursorFor(cursorKind, cursorOf(page[0] as T)),
      endCursor,
    },
    totalCount: nodes.length,
  };
  return { typename, data };
}

function executeSelections(parent: Resolved, selections: SelectionNode[], ctx: Context): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.typename) continue;
      Object.assign(out, executeSelections(parent, selection.selections, ctx));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const value = resolveField(parent, field, ctx);
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function resolveField(parent: Resolved, field: FieldNode, ctx: Context): JsonValue | undefined {
  const args = argMap(field, ctx.variables);
  const name = field.name;
  const data = parent.data as Record<string, unknown>;

  // Meta fields.
  if (name === '__typename') return parent.typename;

  // Root.
  if (parent.typename === 'Query') {
    if (name === 'viewer') {
      const resolved = userResolved();
      return field.selections.length === 0 ? ({} as JsonValue) : (executeSelections(resolved, field.selections, ctx) as JsonValue);
    }
    if (name === 'repository') {
      const owner = args.owner as string | undefined;
      const repoName = args.name as string | undefined;
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      if (owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return null;
      const resolved = repoResolved(repo);
      return field.selections.length === 0 ? ({} as JsonValue) : (executeSelections(resolved, field.selections, ctx) as JsonValue);
    }
    if (name === 'node') {
      const id = args.id as string | undefined;
      if (typeof id !== 'string') return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      const node = resolveNode(ctx, parsed);
      if (node === null) return null;
      return field.selections.length === 0 ? ({} as JsonValue) : (executeSelections(node, field.selections, ctx) as JsonValue);
    }
    if (name === '__type') {
      const typeName = args.name as string | undefined;
      if (typeof typeName !== 'string') return null;
      return executeSelections({ typename: '__Type', data: { name: typeName } }, field.selections, ctx) as JsonValue;
    }
    if (name === '__schema') {
      return executeSelections({ typename: '__Schema', data: {} }, field.selections, ctx) as JsonValue;
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
    return null;
  }

  // Mutations.
  if (parent.typename === 'Mutation') {
    return resolveMutation(field, ctx);
  }

  // Introspection.
  if (parent.typename === '__Type') {
    const typeName = data.name as string;
    if (name === 'name') return typeName;
    if (name === 'kind') return SCHEMA_FIELDS[typeName] !== undefined ? 'OBJECT' : typeName === 'SearchType' ? 'ENUM' : null;
    if (name === 'fields') {
      const fields = SCHEMA_FIELDS[typeName] ?? [];
      return fields.map((fieldName) => executeSelections({ typename: '__Field', data: { name: fieldName } }, field.selections, ctx)) as JsonValue;
    }
    if (name === 'enumValues') {
      if (typeName !== 'SearchType') return [];
      return SEARCH_TYPE_VALUES.map((value) => executeSelections({ typename: '__EnumValue', data: { name: value } }, field.selections, ctx)) as JsonValue;
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "__Type".` });
    return null;
  }
  if (parent.typename === '__Field' || parent.typename === '__EnumValue') {
    if (name === 'name') return data.name as string;
    if (name === 'type') return { name: null, kind: 'SCALAR', ofType: null } as JsonValue;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parent.typename}".` });
    return null;
  }
  if (parent.typename === '__Schema') {
    if (name === 'queryType') return { name: 'Query' } as JsonValue;
    if (name === 'mutationType') return { name: 'Mutation' } as JsonValue;
    if (name === 'types') return [] as JsonValue;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "__Schema".` });
    return null;
  }

  // Mutation payload wrappers: createIssue.issue, closeIssue.issue,
  // createPullRequest.pullRequest, mergePullRequest.pullRequest,
  // addComment.commentEdge.node.
  if (PAYLOAD_TYPES.has(parent.typename)) {
    const payload = data as { repo: Repo; issue?: Issue; pull?: PullRequest; comment?: { id: number; body: string } };
    if (name === 'issue' && payload.issue !== undefined) {
      return executeSelections(issueResolved(payload.repo, payload.issue), field.selections, ctx) as JsonValue;
    }
    if (name === 'pullRequest' && payload.pull !== undefined) {
      return executeSelections(pullResolved(payload.repo, payload.pull), field.selections, ctx) as JsonValue;
    }
    if (name === 'commentEdge' && payload.comment !== undefined && payload.issue !== undefined) {
      const node: Resolved = { typename: 'IssueComment', data: { repo: payload.repo, issue: payload.issue, comment: payload.comment } };
      return executeSelections({ typename: 'IssueCommentEdge', data: { node } }, field.selections, ctx) as JsonValue;
    }
    if (name === 'clientMutationId') return null;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parent.typename}".` });
    return null;
  }
  if (parent.typename === 'IssueCommentEdge') {
    const edge = data as { node: Resolved };
    if (name === 'node') return executeSelections(edge.node, field.selections, ctx) as JsonValue;
    if (name === 'cursor') return cursorFor('comment', (edge.node.data as { comment: { id: number } }).comment.id);
    ctx.errors.push({ message: `Cannot query field "${name}" on type "IssueCommentEdge".` });
    return null;
  }

  // Connection wrappers and edges resolve before the field table: their
  // typenames are generated, not listed in SCHEMA_FIELDS.
  if (parent.typename.endsWith('Connection')) {
    const connection = data as { nodes: Resolved[]; edges: Array<{ node: Resolved; cursor: string }>; pageInfo: Record<string, unknown>; totalCount: number };
    if (name === 'nodes') {
      return connection.nodes.map((node) => executeSelections(node, field.selections, ctx)) as JsonValue;
    }
    if (name === 'edges') {
      return connection.edges.map((edge) => executeSelections({ typename: 'Edge', data: edge }, field.selections, ctx)) as JsonValue;
    }
    if (name === 'pageInfo') {
      return executeSelections({ typename: 'PageInfo', data: connection.pageInfo }, field.selections, ctx) as JsonValue;
    }
    if (name === 'totalCount') return connection.totalCount;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parent.typename}".` });
    return null;
  }
  if (parent.typename === 'Edge') {
    const edge = data as { node: Resolved; cursor: string };
    if (name === 'node') return executeSelections(edge.node, field.selections, ctx) as JsonValue;
    if (name === 'cursor') return edge.cursor;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Edge".` });
    return null;
  }

  // Typed objects.
  const allowed = SCHEMA_FIELDS[parent.typename] ?? [];
  if (!allowed.includes(name)) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parent.typename}".` });
    return null;
  }

  if (parent.typename === 'User') {
    if (name === 'id') return globalId('User', VIEWER.login);
    if (name === 'databaseId') return VIEWER.id;
    if (name === 'login') return VIEWER.login;
    if (name === 'name') return VIEWER.name;
    if (name === 'email') return VIEWER.email;
    if (name === 'avatarUrl') return `https://avatars.githubusercontent.invalid/u/${VIEWER.id}`;
    if (name === 'url') return `https://github.invalid/${VIEWER.login}`;
    return null;
  }

  if (parent.typename === 'Repository') {
    const repo = data as unknown as Repo;
    if (name === 'id') return repoGlobalId(repo);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') {
      const resolved = userResolved();
      return field.selections.length === 0 ? ({} as JsonValue) : (executeSelections(resolved, field.selections, ctx) as JsonValue);
    }
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return executeSelections({ typename: 'Ref', data: { name: repo.defaultBranch, oid: tip } }, field.selections, ctx) as JsonValue;
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'description') return repo.description;
    if (name === 'url') return `https://github.invalid/${repo.owner}/${repo.name}`;
    if (name === 'createdAt' || name === 'updatedAt') return FIXED_TS;
    if (name === 'isPrivate') return repo.private;
    if (name === 'visibility') return repo.private ? 'PRIVATE' : 'PUBLIC';
    if (name === 'forkCount' || name === 'stargazerCount') return 0;
    if (name === 'issue') {
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const issue = ctx.store.findIssue(repo, number);
      if (issue === undefined) return null;
      return executeSelections(issueResolved(repo, issue), field.selections, ctx) as JsonValue;
    }
    if (name === 'issues') {
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      let issues = [...repo.issues];
      if (states !== null) issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      if (orderBy?.field === 'CREATED_AT') {
        issues.sort((a, b) => (a.createdSeq - b.createdSeq) || (a.number - b.number));
        if (orderBy.direction === 'DESC') issues.reverse();
      } else {
        issues.sort((a, b) => a.number - b.number);
      }
      const first = typeof args.first === 'number' ? args.first : null;
      const after = typeof args.after === 'string' ? args.after : null;
      const connection = connectionResolved<Issue>(
        'IssueConnection',
        issues,
        (issue) => issueResolved(repo, issue),
        first,
        after,
        'issue',
        (issue) => issue.number,
      );
      return executeSelections(connection, field.selections, ctx) as JsonValue;
    }
    if (name === 'pullRequest') {
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const pull = ctx.store.findPull(repo, number);
      if (pull === undefined) return null;
      return executeSelections(pullResolved(repo, pull), field.selections, ctx) as JsonValue;
    }
    if (name === 'pullRequests') {
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let pulls = [...repo.pulls];
      if (states !== null) pulls = pulls.filter((pull) => states.includes(pull.state === 'open' ? 'OPEN' : 'CLOSED'));
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const first = typeof args.first === 'number' ? args.first : null;
      const after = typeof args.after === 'string' ? args.after : null;
      const connection = connectionResolved<PullRequest>(
        'PullRequestConnection',
        pulls,
        (pull) => pullResolved(repo, pull),
        first,
        after,
        'pull',
        (pull) => pull.number,
      );
      return executeSelections(connection, field.selections, ctx) as JsonValue;
    }
    return null;
  }

  if (parent.typename === 'Issue') {
    const { repo, issue } = data as { repo: Repo; issue: Issue };
    if (name === 'id') return issueGlobalId(repo, issue);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'createdAt' || name === 'updatedAt') return FIXED_TS;
    if (name === 'closedAt') return issue.state === 'closed' ? FIXED_TS : null;
    if (name === 'author') {
      const resolved = userResolved();
      return field.selections.length === 0 ? ({} as JsonValue) : (executeSelections(resolved, field.selections, ctx) as JsonValue);
    }
    if (name === 'url') return `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (name === 'resourcePath') return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (name === 'repository') {
      return executeSelections(repoResolved(repo), field.selections, ctx) as JsonValue;
    }
    if (name === 'labels') {
      const nodes = issue.labels.map((label) => ({ typename: 'Label', data: { name: label } }) as Resolved);
      const connection: Resolved = {
        typename: 'LabelConnection',
        data: { nodes, edges: nodes.map((node) => ({ node, cursor: cursorFor('label', 0) })), pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length },
      };
      return executeSelections(connection, field.selections, ctx) as JsonValue;
    }
    if (name === 'comments') {
      const first = typeof args.first === 'number' ? args.first : null;
      const connection = connectionResolved<{ id: number; body: string }>(
        'IssueCommentConnection',
        issue.comments,
        (comment) => ({ typename: 'IssueComment', data: { repo, issue, comment } }) as Resolved,
        first,
        null,
        'comment',
        (comment) => comment.id,
      );
      return executeSelections(connection, field.selections, ctx) as JsonValue;
    }
    if (name === 'assignees') return [] as JsonValue;
    return null;
  }

  if (parent.typename === 'PullRequest') {
    const { repo, pull } = data as { repo: Repo; pull: PullRequest };
    if (name === 'id') return pullGlobalId(repo, pull);
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'merged') return pull.merged;
    if (name === 'mergeable') return ctx.store.mergeable(repo, pull);
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'headRef') return executeSelections({ typename: 'Ref', data: { name: pull.headRef, oid: pull.headSha } }, field.selections, ctx) as JsonValue;
    if (name === 'baseRef') return executeSelections({ typename: 'Ref', data: { name: pull.baseRef, oid: pull.baseSha } }, field.selections, ctx) as JsonValue;
    if (name === 'createdAt' || name === 'updatedAt') return FIXED_TS;
    if (name === 'mergedAt') return pull.mergedAt;
    if (name === 'mergeCommit') {
      if (pull.mergeCommitSha === null) return null;
      return executeSelections({ typename: 'Commit', data: { oid: pull.mergeCommitSha } }, field.selections, ctx) as JsonValue;
    }
    if (name === 'author') {
      const resolved = userResolved();
      return field.selections.length === 0 ? ({} as JsonValue) : (executeSelections(resolved, field.selections, ctx) as JsonValue);
    }
    if (name === 'url') return `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
    if (name === 'resourcePath') return `/${repo.owner}/${repo.name}/pull/${pull.number}`;
    if (name === 'repository') {
      return executeSelections(repoResolved(repo), field.selections, ctx) as JsonValue;
    }
    if (name === 'files') {
      const first = typeof args.first === 'number' ? args.first : null;
      const nodes = pull.files.map((file) => ({ typename: 'PullRequestChangedFile', data: file }) as Resolved);
      const page = first === null ? nodes : nodes.slice(0, first);
      const connection: Resolved = {
        typename: 'PullRequestChangedFileConnection',
        data: {
          nodes: page,
          edges: page.map((node, index) => ({ node, cursor: cursorFor('file', index) })),
          pageInfo: { hasNextPage: first !== null && nodes.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: nodes.length,
        },
      };
      return executeSelections(connection, field.selections, ctx) as JsonValue;
    }
    if (name === 'commits') return { totalCount: 0, nodes: [] } as unknown as JsonValue;
    return null;
  }

  if (parent.typename === 'IssueComment') {
    const { repo, issue, comment } = data as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
    if (name === 'id') return commentGlobalId(repo, issue, comment);
    if (name === 'body') return comment.body;
    if (name === 'createdAt' || name === 'updatedAt') return FIXED_TS;
    if (name === 'url') return `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`;
    if (name === 'author') {
      const resolved = userResolved();
      return field.selections.length === 0 ? ({} as JsonValue) : (executeSelections(resolved, field.selections, ctx) as JsonValue);
    }
    return null;
  }

  if (parent.typename === 'Ref') {
    if (name === 'id') return globalId('Ref', data.name as string);
    if (name === 'name') return data.name as string;
    if (name === 'prefix') return 'refs/heads/';
    if (name === 'target') {
      return executeSelections({ typename: 'Commit', data: { oid: data.oid as string } }, field.selections, ctx) as JsonValue;
    }
    return null;
  }

  if (parent.typename === 'PullRequestChangedFile') {
    const file = data as { filename: string; additions: number; deletions: number; status: string };
    if (name === 'path') return file.filename;
    if (name === 'additions') return file.additions;
    if (name === 'deletions') return file.deletions;
    if (name === 'changeType') return file.status.toUpperCase();
    return null;
  }

  if (parent.typename === 'Commit') {
    if (name === 'oid') return data.oid as string;
    if (name === 'message') return '';
    return null;
  }

  if (parent.typename === 'Label') {
    if (name === 'name') return data.name as string;
    if (name === 'id') return globalId('Label', data.name as string);
    return null;
  }

  if (parent.typename === 'PageInfo') {
    const info = data as Record<string, unknown>;
    if (name === 'hasNextPage') return info.hasNextPage as boolean;
    if (name === 'hasPreviousPage') return info.hasPreviousPage as boolean;
    if (name === 'startCursor') return (info.startCursor as string | null) ?? null;
    if (name === 'endCursor') return (info.endCursor as string | null) ?? null;
    return null;
  }

  return null;
}

function resolveNode(ctx: Context, parsed: { kind: string; key: string }): Resolved | null {
  if (parsed.kind === 'Repository') {
    const [owner, name] = parsed.key.split('/');
    if (owner === undefined || name === undefined) return null;
    const repo = ctx.store.getRepo(owner, name);
    return repo === undefined ? null : repoResolved(repo);
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const match = parsed.key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (match === null) return null;
    const [, owner, name, numberText] = match;
    const repo = ctx.store.getRepo(owner as string, name as string);
    if (repo === undefined) return null;
    const number = Number(numberText);
    if (parsed.kind === 'Issue') {
      const issue = ctx.store.findIssue(repo, number);
      return issue === undefined ? null : issueResolved(repo, issue);
    }
    const pull = ctx.store.findPull(repo, number);
    return pull === undefined ? null : pullResolved(repo, pull);
  }
  if (parsed.kind === 'IssueComment') {
    const match = parsed.key.match(/^([^/]+)\/([^#]+)#(\d+):(\d+)$/);
    if (match === null) return null;
    const [, owner, name, numberText, commentText] = match;
    const repo = ctx.store.getRepo(owner as string, name as string);
    if (repo === undefined) return null;
    const issue = ctx.store.findIssue(repo, Number(numberText));
    if (issue === undefined) return null;
    const comment = issue.comments.find((entry) => entry.id === Number(commentText));
    if (comment === undefined) return null;
    return { typename: 'IssueComment', data: { repo, issue, comment } };
  }
  return null;
}

function resolveMutation(field: FieldNode, ctx: Context): JsonValue | undefined {
  const args = argMap(field, ctx.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const name = field.name;

  if (name === 'createIssue') {
    const repositoryId = input.repositoryId as string | undefined;
    const title = input.title as string | undefined;
    if (typeof repositoryId !== 'string' || typeof title !== 'string') {
      ctx.errors.push({ message: 'createIssue requires input.repositoryId and input.title.' });
      return null;
    }
    const parsed = parseGlobalId(repositoryId);
    if (parsed === null || parsed.kind !== 'Repository') {
      ctx.errors.push({ message: 'createIssue input.repositoryId is not a repository id.' });
      return null;
    }
    const [owner, repoName] = parsed.key.split('/');
    const repo = owner !== undefined && repoName !== undefined ? ctx.store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'createIssue input.repositoryId names an unknown repository.' });
      return null;
    }
    const issue = ctx.store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
    return executeSelections({ typename: 'CreateIssuePayload', data: { repo, issue } }, field.selections, ctx) as JsonValue;
  }

  if (name === 'closeIssue') {
    const issueId = input.issueId as string | undefined;
    if (typeof issueId !== 'string') {
      ctx.errors.push({ message: 'closeIssue requires input.issueId.' });
      return null;
    }
    const parsed = parseGlobalId(issueId);
    const node = parsed === null ? null : resolveNode(ctx, parsed);
    if (node === null || node.typename !== 'Issue') {
      ctx.errors.push({ message: 'closeIssue input.issueId is not an issue id.' });
      return null;
    }
    const { repo, issue } = node.data as { repo: Repo; issue: Issue };
    issue.state = 'closed';
    return executeSelections({ typename: 'CloseIssuePayload', data: { repo, issue } }, field.selections, ctx) as JsonValue;
  }

  if (name === 'createPullRequest') {
    const repositoryId = input.repositoryId as string | undefined;
    const headRefName = input.headRefName as string | undefined;
    const baseRefName = input.baseRefName as string | undefined;
    const title = input.title as string | undefined;
    if (typeof repositoryId !== 'string' || typeof headRefName !== 'string' || typeof baseRefName !== 'string' || typeof title !== 'string') {
      ctx.errors.push({ message: 'createPullRequest requires input.repositoryId, headRefName, baseRefName and title.' });
      return null;
    }
    const parsed = parseGlobalId(repositoryId);
    if (parsed === null || parsed.kind !== 'Repository') {
      ctx.errors.push({ message: 'createPullRequest input.repositoryId is not a repository id.' });
      return null;
    }
    const [owner, repoName] = parsed.key.split('/');
    const repo = owner !== undefined && repoName !== undefined ? ctx.store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'createPullRequest input.repositoryId names an unknown repository.' });
      return null;
    }
    const pull = ctx.store.createPull(repo, title, typeof input.body === 'string' ? input.body : '', headRefName, baseRefName);
    if (pull === null) {
      ctx.errors.push({ message: 'createPullRequest head or base branch does not exist.' });
      return null;
    }
    return executeSelections({ typename: 'CreatePullRequestPayload', data: { repo, pull } }, field.selections, ctx) as JsonValue;
  }

  if (name === 'mergePullRequest') {
    const pullRequestId = input.pullRequestId as string | undefined;
    if (typeof pullRequestId !== 'string') {
      ctx.errors.push({ message: 'mergePullRequest requires input.pullRequestId.' });
      return null;
    }
    const parsed = parseGlobalId(pullRequestId);
    const node = parsed === null ? null : resolveNode(ctx, parsed);
    if (node === null || node.typename !== 'PullRequest') {
      ctx.errors.push({ message: 'mergePullRequest input.pullRequestId is not a pull request id.' });
      return null;
    }
    const { repo, pull } = node.data as { repo: Repo; pull: PullRequest };
    if (pull.state === 'open' && !pull.merged && ctx.store.mergeable(repo, pull) === 'MERGEABLE') {
      ctx.store.squashMerge(repo, pull);
    }
    return executeSelections({ typename: 'MergePullRequestPayload', data: { repo, pull } }, field.selections, ctx) as JsonValue;
  }

  if (name === 'addComment') {
    const subjectId = input.subjectId as string | undefined;
    const body = input.body as string | undefined;
    if (typeof subjectId !== 'string' || typeof body !== 'string') {
      ctx.errors.push({ message: 'addComment requires input.subjectId and input.body.' });
      return null;
    }
    const parsed = parseGlobalId(subjectId);
    const node = parsed === null ? null : resolveNode(ctx, parsed);
    if (node === null || node.typename !== 'Issue') {
      ctx.errors.push({ message: 'addComment input.subjectId is not an issue id.' });
      return null;
    }
    const { repo, issue } = node.data as { repo: Repo; issue: Issue };
    const comment = { id: repo.nextCommentId, body };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return executeSelections(
      { typename: 'AddCommentPayload', data: { repo, issue, comment } },
      field.selections,
      ctx,
    ) as JsonValue;
  }

  ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
  return null;
}

// The payload wrapper typenames resolveMutation builds.
const PAYLOAD_TYPES = new Set(['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']);

function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Context = { store, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: Resolved = { typename: rootType, data: {} };
  const data = executeSelections(root, operation.selections, ctx);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors.map((error) => ({ message: error.message }));
  return out;
}

export function handleGraphql(store: Store, body: Buffer | null): { status: number; body: Buffer } {
  if (body === null || body.length === 0) {
    return { status: 400, body: Buffer.from(JSON.stringify({ errors: [{ message: 'Request body must be a JSON object or array.' }] }), 'utf8') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: Buffer.from(JSON.stringify({ errors: [{ message: 'Request body is not valid JSON.' }] }), 'utf8') };
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const results: Array<Record<string, unknown>> = [];
  for (const entry of operations) {
    if (entry === null || typeof entry !== 'object' || typeof (entry as { query?: unknown }).query !== 'string') {
      results.push({ errors: [{ message: 'Each operation must carry a query string.' }] });
      continue;
    }
    const query = (entry as { query: string }).query;
    const variables = ((entry as { variables?: unknown }).variables ?? {}) as Record<string, unknown>;
    let document: Operation[];
    try {
      document = new Parser(lex(query)).parseDocument();
    } catch (err) {
      results.push({ errors: [{ message: `GraphQL parse error: ${(err as Error).message}` }] });
      continue;
    }
    if (document.length === 0) {
      results.push({ errors: [{ message: 'Document contains no operations.' }] });
      continue;
    }
    const operation = document[0] as Operation;
    results.push(executeOperation(store, operation, variables));
  }
  const responseBody = Array.isArray(parsed) ? results : (results[0] as Record<string, unknown>);
  return { status: 200, body: Buffer.from(JSON.stringify(responseBody), 'utf8') };
}
