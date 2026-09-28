import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { GalaxyLayout } from '../src/layout/GalaxyLayout';
import { RepoState } from '../src/sim/RepoState';
import type { Commit } from '../src/data/types';

const commit: Commit = {
  t: 1, author: 0, hash: 'x', msg: '', isMerge: false,
  changes: ['src/a.ts', 'src/b.ts', 'src/ui/c.ts', 'docs/readme.md', 'x.json', 'src/ui/deep/d.ts'].map((path) => ({ path, op: 'A' as const, add: 1, del: 0 })),
};

function settle(layout: GalaxyLayout) {
  layout.compute();
  for (let i = 0; i < 600; i++) layout.step(1 / 60);
}

describe('GalaxyLayout', () => {
  it('is deterministic', () => {
    const run = () => {
      const s = new RepoState();
      s.apply(commit);
      const l = new GalaxyLayout(s, { spin: 0 });
      settle(l);
      return [...s.files.values()].map((f) => l.filePosition(f.id, new Vector3()).toArray().map((n) => n.toFixed(3)));
    };
    expect(run()).toEqual(run());
  });

  it('keeps systems apart and produces finite positions', () => {
    const s = new RepoState();
    s.apply(commit);
    const l = new GalaxyLayout(s);
    settle(l);
    for (const f of s.files.values()) {
      const p = l.filePosition(f.id, new Vector3());
      expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    }
    const src = s.root.dirs.get('src')!;
    const docs = s.root.dirs.get('docs')!;
    const a = l.dirPosition(src.id, new Vector3());
    const b = l.dirPosition(docs.id, new Vector3());
    expect(a.distanceTo(b)).toBeGreaterThan(2);
    expect(a.length()).toBeGreaterThan(1);
  });

  it('lays out a real repo without overlapping sibling systems', () => {
    let log;
    try { log = JSON.parse(readFileSync('public/logs/zustand.json', 'utf8')); } catch { return; }
    const s = new RepoState();
    for (const c of log.commits) s.apply(c);
    const l = new GalaxyLayout(s);
    const t0 = performance.now();
    l.compute();
    expect(performance.now() - t0).toBeLessThan(50);
    expect(Number.isFinite(l.radius)).toBe(true);
  });
});
