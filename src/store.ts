// The forge's store: every repository, ref, object, issue and pull request,
// in memory. No clock and no randomness anywhere in here: timestamps are a
// fixed epoch plus a per-store counter, so two runs over the same requests
// behave identically.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { VIEWER } from './identity.ts';

export const FIXED_TS = '2025-02-10T08:19:57Z';
const COMMIT_EPOCH = 1_735_689_600;

export interface Label {
  readonly name: string;
  color: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  readonly comments: IssueComment[];
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface PullRequest {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  readonly baseSha: string;
  files: PullFile[];
  readonly createdSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: PullRequest[];
  nextNumber: number;
  nextCommentId: number;
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** An opaque, stable global id for a stored object. */
export function globalId(kind: string, key: string): string {
  return b64url(`${kind}:${key}`);
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const split = text.indexOf(':');
    if (split <= 0) return null;
    return { kind: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`);
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Flatten a tree (recursively) to path -> entry. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string | null): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry);
    }
  };
  walk(treeOid, '');
  return out;
}

/** The tree of a commit, or null. */
export function commitTree(objects: Map<string, GitObject>, commitOid: string): string | null {
  const object = objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Look a path up in a tree; returns the blob entry or null. */
export function lookupPath(objects: Map<string, GitObject>, treeOid: string | null, path: string): TreeEntry | null {
  if (treeOid === null) return null;
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return entry.mode === '40000' ? null : entry;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The immediate children of a directory path in a tree (null when not a dir). */
export function lookupDir(objects: Map<string, GitObject>, treeOid: string | null, dir: string): TreeEntry[] | null {
  if (treeOid === null) return null;
  const segments = dir.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const object = objects.get(current);
  if (object === undefined || object.type !== 'tree') return null;
  return parseTree(object.data);
}

export class Store {
  readonly repos = new Map<string, Repo>();
  #repoSeq = 0;
  #repoIdSeq = 5000;
  #commitSeq = 0;
  #issueIdSeq = 1;

  #key(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.#key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.getRepo(owner, name) !== undefined) return null;
    this.#repoSeq += 1;
    const repo: Repo = {
      id: this.#repoIdSeq,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.#repoSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.#repoIdSeq += 1;
    this.repos.set(this.#key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.#key(owner, name));
  }

  /** The next REST-visible numeric id (issues, comments). Stable per object. */
  nextRestId(): number {
    const id = this.#issueIdSeq;
    this.#issueIdSeq += 1;
    return id;
  }

  // -- objects ---------------------------------------------------------------

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Resolve a ref name, branch name or sha to a commit oid (null when unknown). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid ?? null;
    }
    const oid = repo.refs.get(`refs/heads/${ref}`);
    return oid ?? null;
  }

  refTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** A new commit object on `repo`, timestamped from the fixed epoch. */
  makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    this.#commitSeq += 1;
    const stamp = COMMIT_EPOCH + this.#commitSeq;
    const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
    const data = buildCommit({
      tree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: identity,
      committer: identity,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** A tree with `path` set to `blobOid` (creating directories as needed). */
  setPath(repo: Repo, treeOid: string | null, path: string, blobOid: string): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (oid: string | null, index: number): string => {
      const entries = oid === null ? [] : parseTree(repo.objects.get(oid)?.data ?? Buffer.alloc(0));
      const kept = entries.filter((entry) => entry.name !== segments[index]);
      if (index === segments.length - 1) {
        kept.push({ mode: '100644', name: segments[index] as string, oid: blobOid });
      } else {
        const child = entries.find((entry) => entry.name === segments[index] && entry.mode === '40000');
        kept.push({ mode: '40000', name: segments[index] as string, oid: build(child?.oid ?? null, index + 1) });
      }
      return this.putObject(repo, 'tree', buildTree(kept));
    };
    return build(treeOid, 0);
  }

  /** A tree with `path` removed (null when the path was absent). */
  removePath(repo: Repo, treeOid: string | null, path: string): string | null {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (oid: string | null, index: number): string | null => {
      if (oid === null) return null;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return null;
      const entries = parseTree(object.data);
      const target = entries.find((entry) => entry.name === segments[index]);
      if (target === undefined) return null;
      if (index === segments.length - 1) {
        const kept = entries.filter((entry) => entry.name !== segments[index]);
        return this.putObject(repo, 'tree', buildTree(kept));
      }
      if (target.mode !== '40000') return null;
      const child = build(target.oid, index + 1);
      if (child === null) return null;
      const kept = entries.filter((entry) => entry.name !== segments[index]);
      kept.push({ mode: '40000', name: segments[index] as string, oid: child });
      return this.putObject(repo, 'tree', buildTree(kept));
    };
    return build(treeOid, 0);
  }

  // -- contents --------------------------------------------------------------

  /**
   * Write a file through the contents API: creates the blob, the tree and the
   * commit on `branch` (creating the branch from the default tip when it does
   * not exist yet). Returns the commit and content shas plus 201 for a create
   * or 200 for an update.
   */
  commitFile(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch?: string,
  ): { commitSha: string; contentSha: string; status: 200 | 201 } {
    const targetBranch = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${targetBranch}`;
    let tip = repo.refs.get(refName) ?? null;
    let isCreate = true;
    if (tip === null && targetBranch !== repo.defaultBranch) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    const parentTree = tip === null ? null : commitTree(repo.objects, tip);
    const existing = parentTree === null ? null : lookupPath(repo.objects, parentTree, path);
    if (existing !== null) isCreate = false;
    const blobOid = this.putObject(repo, 'blob', content);
    const tree = this.setPath(repo, parentTree, path, blobOid);
    const commitSha = this.makeCommit(repo, tree, tip === null ? [] : [tip], message);
    repo.refs.set(refName, commitSha);
    return { commitSha, contentSha: blobOid, status: isCreate ? 201 : 200 };
  }

  /** Delete a file through the contents API; null when the file is absent. */
  deleteFile(repo: Repo, path: string, message: string, branch?: string): { commitSha: string } | null {
    const targetBranch = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${targetBranch}`;
    const tip = repo.refs.get(refName) ?? null;
    if (tip === null) return null;
    const parentTree = commitTree(repo.objects, tip);
    if (parentTree === null) return null;
    const tree = this.removePath(repo, parentTree, path);
    if (tree === null) return null;
    const commitSha = this.makeCommit(repo, tree, [tip], message);
    repo.refs.set(refName, commitSha);
    return { commitSha };
  }

  // -- commits ---------------------------------------------------------------

  /** Commits reachable from `tip`, newest first (first-parent order, deduped). */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      // The REST view shows the message without git's trailing newline; the
      // stored object itself keeps it, so clones stay byte-identical.
      out.push({ sha: oid, message: commit.message.replace(/\n$/, '') });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  // -- issues ----------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: repo.nextNumber,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  // -- pull requests ---------------------------------------------------------

  /** The file-level diff between two trees, with line counts. */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
    const base = flattenTree(repo.objects, baseTree);
    const head = flattenTree(repo.objects, headTree);
    const files: PullFile[] = [];
    const names = new Set([...base.keys(), ...head.keys()]);
    for (const name of [...names].sort()) {
      const from = base.get(name);
      const to = head.get(name);
      if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
      if (from === undefined && to !== undefined) {
        const data = repo.objects.get(to.oid)?.data ?? Buffer.alloc(0);
        const additions = countLines(data);
        files.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
      } else if (from !== undefined && to === undefined) {
        const data = repo.objects.get(from.oid)?.data ?? Buffer.alloc(0);
        const deletions = countLines(data);
        files.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (from !== undefined && to !== undefined) {
        const oldData = repo.objects.get(from.oid)?.data ?? Buffer.alloc(0);
        const newData = repo.objects.get(to.oid)?.data ?? Buffer.alloc(0);
        const additions = countLines(newData);
        const deletions = countLines(oldData);
        files.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | null {
    const headSha = this.refTip(repo, headRef);
    const baseSha = this.refTip(repo, baseRef);
    if (headSha === null || baseSha === null) return null;
    const headTree = commitTree(repo.objects, headSha);
    const baseTree = commitTree(repo.objects, baseSha);
    const pull: PullRequest = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      files: this.diffTrees(repo, baseTree, headTree),
      createdSeq: repo.nextNumber,
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** The merge-base of two commits (nearest common ancestor), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = collectReachable([a], (oid) => repo.objects.get(oid), true);
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    }
    return null;
  }

  /** MERGEABLE when a squash of the head onto the base tip applies cleanly. */
  mergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    const baseTip = this.refTip(repo, pull.baseRef);
    if (baseTip === null) return 'CONFLICTING';
    const headTip = this.refTip(repo, pull.headRef) ?? pull.headSha;
    const base = this.mergeBase(repo, baseTip, headTip);
    if (base === null) return 'CONFLICTING';
    const baseTree = commitTree(repo.objects, base);
    const tipTree = commitTree(repo.objects, baseTip);
    const headTree = commitTree(repo.objects, headTip);
    const baseFiles = flattenTree(repo.objects, baseTree);
    const tipFiles = flattenTree(repo.objects, tipTree);
    const headFiles = flattenTree(repo.objects, headTree);
    const names = new Set([...tipFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
    for (const name of names) {
      const atBase = baseFiles.get(name)?.oid ?? null;
      const atTip = tipFiles.get(name)?.oid ?? null;
      const atHead = headFiles.get(name)?.oid ?? null;
      const tipChanged = atTip !== atBase;
      const headChanged = atHead !== atBase;
      if (tipChanged && headChanged && atTip !== atHead) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /**
   * Squash-merge an open pull request onto its base branch. Returns the merge
   * commit sha, or null when conflicted (nothing moves).
   */
  squashMerge(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.mergeable(repo, pull) !== 'MERGEABLE') return null;
    const baseTip = this.refTip(repo, pull.baseRef);
    const headTip = this.refTip(repo, pull.headRef) ?? pull.headSha;
    if (baseTip === null) return null;
    const base = this.mergeBase(repo, baseTip, headTip);
    if (base === null) return null;
    const baseTree = commitTree(repo.objects, base);
    const tipTree = commitTree(repo.objects, baseTip);
    const headTree = commitTree(repo.objects, headTip);
    const baseFiles = flattenTree(repo.objects, baseTree);
    const tipFiles = flattenTree(repo.objects, tipTree);
    const headFiles = flattenTree(repo.objects, headTree);
    let tree = tipTree;
    const names = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    for (const name of [...names].sort()) {
      const atBase = baseFiles.get(name)?.oid ?? null;
      const atHead = headFiles.get(name)?.oid ?? null;
      if (atHead === atBase) continue;
      if (tree === null) tree = this.putObject(repo, 'tree', buildTree([]));
      if (atHead === null) {
        const next = this.removePath(repo, tree, name);
        if (next !== null) tree = next;
      } else {
        tree = this.setPath(repo, tree, name, atHead);
      }
    }
    if (tree === null) tree = this.putObject(repo, 'tree', buildTree([]));
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const mergeSha = this.makeCommit(repo, tree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_TS;
    pull.mergeCommitSha = mergeSha;
    return mergeSha;
  }

  /** True when `oid` names an object this repo holds. */
  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }
}
