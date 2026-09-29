import type { GitFs } from './gitReader';

/**
 * Read-only, Node-style `fs.promises` over what the browser gives us, just
 * enough for isomorphic-git to read history. The picked folder is mounted
 * at /root.
 */

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
}

function stats(kind: 'file' | 'dir', size = 0, mtimeMs = 0) {
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
    size,
    mode: kind === 'dir' ? 0o40000 : 0o100644,
    mtimeMs,
    ctimeMs: mtimeMs,
    dev: 0,
    ino: 0,
    uid: 0,
    gid: 0,
  };
}

function readOnly(): never {
  throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
}

async function toContent(file: File, opts?: unknown): Promise<Uint8Array | string> {
  const encoding = typeof opts === 'string' ? opts : (opts as { encoding?: string } | undefined)?.encoding;
  if (encoding === 'utf8') return file.text();
  return Buffer.from(await file.arrayBuffer());
}

function makeFs(api: {
  file(path: string): Promise<File | null>;
  dir(path: string): Promise<string[] | null>;
}): GitFs {
  const promises = {
    async readFile(path: string, opts?: unknown) {
      const f = await api.file(path);
      if (!f) throw enoent(path);
      return toContent(f, opts);
    },
    async readdir(path: string) {
      const d = await api.dir(path);
      if (!d) throw enoent(path);
      return d;
    },
    async stat(path: string) {
      const f = await api.file(path);
      if (f) return stats('file', f.size, f.lastModified);
      if (await api.dir(path)) return stats('dir');
      throw enoent(path);
    },
    async lstat(path: string) {
      return promises.stat(path);
    },
    async readlink(path: string): Promise<string> {
      throw enoent(path);
    },
    writeFile: readOnly,
    mkdir: readOnly,
    rmdir: readOnly,
    unlink: readOnly,
    symlink: readOnly,
    chmod: readOnly,
  };
  return { promises } as unknown as GitFs;
}

function split(path: string): string[] {
  return path.split('/').filter((s) => s && s !== 'root');
}

/** Over a FileSystemDirectoryHandle (Chrome/Edge folder picker). */
export function fsFromHandle(root: FileSystemDirectoryHandle): GitFs {
  const dirs = new Map<string, FileSystemDirectoryHandle | null>([['', root]]);
  const getDir = async (parts: string[]): Promise<FileSystemDirectoryHandle | null> => {
    const key = parts.join('/');
    if (dirs.has(key)) return dirs.get(key)!;
    const parent = await getDir(parts.slice(0, -1));
    let h: FileSystemDirectoryHandle | null = null;
    if (parent) {
      try {
        h = await parent.getDirectoryHandle(parts[parts.length - 1]);
      } catch {
        h = null;
      }
    }
    dirs.set(key, h);
    return h;
  };
  return makeFs({
    async file(path) {
      const parts = split(path);
      if (!parts.length) return null;
      const parent = await getDir(parts.slice(0, -1));
      if (!parent) return null;
      try {
        return await (await parent.getFileHandle(parts[parts.length - 1])).getFile();
      } catch {
        return null;
      }
    },
    async dir(path) {
      const d = await getDir(split(path));
      if (!d) return null;
      const names: string[] = [];
      for await (const name of (d as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
      return names;
    },
  });
}

/**
 * Over a flat list of Files from <input webkitdirectory> (Safari/Firefox).
 * Paths are relative to the picked folder, e.g. "alfred/.git/HEAD".
 */
export function fsFromFiles(files: File[]): GitFs {
  const byPath = new Map<string, File>();
  const children = new Map<string, Set<string>>();
  for (const f of files) {
    const parts = f.webkitRelativePath.split('/').slice(1); // drop the picked folder's own name
    byPath.set(parts.join('/'), f);
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!children.has(dir)) children.set(dir, new Set());
      children.get(dir)!.add(parts[i]);
    }
  }
  return makeFs({
    async file(path) {
      return byPath.get(split(path).join('/')) ?? null;
    },
    async dir(path) {
      const c = children.get(split(path).join('/'));
      return c ? [...c] : null;
    },
  });
}
