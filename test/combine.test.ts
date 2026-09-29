import { describe, expect, it } from 'vitest';
import { combine } from '../src/data/combine';
import type { RepoLog } from '../src/data/types';

const log = (repo: string, author: string, times: number[]): RepoLog => ({
  repo,
  authors: [{ name: author, email: '' }],
  commits: times.map((t) => ({ t, author: 0, hash: `${repo}${t}`, msg: `${repo} ${t}`, isMerge: false, changes: [{ path: 'src/a.ts', op: 'M', add: 1, del: 0 }] })),
});

describe('combine', () => {
  const merged = combine([log('api', 'Ann', [1, 5]), log('web', 'ann', [2, 3]), log('api', 'Bob', [4])], 'base');

  it('interleaves commits by time and tags their repo', () => {
    expect(merged.commits.map((c) => c.t)).toEqual([1, 2, 3, 4, 5]);
    expect(merged.repos).toEqual(['api', 'web', 'api-2']);
    expect(merged.commits.map((c) => c.repo)).toEqual([0, 1, 1, 2, 0]);
  });

  it('prefixes paths with the repo folder', () => {
    expect(merged.commits[1].changes[0].path).toBe('web/src/a.ts');
    expect(merged.commits[3].changes[0].path).toBe('api-2/src/a.ts');
  });

  it('merges contributors by name', () => {
    expect(merged.authors.map((a) => a.name)).toEqual(['Ann', 'Bob']);
    expect(merged.commits[1].author).toBe(0);
    expect(merged.commits[3].author).toBe(1);
  });
});
