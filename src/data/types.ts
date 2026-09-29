export type Op = 'A' | 'M' | 'D' | 'R';

export interface Change {
  path: string;
  op: Op;
  /** Previous path, only for renames. */
  from?: string;
  add: number;
  del: number;
}

export interface Commit {
  /** Unix seconds. */
  t: number;
  /** Index into RepoLog.authors. */
  author: number;
  hash: string;
  msg: string;
  isMerge: boolean;
  changes: Change[];
  /** Index into RepoLog.repos when several repos were combined. */
  repo?: number;
}

export interface Author {
  name: string;
  email: string;
}

export interface RepoLog {
  repo: string;
  authors: Author[];
  commits: Commit[];
  /** Names of the combined repos; each is a top-level folder in the galaxy. */
  repos?: string[];
}
