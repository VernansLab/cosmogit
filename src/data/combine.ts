import type { Author, Commit, RepoLog } from './types';

/**
 * Merge several repositories into one history. Each repo's files move under
 * a top-level folder named after it, so every repo becomes its own arm of the
 * same galaxy. Commits interleave by time, and contributors are merged by
 * name across repos.
 */
export function combine(logs: RepoLog[], name: string): RepoLog {
  const authors: Author[] = [];
  const authorIndex = new Map<string, number>();
  const repos: string[] = [];
  const commits: Commit[] = [];

  for (const log of logs) {
    // Unique folder name even if two repos share a basename.
    let folder = log.repo;
    for (let n = 2; repos.includes(folder); n++) folder = `${log.repo}-${n}`;
    const repoIndex = repos.push(folder) - 1;

    const remap = log.authors.map((a) => {
      const key = a.name.trim().toLowerCase();
      let i = authorIndex.get(key);
      if (i === undefined) {
        i = authors.push({ ...a }) - 1;
        authorIndex.set(key, i);
      }
      return i;
    });

    for (const c of log.commits) {
      commits.push({
        ...c,
        author: remap[c.author] ?? 0,
        repo: repoIndex,
        changes: c.changes.map((ch) => ({
          ...ch,
          path: `${folder}/${ch.path}`,
          ...(ch.from ? { from: `${folder}/${ch.from}` } : {}),
        })),
      });
    }
  }

  // Array.prototype.sort is stable, so each repo keeps its own order on ties.
  commits.sort((a, b) => a.t - b.t);
  return { repo: name, authors, commits, repos };
}
