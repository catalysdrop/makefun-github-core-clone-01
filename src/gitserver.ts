// Git smart HTTP: info/refs advertisements, upload-pack (v2 and v0) and
// receive-pack (v0). Packs carry whole objects only — no deltas — which the
// suite accepts: every object it needs is addressed by hash, and a pack with
// zero deltas still verifies byte for byte.

import { createHash } from 'node:crypto';

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  decodePktLinesPrefix,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitcore.ts';
import { VIEWER } from './identity.ts';
import { commitTree, flattenTree, type Repo, type Store } from './store.ts';

const AGENT = 'github-core-clone/1.0.0';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function json404(message = 'Not Found'): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function lookup(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
  readonly symrefTarget?: string;
}

/** Every advertised ref of a repo, HEAD first, then heads, then tags. */
function advertisedRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const mainTip = repo.refs.get('refs/heads/main') ?? null;
  lines.push({ oid: mainTip ?? ZERO_OID, name: 'HEAD', symrefTarget: 'refs/heads/main' });
  const heads = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  for (const ref of heads) {
    lines.push({ oid: repo.refs.get(ref) as string, name: ref });
  }
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of tags) {
    const oid = repo.refs.get(ref) as string;
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object !== undefined && object.type === 'tag') peeled = parseTag(object.data).object;
    lines.push({ oid, name: ref, peeled });
  }
  return lines;
}

function uploadPackCapsV0(): string {
  return `symref=HEAD:refs/heads/main object-format=sha1 side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT}`;
}

function receivePackCapsV0(): string {
  return `symref=HEAD:refs/heads/main object-format=sha1 report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0() : receivePackCapsV0();
  const refs = advertisedRefs(repo);
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  if (refs.length === 1 && refs[0]?.name === 'HEAD' && refs[0]?.oid === ZERO_OID) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  const parts: Buffer[] = [
    encodePktLine('# service=git-upload-pack\n'),
    Buffer.from('0000', 'ascii'),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done filter\n'),
    encodePktLine('object-format=sha1\n'),
    Buffer.from('0000', 'ascii'),
  ];
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  name: string,
  service: string,
  gitProtocol: string | null,
): GitResponse {
  const repo = lookup(store, owner, name);
  if (repo === null) return json404();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV2() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV0(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertisementV0(repo, 'git-receive-pack') };
  }
  return json404();
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchPlan {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | null;
}

function parseV2Args(packets: ReturnType<typeof decodePktLines>): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') {
      if (packet.kind === 'delim') pastDelim = true;
      continue;
    }
    const line = packet.payload.toString('utf8');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice(8).replace(/\n$/, '');
      continue;
    }
    args.push(line.replace(/\n$/, ''));
  }
  return { command, args };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

/**
 * The objects a fetch must send, and the shallow boundaries after it.
 * `depth` limits commit generations from the wants; without it the whole
 * reachable graph minus what the client already holds is sent.
 */
function planFetch(repo: Repo, plan: FetchPlan): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds: the closure of its haves — except a
  // shallow boundary stops the walk. A client that holds a shallow commit
  // has that commit and its tree, but NOT its parents; treating the full
  // ancestry as held would make a deepen deliver nothing new.
  const haveReachable = ((): Set<string> => {
    const held = new Set<string>();
    const shallowSet = new Set(plan.shallow);
    const addTree = (treeOid: string): void => {
      const treeObject = lookup(treeOid);
      if (treeObject === undefined || treeObject.type !== 'tree' || held.has(treeOid)) return;
      held.add(treeOid);
      for (const entry of parseTree(treeObject.data)) {
        if (entry.mode === '40000') addTree(entry.oid);
        else held.add(entry.oid);
      }
    };
    const queue = [...plan.haves];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      held.add(oid);
      const tree = commitTree(repo.objects, oid);
      if (tree !== null) addTree(tree);
      if (shallowSet.has(oid)) continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return held;
  })();
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];

  if (plan.depth !== null) {
    const depth = plan.depth;
    const included = new Set<string>();
    const boundary = new Set<string>();
    // BFS from the wants, following parents, distance < depth.
    const queue: Array<{ oid: string; distance: number }> = plan.wants.map((oid) => ({ oid, distance: 0 }));
    const seenDistance = new Map<string, number>();
    while (queue.length > 0) {
      const { oid, distance } = queue.shift() as { oid: string; distance: number };
      const known = seenDistance.get(oid);
      if (known !== undefined && known <= distance) continue;
      seenDistance.set(oid, distance);
      if (distance >= depth) continue;
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      included.add(oid);
      const commit = parseCommit(object.data);
      const parentsIncluded = distance + 1 < depth;
      for (const parent of commit.parents) {
        if (parentsIncluded) queue.push({ oid: parent, distance: distance + 1 });
        else boundary.add(oid);
      }
      if (commit.parents.length === 0) boundary.add(oid);
    }
    // The closure of the included commits only: each included commit, its
    // trees and its blobs — never their parents, or a depth-1 fetch would
    // carry the whole history.
    const addTree = (treeOid: string): void => {
      const treeObject = lookup(treeOid);
      if (treeObject === undefined || treeObject.type !== 'tree') return;
      if (!haveReachable.has(treeOid)) objects.set(treeOid, treeObject);
      for (const entry of parseTree(treeObject.data)) {
        if (entry.mode === '40000') {
          addTree(entry.oid);
        } else {
          const blob = lookup(entry.oid);
          if (blob !== undefined && !haveReachable.has(entry.oid)) objects.set(entry.oid, blob);
        }
      }
    };
    for (const oid of included) {
      const commit = lookup(oid);
      if (commit !== undefined && !haveReachable.has(oid)) objects.set(oid, commit);
      const tree = commit === undefined ? null : commitTree(repo.objects, oid);
      if (tree !== null) addTree(tree);
    }
    for (const oid of [...boundary].sort()) shallow.push(oid);
    for (const old of plan.shallow) {
      if (!shallow.includes(old) && included.has(old)) {
        const object = lookup(old);
        if (object !== undefined && object.type === 'commit') {
          const parents = parseCommit(object.data).parents;
          if (parents.every((parent) => included.has(parent))) unshallow.push(old);
        }
      }
    }
  } else {
    const wanted = collectReachable(plan.wants, lookup, true);
    for (const oid of wanted) {
      if (haveReachable.has(oid)) continue;
      const object = lookup(oid);
      if (object !== undefined) objects.set(oid, object);
    }
    for (const old of plan.shallow) {
      const object = lookup(old);
      if (object !== undefined && object.type === 'commit') {
        const parents = parseCommit(object.data).parents;
        if (parents.every((parent) => wanted.has(parent) || haveReachable.has(parent))) {
          if (!wanted.has(old)) unshallow.push(old);
        }
      }
    }
  }
  return { objects, shallow, unshallow };
}

/**
 * Packs are content-addressed: the same object set always packs to the same
 * bytes, so a repeated fetch (fifty shallow clones of one tip) reuses the
 * pack instead of re-deflating every object. Bounded, oldest-evicted.
 */
const PACK_CACHE = new Map<string, Buffer>();
const PACK_CACHE_MAX = 16;

function packFor(objects: Map<string, GitObject>): Buffer {
  const key = createHash('sha1').update([...objects.keys()].sort().join(',')).digest('hex');
  const hit = PACK_CACHE.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack([...objects.entries()].map(([oid, object]) => ({ oid, ...object })));
  if (PACK_CACHE.size >= PACK_CACHE_MAX) {
    const first = PACK_CACHE.keys().next().value;
    if (first !== undefined) PACK_CACHE.delete(first);
  }
  PACK_CACHE.set(key, pack);
  return pack;
}

function lsRefsV2(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const refs = advertisedRefs(repo);
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const isEmpty = refs.length === 1 && refs[0]?.oid === ZERO_OID;
  if (isEmpty && unborn && keep('HEAD')) {
    parts.push(encodePktLine('unborn HEAD symref-target:refs/heads/main\n'));
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      if (ref.oid === ZERO_OID) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      if (symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
      parts.push(encodePktLine(`${line}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
  let thinPack = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) plan.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) plan.depth = Number(arg.slice(7).trim());
    else if (arg === 'thin-pack') thinPack = true;
  }
  void thinPack;
  const { objects, shallow, unshallow } = planFetch(repo, plan);
  const pack = packFor(objects);

  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  let acked = false;
  for (const have of plan.haves) {
    if (have === ZERO_OID) continue;
    const isCommon = plan.wants.some((want) => want === have || isAncestor(have, want, lookup));
    if (isCommon) {
      parts.push(encodePktLine(`ACK ${have}\n`));
      acked = true;
      break;
    }
  }
  if (!acked && plan.haves.length > 0) {
    // No common commit: the client still needs the pack, NAK says so.
    parts.push(encodePktLine('NAK\n'));
  } else if (acked) {
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(Buffer.from('0001', 'ascii'));
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).split(' ');
        plan.wants.push(rest[0] as string);
      } else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) plan.depth = Number(line.slice(7).trim());
    } else if (line.startsWith('have ')) {
      plan.haves.push(line.slice(5).trim());
    }
  }
  const { objects, shallow, unshallow } = planFetch(repo, plan);
  const pack = packFor(objects);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const parts: Buffer[] = [];
  let acked = false;
  for (const have of plan.haves) {
    if (have === ZERO_OID) continue;
    if (plan.wants.some((want) => want === have || isAncestor(have, want, lookup))) {
      parts.push(encodePktLine(`ACK ${have}\n`));
      acked = true;
      break;
    }
  }
  if (!acked) parts.push(encodePktLine('NAK\n'));
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function handleUploadPack(
  store: Store,
  owner: string,
  name: string,
  body: Buffer,
  gitProtocol: string | null,
): GitResponse {
  const repo = lookup(store, owner, name);
  if (repo === null) return json404();
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.from('0000', 'ascii') };
  }
  if (gitProtocol === 'version=2') {
    const { command, args } = parseV2Args(packets);
    if (command === 'ls-refs') {
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      let unborn = false;
      for (const arg of args) {
        if (arg === 'peel') peel = true;
        else if (arg === 'symrefs') symrefs = true;
        else if (arg === 'unborn') unborn = true;
        else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice(11));
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsV2(repo, prefixes, peel, symrefs, unborn) };
    }
    if (command === 'fetch') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, args) };
    }
    return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.from('0000', 'ascii') };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, packets) };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function reportStatus(unpackOk: boolean, unpackDetail: string, refs: Array<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const ref of refs) lines.push(ref.ok ? `ok ${ref.ref}` : `ng ${ref.ref} ${ref.reason}`);
  const framed = encodePktLines(lines.map((line) => `${line}\n`));
  // The report travels in sideband band 1, pkt-framed inside it.
  const banded = encodePktLine(Buffer.concat([Buffer.from([1]), framed]));
  return Buffer.concat([banded, Buffer.from('0000', 'ascii')]);
}

export function handleReceivePack(store: Store, owner: string, name: string, body: Buffer): GitResponse {
  const repo = lookup(store, owner, name);
  if (repo === null) return json404();
  let decoded;
  try {
    decoded = decodePktLinesPrefix(body);
  } catch {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportStatus(false, 'bad pkt-line', []) };
  }
  const packets = decoded.packets;
  const commands: PushCommand[] = [];
  let packStart = decoded.bytesConsumed;
  for (let i = 0; i < packets.length; i += 1) {
    const packet = packets[i] as ReturnType<typeof decodePktLines>[number];
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isOid(oldOid) && isOid(newOid) && ref.startsWith('refs/')) commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportStatus(false, 'no commands', []) };
  }
  const packBytes = body.subarray(packStart);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (updatesRef && packBytes.length > 0) {
    let read;
    try {
      read = readPack(packBytes, (oid) => repo.objects.get(oid));
    } catch (err) {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-result',
        body: reportStatus(false, `unpacker error: ${(err as Error).message}`, commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }))),
      };
    }
    if (!read.checksumOk) {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-result',
        body: reportStatus(false, 'unpacker error: pack checksum mismatch', commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }))),
      };
    }
    for (const [oid, object] of read.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  } else if (updatesRef && packBytes.length === 0) {
    // A command list that creates or updates a ref without a pack: git calls
    // that an unpacker error. (The client always sends a pack here.)
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-result',
      body: reportStatus(false, 'unpacker error: no pack', commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }))),
    };
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === null) {
        results.push({ ref: command.ref, ok: false, reason: 'cannot delete a ref that does not exist' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'unable to read object' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== null) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === null) {
      results.push({ ref: command.ref, ok: false, reason: 'cannot lock ref' });
      continue;
    }
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const lookupFn = (oid: string): GitObject | undefined => repo.objects.get(oid);
    if (command.ref.startsWith('refs/tags/')) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestor(command.oldOid, command.newOid, lookupFn)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportStatus(true, 'ok', results) };
}

export function gitObjectCount(repo: Repo): number {
  return repo.objects.size;
}

export function verifyPackOf(pack: Buffer): boolean {
  return verifyPackChecksum(pack);
}

export function hashOf(type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  return hashObject(type, data);
}

export { commitTree, flattenTree };
