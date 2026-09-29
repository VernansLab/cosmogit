import './polyfill';
import { fsFromFiles, fsFromHandle } from './browserFs';
import { combine } from './combine';
import { type GitFs, readRepo } from './gitReader';
import type { RepoLog } from './types';

/**
 * Reads git history off the main thread.
 * In:  { handle: FileSystemDirectoryHandle } or { files: File[], name: string }
 * Out: { type: 'progress', text, fraction } … then { type: 'done', log } or { type: 'error', message }
 */
export type GitWorkerIn = { handle: FileSystemDirectoryHandle } | { files: File[]; name: string };
export type GitWorkerOut =
  | { type: 'progress'; text: string; fraction: number }
  | { type: 'done'; log: RepoLog }
  | { type: 'error'; message: string };

const post = (m: GitWorkerOut) => (self as unknown as Worker).postMessage(m);

/** The promise-based half of the fs our adapters provide. */
type PromiseFs = { promises: { stat(p: string): Promise<{ isFile(): boolean }>; readdir(p: string): Promise<string[]> } };

async function isRepo(fs: GitFs, dir: string): Promise<boolean> {
  try {
    const s = await (fs as unknown as PromiseFs).promises.stat(`${dir}/.git/HEAD`);
    return s.isFile();
  } catch {
    return false;
  }
}

self.onmessage = async (e: MessageEvent<GitWorkerIn>) => {
  try {
    const msg = e.data;
    const fs = 'handle' in msg ? fsFromHandle(msg.handle) : fsFromFiles(msg.files);
    const name = 'handle' in msg ? msg.handle.name : msg.name;

    let repos: Array<{ dir: string; name: string }>;
    if (await isRepo(fs, '/root')) {
      repos = [{ dir: '/root', name }];
    } else {
      const kids = await (fs as unknown as PromiseFs).promises.readdir('/root');
      repos = [];
      for (const k of kids.sort()) {
        if (k.startsWith('.') || k === 'node_modules') continue;
        if (await isRepo(fs, `/root/${k}`)) repos.push({ dir: `/root/${k}`, name: k });
      }
      if (!repos.length) throw new Error(`“${name}” isn't a git repository, and has no repositories directly inside it.`);
    }

    const logs: RepoLog[] = [];
    for (let i = 0; i < repos.length; i++) {
      const r = repos[i];
      const prefix = repos.length > 1 ? `Repo ${i + 1} of ${repos.length}: ` : '';
      post({ type: 'progress', text: `${prefix}reading ${r.name}…`, fraction: i / repos.length });
      const log = await readRepo(fs, r.dir, r.name, (p) =>
        post({
          type: 'progress',
          text: `${prefix}${r.name} · ${p.done.toLocaleString()} / ${p.total.toLocaleString()} commits`,
          fraction: (i + p.done / p.total) / repos.length,
        }),
      );
      if (log.commits.length) logs.push(log);
    }
    if (!logs.length) throw new Error('No commits found.');
    post({ type: 'done', log: logs.length === 1 ? logs[0] : combine(logs, name) });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message || String(err) });
  }
};
