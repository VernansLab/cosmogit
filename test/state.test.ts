import { describe, expect, it } from 'vitest';
import type { Commit } from '../src/data/types';
import { Playback } from '../src/sim/Playback';
import { RepoState } from '../src/sim/RepoState';

const c = (t: number, changes: Commit['changes']): Commit => ({ t, author: 0, hash: `${t}`, msg: '', isMerge: false, changes });

describe('RepoState', () => {
  it('tracks adds, modifies, renames and deletes with weights', () => {
    const s = new RepoState();
    s.apply(c(1, [
      { path: 'a/b/x.ts', op: 'A', add: 10, del: 0 },
      { path: 'a/y.md', op: 'A', add: 5, del: 0 },
    ]));
    expect(s.root.weight).toBe(2);
    expect(s.root.dirs.get('a')!.weight).toBe(2);

    const [mod] = s.apply(c(2, [{ path: 'a/y.md', op: 'M', add: 3, del: 1 }]));
    expect(mod.kind).toBe('modify');
    expect(mod.file.lines).toBe(7);

    const [ren] = s.apply(c(3, [{ path: 'c/x.ts', from: 'a/b/x.ts', op: 'R', add: 0, del: 0 }]));
    expect(ren.kind).toBe('rename');
    expect(ren.prev!.alive).toBe(false);
    expect(ren.file.lines).toBe(10);
    // a/b became empty and is pruned.
    expect(s.root.dirs.get('a')!.dirs.has('b')).toBe(false);

    s.apply(c(4, [{ path: 'a/y.md', op: 'D', add: 0, del: 7 }]));
    expect(s.root.dirs.has('a')).toBe(false);
    expect(s.root.weight).toBe(1);
    expect([...s.files.keys()]).toEqual(['c/x.ts']);
  });

  it('treats a modify of an unknown file as an add', () => {
    const s = new RepoState();
    const [r] = s.apply(c(1, [{ path: 'z', op: 'M', add: 1, del: 0 }]));
    expect(r.kind).toBe('add');
  });
});

describe('Playback', () => {
  const day = 86400;
  const commits = [c(0, []), c(day, []), c(100 * day, [])];

  it('releases commits as time passes', () => {
    const p = new Playback(commits, { secondsPerDay: 1, autoSkipSeconds: 3 });
    expect(p.update(0.01).commits).toHaveLength(1);
    expect(p.update(0.5).commits).toHaveLength(0);
    expect(p.update(0.6).commits).toHaveLength(1);
  });

  it('skips idle gaps', () => {
    const p = new Playback(commits, { secondsPerDay: 1, autoSkipSeconds: 3 });
    p.update(2);
    const tick = p.update(0.1);
    expect(tick.skipped).toBe(true);
    expect(p.update(0.3).commits).toHaveLength(1);
    expect(p.done).toBe(true);
  });

  it('seeks', () => {
    const p = new Playback(commits, { secondsPerDay: 1, autoSkipSeconds: 3 });
    expect(p.seek(2)).toHaveLength(2);
    expect(p.index).toBe(2);
  });
});
