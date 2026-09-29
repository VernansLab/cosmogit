import git from 'isomorphic-git';
import type { Author, Change, Commit, RepoLog } from './types';

/** The subset of a Node-style `fs` that isomorphic-git needs for reading. */
export type GitFs = Parameters<typeof git.log>[0]['fs'];

export interface ReadProgress {
  repo: string;
  done: number;
  total: number;
}

interface TreeEntry {
  mode: string;
  oid: string;
  type: 'blob' | 'tree' | 'commit';
}

const EMPTY: Map<string, TreeEntry> = new Map();

/**
 * Read a repository's history straight from its `.git` folder, producing the
 * same RepoLog the CLI builds from `git log --raw --numstat`:
 * - commits oldest first (time clamped to never run backwards)
 * - merges diffed against their first parent
 * - renames detected when a deleted and an added file share a blob
 * - line counts from blob contents (a size delta, not a real diff), read once
 *   per blob version and cached
 */
export async function readRepo(fs: GitFs, dir: string, name: string, onProgress?: (p: ReadProgress) => void): Promise<RepoLog> {
  const gitdir = `${dir}/.git`;
  const cache = {};
  // isomorphic-git's log can list a commit twice around merges; keep one of each.
  const seen = new Set<string>();
  const entries = (await git.log({ fs, dir, gitdir, ref: 'HEAD', cache })).reverse().filter((e) => !seen.has(e.oid) && !!seen.add(e.oid));

  const authors: Author[] = [];
  const authorIndex = new Map<string, number>();
  const trees = new Map<string, Map<string, TreeEntry>>();
  const lineCache = new Map<string, number>();

  const readTree = async (oid: string | null): Promise<Map<string, TreeEntry>> => {
    if (!oid) return EMPTY;
    let t = trees.get(oid);
    if (!t) {
      const { tree } = await git.readTree({ fs, dir, gitdir, oid, cache });
      t = new Map(tree.map((e) => [e.path, { mode: e.mode, oid: e.oid, type: e.type as TreeEntry['type'] }]));
      trees.set(oid, t);
    }
    return t;
  };

  const lines = async (oid: string): Promise<number> => {
    let n = lineCache.get(oid);
    if (n === undefined) {
      const { blob } = await git.readBlob({ fs, dir, gitdir, oid, cache });
      n = 0;
      // Binary files (a NUL in the first 8 KB) count as 0 lines, like numstat's "-".
      const probe = Math.min(blob.length, 8000);
      let binary = false;
      for (let i = 0; i < probe; i++) if (blob[i] === 0) { binary = true; break; }
      if (!binary) {
        for (let i = 0; i < blob.length; i++) if (blob[i] === 10) n++;
        if (blob.length && blob[blob.length - 1] !== 10) n++;
      }
      lineCache.set(oid, n);
    }
    return n;
  };

  // Recursive tree diff; unchanged subtrees (same oid) are skipped entirely.
  const diff = async (a: string | null, b: string | null, prefix: string, out: Array<{ path: string; old?: string; now?: string }>) => {
    if (a === b) return;
    const [ta, tb] = await Promise.all([readTree(a), readTree(b)]);
    for (const [path, eb] of tb) {
      const ea = ta.get(path);
      if (ea && ea.oid === eb.oid) continue;
      const full = prefix + path;
      if (eb.type === 'tree') {
        if (ea && ea.type !== 'tree') out.push({ path: full, old: ea.oid });
        await diff(ea?.type === 'tree' ? ea.oid : null, eb.oid, `${full}/`, out);
      } else if (eb.type === 'blob') {
        if (ea?.type === 'tree') await diff(ea.oid, null, `${full}/`, out);
        out.push({ path: full, old: ea?.type === 'blob' ? ea.oid : undefined, now: eb.oid });
      }
    }
    for (const [path, ea] of ta) {
      if (tb.has(path)) continue;
      const full = prefix + path;
      if (ea.type === 'tree') await diff(ea.oid, null, `${full}/`, out);
      else if (ea.type === 'blob') out.push({ path: full, old: ea.oid });
    }
  };

  const commits: Commit[] = [];
  let lastT = -Infinity;
  for (let i = 0; i < entries.length; i++) {
    const { oid, commit } = entries[i];
    const parent = commit.parent[0] ? (await git.readCommit({ fs, dir, gitdir, oid: commit.parent[0], cache })).commit.tree : null;
    const raw: Array<{ path: string; old?: string; now?: string }> = [];
    await diff(parent, commit.tree, '', raw);

    // Pair deletes and adds of identical content into renames.
    const added = new Map<string, number>();
    raw.forEach((c, idx) => {
      if (c.now && !c.old) added.set(c.now, idx);
    });
    const renamedFrom = new Map<number, string>();
    const drop = new Set<number>();
    raw.forEach((c, idx) => {
      if (c.old && !c.now) {
        const j = added.get(c.old);
        if (j !== undefined && !renamedFrom.has(j)) {
          renamedFrom.set(j, c.path);
          drop.add(idx);
        }
      }
    });

    const changes: Change[] = [];
    for (let idx = 0; idx < raw.length; idx++) {
      if (drop.has(idx)) continue;
      const c = raw[idx];
      const from = renamedFrom.get(idx);
      if (from) {
        changes.push({ path: c.path, from, op: 'R', add: 0, del: 0 });
      } else if (c.now && c.old) {
        const [ln, lo] = await Promise.all([lines(c.now), lines(c.old)]);
        changes.push({ path: c.path, op: 'M', add: Math.max(1, ln - lo), del: Math.max(ln === lo ? 1 : 0, lo - ln) });
      } else if (c.now) {
        changes.push({ path: c.path, op: 'A', add: await lines(c.now), del: 0 });
      } else if (c.old) {
        changes.push({ path: c.path, op: 'D', add: 0, del: await lines(c.old) });
      }
    }

    const who = commit.author;
    const key = who.name.trim().toLowerCase();
    let author = authorIndex.get(key);
    if (author === undefined) {
      author = authors.push({ name: who.name.trim(), email: who.email }) - 1;
      authorIndex.set(key, author);
    }
    const t = Math.max(commit.committer.timestamp, lastT);
    lastT = t;
    commits.push({
      t,
      author,
      hash: oid,
      msg: commit.message.split('\n')[0].trim(),
      isMerge: commit.parent.length > 1,
      changes,
    });
    if (onProgress && (i % 25 === 0 || i === entries.length - 1)) onProgress({ repo: name, done: i + 1, total: entries.length });
  }
  return { repo: name, authors, commits };
}
