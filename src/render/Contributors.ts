import { CanvasTexture, Color, Group, SRGBColorSpace, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { Author } from '../data/types';
import type { GalaxyLayout } from '../layout/GalaxyLayout';
import type { Applied } from '../sim/RepoState';
import { hash01 } from '../layout/hash';
import { authorColor, cssColor } from './palette';

export interface Action {
  author: number;
  applied: Applied;
}

interface Pilot {
  index: number;
  author: Author;
  color: Color;
  group: Group;
  avatar: Sprite;
  label: Sprite;
  pos: Vector3;
  vel: Vector3;
  target: Vector3;
  queue: Applied[];
  queuedAt: number;
  lastActive: number;
  opacity: number;
  fireClock: number;
  /** Personal hover direction, so pilots working in the same place don't stack. */
  offset: Vector3;
  trailFrom: Vector3;
}

const tmp = new Vector3();
const tmp2 = new Vector3();

function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? '?').slice(0, 2);
  return s.toUpperCase();
}

function avatarTexture(name: string, color: Color): CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const glow = g.createRadialGradient(64, 64, 20, 64, 64, 64);
  glow.addColorStop(0, cssColor(color));
  glow.addColorStop(0.55, `${cssColor(color)}55`);
  glow.addColorStop(1, `${cssColor(color)}00`);
  g.fillStyle = glow;
  g.fillRect(0, 0, size, size);
  g.beginPath();
  g.arc(64, 64, 30, 0, Math.PI * 2);
  g.fillStyle = '#0b0d18';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = cssColor(color);
  g.stroke();
  g.fillStyle = '#ffffff';
  g.font = '600 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(initials(name), 64, 66);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function labelTexture(text: string): { tex: CanvasTexture; aspect: number } {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = '500 34px system-ui, sans-serif';
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 24;
  c.width = w;
  c.height = 48;
  g.font = font;
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.shadowColor = 'rgba(0,0,0,0.9)';
  g.shadowBlur = 8;
  g.textBaseline = 'middle';
  g.fillText(text, 12, 25);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return { tex, aspect: w / 48 };
}

/**
 * Contributors fly to the files they touch and fire at them.
 * They carry a queue of changes and hand them to `onFire` one by one once
 * they've arrived, so the effects feel like they come from the pilot.
 */
export class Contributors {
  readonly object = new Group();
  private pilots = new Map<number, Pilot>();
  /** Actions per second each pilot fires once it has arrived. */
  fireRate = 40;
  /** Seconds of inactivity before a pilot fades away. */
  idleFade = 6;
  showLabels = true;
  /** Screen-space size of avatars. */
  scale = 0.045;

  constructor(
    private authors: Author[],
    private layout: GalaxyLayout,
    private onFire: (a: Action) => void,
    private onTrail: (pos: Vector3, color: Color) => void,
  ) {}

  private pilot(index: number): Pilot {
    let p = this.pilots.get(index);
    if (p) return p;
    const author = this.authors[index] ?? { name: '?', email: '' };
    const color = authorColor(author.name);
    const avatar = new Sprite(new SpriteMaterial({ map: avatarTexture(author.name, color), depthWrite: false, sizeAttenuation: false, transparent: true }));
    const { tex, aspect } = labelTexture(author.name);
    const label = new Sprite(new SpriteMaterial({ map: tex, depthWrite: false, sizeAttenuation: false, transparent: true }));
    label.center.set(0.5, 1.6);
    label.userData.aspect = aspect;
    const group = new Group();
    group.add(avatar, label);
    group.renderOrder = 10;
    this.object.add(group);
    // Enter from far out, above the galactic plane.
    const r = this.layout.radius * 1.2;
    const a = Math.random() * Math.PI * 2;
    p = {
      index,
      author,
      color,
      group,
      avatar,
      label,
      pos: new Vector3(Math.cos(a) * r, r * 0.4, Math.sin(a) * r),
      vel: new Vector3(),
      target: new Vector3(),
      queue: [],
      queuedAt: 0,
      lastActive: 0,
      opacity: 0,
      fireClock: 0,
      offset: new Vector3(hash01(author.name, 21) - 0.5, hash01(author.name, 22) * 0.6, hash01(author.name, 23) - 0.5).normalize(),
      trailFrom: new Vector3(),
    };
    p.trailFrom.copy(p.pos);
    this.pilots.set(index, p);
    return p;
  }

  colorOf(index: number): Color {
    return this.pilot(index).color;
  }

  /** Queue a commit's changes for its author. */
  enqueue(author: number, applied: Applied[], time: number): void {
    if (!applied.length) return;
    const p = this.pilot(author);
    if (!p.queue.length) p.queuedAt = time;
    p.queue.push(...applied);
    p.lastActive = time;
  }

  /** Flush every queue instantly (seek, export end). */
  clear(): void {
    for (const p of this.pilots.values()) {
      p.queue.length = 0;
      p.opacity = 0;
      p.group.visible = false;
    }
  }

  /** Positions of active pilots, for the camera. */
  *active(): Iterable<Vector3> {
    for (const p of this.pilots.values()) if (p.opacity > 0.3) yield p.pos;
  }

  private queueCentroid(p: Pilot, out: Vector3): Vector3 {
    out.set(0, 0, 0);
    const n = Math.min(p.queue.length, 12);
    for (let i = 0; i < n; i++) out.add(this.layout.filePosition(p.queue[i].file.id, tmp2));
    return out.divideScalar(n);
  }

  update(dt: number, time: number): void {
    for (const p of this.pilots.values()) {
      if (p.queue.length) {
        this.queueCentroid(p, p.target);
        // Hover a little outside the cluster, towards the viewer side of the core.
        tmp.copy(p.target);
        const len = tmp.length() || 1;
        p.target.addScaledVector(tmp.divideScalar(len), 2.5).addScaledVector(p.offset, 3 + this.layout.radius * 0.03);
        p.lastActive = time;
      }

      // Critically damped spring towards the target.
      const k = 5;
      tmp.copy(p.target).sub(p.pos).multiplyScalar(k * k);
      tmp.addScaledVector(p.vel, -2 * k);
      p.vel.addScaledVector(tmp, Math.min(dt, 0.05));
      p.pos.addScaledVector(p.vel, Math.min(dt, 0.05));

      const idle = time - p.lastActive;
      const want = idle > this.idleFade ? 0 : 1;
      p.opacity += (want - p.opacity) * Math.min(1, dt * 3);
      p.group.visible = p.opacity > 0.01;
      p.group.position.copy(p.pos);
      (p.avatar.material as SpriteMaterial).opacity = p.opacity;
      (p.label.material as SpriteMaterial).opacity = p.opacity * 0.9;
      p.label.visible = this.showLabels;
      p.avatar.scale.setScalar(this.scale);
      p.label.scale.set(this.scale * 0.45 * p.label.userData.aspect, this.scale * 0.45, 1);

      // Comet trail: drop particles evenly along the path travelled this frame.
      if (p.opacity > 0.05) {
        const travelled = p.trailFrom.distanceTo(p.pos);
        const spacing = 0.35 + this.layout.radius * 0.004;
        if (travelled > spacing) {
          const n = Math.min(12, Math.floor(travelled / spacing));
          for (let i = 1; i <= n; i++) this.onTrail(tmp.copy(p.trailFrom).lerp(p.pos, i / n), p.color);
          p.trailFrom.copy(p.pos);
        }
      } else {
        p.trailFrom.copy(p.pos);
      }

      if (!p.queue.length) continue;
      const near = p.pos.distanceTo(p.target) < 6 + this.layout.radius * 0.05;
      if (!near && time - p.queuedAt < 0.6) continue;
      // Fire faster when the queue is long so big commits don't take forever.
      p.fireClock += dt * this.fireRate * (1 + p.queue.length / 20);
      while (p.fireClock >= 1 && p.queue.length) {
        p.fireClock -= 1;
        this.onFire({ author: p.index, applied: p.queue.shift()! });
      }
      if (!p.queue.length) p.fireClock = 0;
    }
  }

  /** Where a pilot currently is. */
  position(author: number, out: Vector3): Vector3 {
    return out.copy(this.pilot(author).pos);
  }
}
