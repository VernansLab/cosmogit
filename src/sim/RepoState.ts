import type { Change, Commit } from '../data/types';

export interface FileNode {
  id: number;
  path: string;
  name: string;
  ext: string;
  dir: DirNode;
  lines: number;
  lastTouched: number;
  lastAuthor: number;
  alive: boolean;
}

export interface DirNode {
  id: number;
  path: string;
  name: string;
  depth: number;
  parent: DirNode | null;
  dirs: Map<string, DirNode>;
  files: Map<string, FileNode>;
  /** Number of live files in this subtree. */
  weight: number;
}

export type ApplyKind = 'add' | 'modify' | 'delete' | 'rename';

export interface Applied {
  kind: ApplyKind;
  file: FileNode;
  /** For renames: the node that disappeared. */
  prev?: FileNode;
  change: Change;
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : name.toLowerCase();
}

/**
 * The repo's file tree as of the last applied commit.
 * Node ids are never reused, so renderers can key buffers on them.
 */
export class RepoState {
  root: DirNode;
  readonly files = new Map<string, FileNode>();
  private nextFileId = 0;
  private nextDirId = 0;
  /** Bumped whenever the tree shape changes; the layout watches this. */
  version = 0;

  constructor() {
    this.root = this.makeDir('', '', null);
  }

  reset(): void {
    this.files.clear();
    this.nextFileId = 0;
    this.nextDirId = 0;
    this.root = this.makeDir('', '', null);
    this.version++;
  }

  private makeDir(path: string, name: string, parent: DirNode | null): DirNode {
    return {
      id: this.nextDirId++,
      path,
      name,
      depth: parent ? parent.depth + 1 : 0,
      parent,
      dirs: new Map(),
      files: new Map(),
      weight: 0,
    };
  }

  private ensureDir(dirPath: string): DirNode {
    let node = this.root;
    if (!dirPath) return node;
    let acc = '';
    for (const part of dirPath.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      let next = node.dirs.get(part);
      if (!next) {
        next = this.makeDir(acc, part, node);
        node.dirs.set(part, next);
      }
      node = next;
    }
    return node;
  }

  private bumpWeight(dir: DirNode | null, delta: number): void {
    for (let d = dir; d; d = d.parent) d.weight += delta;
  }

  private addFile(path: string, t: number, author: number, lines: number): FileNode {
    const slash = path.lastIndexOf('/');
    const dir = this.ensureDir(slash === -1 ? '' : path.slice(0, slash));
    const name = path.slice(slash + 1);
    const file: FileNode = {
      id: this.nextFileId++,
      path,
      name,
      ext: extOf(name),
      dir,
      lines: Math.max(1, lines),
      lastTouched: t,
      lastAuthor: author,
      alive: true,
    };
    dir.files.set(name, file);
    this.files.set(path, file);
    this.bumpWeight(dir, 1);
    this.version++;
    return file;
  }

  private removeFile(file: FileNode): void {
    file.alive = false;
    file.dir.files.delete(file.name);
    this.files.delete(file.path);
    this.bumpWeight(file.dir, -1);
    // Prune empty directories.
    let d: DirNode | null = file.dir;
    while (d && d.parent && d.weight === 0) {
      d.parent.dirs.delete(d.name);
      d = d.parent;
    }
    this.version++;
  }

  apply(commit: Commit): Applied[] {
    const out: Applied[] = [];
    const { t, author } = commit;
    for (const change of commit.changes) {
      const existing = this.files.get(change.path);
      if (change.op === 'D') {
        if (existing) {
          existing.lastTouched = t;
          existing.lastAuthor = author;
          this.removeFile(existing);
          out.push({ kind: 'delete', file: existing, change });
        }
      } else if (change.op === 'R' && change.from) {
        const prev = this.files.get(change.from);
        const lines = (prev?.lines ?? 0) + change.add - change.del;
        if (prev) this.removeFile(prev);
        if (existing) this.removeFile(existing);
        const file = this.addFile(change.path, t, author, lines);
        out.push({ kind: 'rename', file, prev, change });
      } else if (existing) {
        existing.lines = Math.max(1, existing.lines + change.add - change.del);
        existing.lastTouched = t;
        existing.lastAuthor = author;
        out.push({ kind: 'modify', file: existing, change });
      } else {
        // 'A', or an 'M' for a file we never saw (shallow history).
        const file = this.addFile(change.path, t, author, change.add - change.del);
        out.push({ kind: 'add', file, change });
      }
    }
    return out;
  }
}
