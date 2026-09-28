import type { Author, Change, Commit, Op, RepoLog } from './types';

export const GIT_LOG_FORMAT = '%x1e%H%x1f%ct%x1f%an%x1f%ae%x1f%P%x1f%s';

/** Args for `git log` whose output `parseGitLog` understands. */
export const GIT_LOG_ARGS = [
  '-c',
  'core.quotePath=false',
  'log',
  '--reverse',
  '--date-order',
  '-M',
  '--raw',
  '--numstat',
  '--no-color',
  '--no-abbrev',
  '--diff-merges=first-parent',
  `--format=${GIT_LOG_FORMAT}`,
];

class AuthorTable {
  readonly list: Author[] = [];
  private index = new Map<string, number>();

  get(name: string, email: string): number {
    // Same person often commits under several emails; key on name.
    const key = name.trim().toLowerCase();
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.list.length;
      this.list.push({ name: name.trim(), email: email.trim() });
      this.index.set(key, i);
    }
    return i;
  }
}

/**
 * Parse `git log` output produced with GIT_LOG_ARGS.
 * Git prints all --raw lines, then all --numstat lines, in the same file order,
 * so they are paired by index.
 */
export function parseGitLog(text: string, repo = 'repo'): RepoLog {
  const authors = new AuthorTable();
  const commits: Commit[] = [];

  for (const block of text.split('\x1e')) {
    if (!block.trim()) continue;
    const nl = block.indexOf('\n');
    const header = nl === -1 ? block : block.slice(0, nl);
    const body = nl === -1 ? '' : block.slice(nl + 1);
    const [hash, at, an, ae, parents, ...subject] = header.split('\x1f');
    if (!hash || !at) continue;

    const raw: Change[] = [];
    const stats: Array<[number, number]> = [];
    for (const line of body.split('\n')) {
      if (!line) continue;
      if (line.startsWith(':')) {
        const tab = line.indexOf('\t');
        if (tab === -1) continue;
        const meta = line.slice(1, tab).split(' ');
        const status = meta[meta.length - 1] ?? 'M';
        const paths = line.slice(tab + 1).split('\t');
        const code = status[0];
        if (code === 'R' && paths.length >= 2) {
          raw.push({ path: paths[1], from: paths[0], op: 'R', add: 0, del: 0 });
        } else if (code === 'C' && paths.length >= 2) {
          raw.push({ path: paths[1], op: 'A', add: 0, del: 0 });
        } else {
          const op: Op = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M';
          raw.push({ path: paths[0], op, add: 0, del: 0 });
        }
      } else {
        const m = /^(-|\d+)\t(-|\d+)\t/.exec(line);
        if (m) stats.push([m[1] === '-' ? 0 : +m[1], m[2] === '-' ? 0 : +m[2]]);
      }
    }
    raw.forEach((c, i) => {
      const s = stats[i];
      if (s) [c.add, c.del] = s;
    });

    commits.push({
      t: +at,
      author: authors.get(an ?? '?', ae ?? ''),
      hash,
      msg: subject.join('\x1f'),
      isMerge: (parents ?? '').trim().split(/\s+/).length > 1,
      changes: raw,
    });
  }

  // --date-order keeps parents before children; clamp so time never runs backwards.
  for (let i = 1; i < commits.length; i++) {
    if (commits[i].t < commits[i - 1].t) commits[i].t = commits[i - 1].t;
  }
  return { repo, authors: authors.list, commits };
}

/** Parse Gource's custom log format: `timestamp|user|A/M/D|path[|colour]`. */
export function parseGourceLog(text: string, repo = 'repo'): RepoLog {
  const authors = new AuthorTable();
  const commits: Commit[] = [];
  let cur: Commit | null = null;

  for (const line of text.split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length < 4) continue;
    const [ts, user, type, path] = parts;
    const t = +ts;
    if (!Number.isFinite(t) || !path) continue;
    const author = authors.get(user, '');
    if (!cur || cur.t !== t || cur.author !== author) {
      cur = { t, author, hash: `${t}-${author}`, msg: '', isMerge: false, changes: [] };
      commits.push(cur);
    }
    const op: Op = type === 'A' ? 'A' : type === 'D' ? 'D' : 'M';
    cur.changes.push({ path: path.replace(/^\//, ''), op, add: 0, del: 0 });
  }

  commits.sort((a, b) => a.t - b.t);
  return { repo, authors: authors.list, commits };
}

/** Accept our JSON, a Gource custom log, or raw `git log` output. */
export function parseAny(text: string, name = 'repo'): RepoLog {
  const head = text.trimStart();
  if (head.startsWith('{')) return JSON.parse(text) as RepoLog;
  if (head.startsWith('\x1e')) return parseGitLog(text, name);
  return parseGourceLog(text, name);
}
