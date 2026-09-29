import { Vector3 } from 'three/webgpu';
import type { App } from '../App';
import type { DirNode, FileNode } from '../sim/RepoState';
import { authorColor, cssColor, extColor } from '../render/palette';

interface FloatLabel {
  file: FileNode;
  born: number;
  el: HTMLDivElement;
  x: number;
  y: number;
  visible: boolean;
}

type Picked = { kind: 'file'; file: FileNode } | { kind: 'dir'; dir: DirNode };

/** Seconds a new-file label stays up. */
const LIFE = 2.8;
/** Seconds a beam takes to reach its star (matches App's BEAM_TIME). */
const BEAM_TIME = 0.45;

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const tmp = new Vector3();

/**
 * File names in the scene:
 * - new files briefly show their name, floating up from the star
 * - clicking or tapping a star (or a system's centre) pins an info card to it
 * Positions come from GalaxyLayout.filePosition(), projected every frame.
 * The same data is drawn onto exported video frames via draw().
 */
export class Labels {
  /** Show names of newly created files. */
  showNew = true;
  private layer: HTMLDivElement;
  private floating: FloatLabel[] = [];
  private card: HTMLDivElement;
  private picked: Picked | null = null;
  private cardPos = { x: 0, y: 0, visible: false };

  constructor(private app: App) {
    this.layer = document.createElement('div');
    this.layer.className = 'labels';
    this.card = document.createElement('div');
    this.card.className = 'pick-card';
    this.card.hidden = true;
    document.getElementById('hud')!.prepend(this.layer, this.card);

    // A click/tap that didn't move picks; drags belong to the camera.
    const canvas = app.canvas;
    let down: { x: number; y: number; t: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 500;
      down = null;
      if (moved < 6 && quick) this.pickAt(e.clientX, e.clientY, e.pointerType === 'touch' ? 28 : 16);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.select(null);
    });
  }

  private get maxFloating(): number {
    return window.innerWidth < 700 ? 3 : 6;
  }

  /** Called when a change reaches its star. */
  onAction(kind: string, file: FileNode): void {
    if (!this.showNew || kind !== 'add') return;
    if (this.floating.length >= this.maxFloating) return;
    const el = document.createElement('div');
    el.className = 'float-label';
    el.style.setProperty('--c', cssColor(extColor(file.ext)));
    el.textContent = file.name;
    this.layer.append(el);
    this.floating.push({ file, born: this.app.time + BEAM_TIME, el, x: 0, y: 0, visible: false });
  }

  clear(): void {
    for (const l of this.floating) l.el.remove();
    this.floating.length = 0;
    this.select(null);
  }

  /** Project a world point to CSS pixels in the current viewport; null if behind the camera. */
  private project(p: Vector3, w: number, h: number): { x: number; y: number } | null {
    tmp.copy(p).project(this.app.camera);
    if (tmp.z > 1 || tmp.z < -1) return null;
    return { x: ((tmp.x + 1) / 2) * w, y: ((1 - tmp.y) / 2) * h };
  }

  private pickAt(x: number, y: number, radius: number): void {
    const { width: w, height: h } = this.app.size;
    const rect = this.app.canvas.getBoundingClientRect();
    const px = ((x - rect.left) / rect.width) * w;
    const py = ((y - rect.top) / rect.height) * h;
    const cam = this.app.camera.position;
    let best: Picked | null = null;
    let bestScore = Infinity;
    const consider = (pos: Vector3, pick: Picked, r: number) => {
      const s = this.project(pos, w, h);
      if (!s) return;
      const d = Math.hypot(s.x - px, s.y - py);
      if (d > r) return;
      // Prefer the closest on screen, breaking near-ties towards the camera.
      const score = d + pos.distanceTo(cam) * 0.001;
      if (score < bestScore) {
        bestScore = score;
        best = pick;
      }
    };
    const v = new Vector3();
    for (const f of this.app.state.files.values()) consider(this.app.layout.filePosition(f.id, v), { kind: 'file', file: f }, radius);
    if (!best) {
      const visit = (d: DirNode) => {
        consider(this.app.layout.dirPosition(d.id, v), { kind: 'dir', dir: d }, radius * 1.5);
        for (const k of d.dirs.values()) visit(k);
      };
      visit(this.app.state.root);
    }
    this.select(best);
  }

  select(p: Picked | null): void {
    this.picked = p;
    this.card.hidden = !p;
    if (!p) return;
    this.card.replaceChildren();
    const add = (cls: string, text: string, color?: string) => {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      if (color) el.style.color = color;
      this.card.append(el);
    };
    const log = this.app.log;
    if (p.kind === 'file') {
      const f = p.file;
      const slash = f.path.lastIndexOf('/');
      add('pc-name', f.name, cssColor(extColor(f.ext)));
      add('pc-path', slash > 0 ? `${f.path.slice(0, slash)}/` : '(repo root)');
      add('pc-meta', `~${f.lines.toLocaleString()} lines · .${f.ext}`);
      const author = log?.authors[f.lastAuthor]?.name ?? '?';
      add('pc-meta', `${f.alive ? 'last touched' : 'deleted'} by ${author}`, cssColor(authorColor(author)));
      add('pc-meta', dateFmt.format(f.lastTouched * 1000));
      // Mark it in the scene too.
      const pos = this.app.layout.filePosition(f.id, new Vector3());
      this.app.particles.ring(pos, extColor(f.ext), this.app.time, 4, 0.8);
    } else {
      const d = p.dir;
      add('pc-name', d.path ? `${d.name}/` : `${log?.repo ?? 'repo'} (root)`);
      if (d.path) add('pc-path', d.path.includes('/') ? `${d.path.slice(0, d.path.lastIndexOf('/'))}/` : '(repo root)');
      add('pc-meta', `${d.weight.toLocaleString()} files · ${d.dirs.size} folders inside`);
    }
  }

  /** Per frame: age floating labels and keep everything pinned to its star. */
  update(): void {
    const { width: w, height: h } = this.app.size;
    const now = this.app.time;
    const v = new Vector3();
    this.floating = this.floating.filter((l) => {
      const age = now - l.born;
      if (age > LIFE) {
        l.el.remove();
        return false;
      }
      const s = age >= 0 ? this.project(this.app.layout.filePosition(l.file.id, v), w, h) : null;
      l.visible = !!s;
      if (!s) {
        l.el.style.opacity = '0';
        return true;
      }
      // Rise a little and fade in/out.
      l.x = s.x;
      l.y = s.y - 10 - age * 8;
      const alpha = Math.min(1, age * 4) * Math.min(1, (LIFE - age) * 1.5);
      l.el.style.opacity = String(alpha);
      l.el.style.transform = `translate(${l.x}px, ${l.y}px) translate(-50%, -100%)`;
      return true;
    });

    const p = this.picked;
    if (p) {
      const pos = p.kind === 'file' ? this.app.layout.filePosition(p.file.id, v) : this.app.layout.dirPosition(p.dir.id, v);
      const s = this.project(pos, w, h);
      this.cardPos.visible = !!s;
      this.card.style.opacity = s ? '1' : '0';
      if (s) {
        // Keep the card on screen.
        const cw = this.card.offsetWidth;
        const x = Math.min(Math.max(s.x + 14, 8), w - cw - 8);
        const y = Math.min(Math.max(s.y - 14, 8), h - this.card.offsetHeight - 8);
        this.card.style.transform = `translate(${x}px, ${y}px)`;
      }
    }
  }

  /** Draw the floating labels onto an export frame (canvas at the app's current size). */
  draw(g: CanvasRenderingContext2D, scale: number): void {
    if (!this.showNew) return;
    const now = this.app.time;
    g.save();
    g.font = `500 ${14 * scale}px "JetBrains Mono", monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.shadowColor = 'rgba(0,0,0,0.9)';
    g.shadowBlur = 6 * scale;
    for (const l of this.floating) {
      const age = now - l.born;
      if (!l.visible || age < 0) continue;
      g.globalAlpha = Math.min(1, age * 4) * Math.min(1, (LIFE - age) * 1.5);
      g.fillStyle = cssColor(extColor(l.file.ext));
      g.fillText(l.file.name, l.x, l.y);
    }
    g.restore();
  }
}
