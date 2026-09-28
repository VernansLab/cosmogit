import { Vector3 } from 'three';
import type { DirNode, RepoState } from '../sim/RepoState';
import { hash01 } from './hash';

export interface LayoutParams {
  /** Typical distance between neighbouring stars in a system. */
  fileSpacing: number;
  /** Extra space between a system and its child systems. */
  gap: number;
  /** How far child fans rotate around the galactic axis per depth level. */
  spiralTwist: number;
  /** How flat each system's star cluster is (1 = sphere). */
  discFlatten: number;
  /** Max tilt of a child system's disc relative to its parent's (radians). */
  tilt: number;
  /** Spin speed of star clusters (radians/second for a unit-sized system). */
  spin: number;
}

export const defaultLayoutParams: LayoutParams = {
  fileSpacing: 1.6,
  gap: 3,
  spiralTwist: 0.55,
  discFlatten: 0.3,
  tilt: 0.55,
  spin: 0.25,
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const UP = new Vector3(0, 1, 0);

/** Growable float storage indexed by node id. */
class Slots {
  data: Float32Array;
  constructor(
    readonly stride: number,
    cap = 256,
  ) {
    this.data = new Float32Array(cap * stride);
  }
  ensure(id: number): void {
    const need = (id + 1) * this.stride;
    if (need <= this.data.length) return;
    let len = this.data.length;
    while (len < need) len *= 2;
    const next = new Float32Array(len);
    next.set(this.data);
    this.data = next;
  }
}

/**
 * Deterministic 3D galaxy layout.
 *
 * Every directory is a star system. The root's children ring the galactic
 * core; deeper directories fan outwards from their parent, twisting around
 * the galactic axis so subtrees trace spiral arms. Files are stars in a
 * flattened, spinning cluster around their directory.
 *
 * compute() sets targets when the tree changes; step() springs the live
 * positions towards them, so nothing ever jumps.
 */
export class GalaxyLayout {
  params: LayoutParams;

  // Directory state (stride 3): target, current, velocity, disc normal.
  private dirTarget = new Slots(3);
  private dirPos = new Slots(3);
  private dirVel = new Slots(3);
  private dirNormal = new Slots(3);
  private dirSpin = new Slots(1);
  private dirKnown = new Uint8Array(256);

  // File state: offset from the directory centre, in the disc's frame.
  private fileOffTarget = new Slots(3);
  private fileOff = new Slots(3);
  private fileOffVel = new Slots(3);
  private fileDir = new Int32Array(256);
  private fileKnown = new Uint8Array(256);

  /** World-space star positions, updated by step(). Indexed by file id * 3. */
  filePositions = new Float32Array(256 * 3);
  /** World-space system positions, updated by step(). Indexed by dir id * 3. */
  get dirPositions(): Float32Array {
    return this.dirPos.data;
  }

  /** Overall galaxy radius, for camera framing. */
  radius = 10;
  private extent = new Map<number, number>();
  private lastVersion = -1;
  private time = 0;

  constructor(
    private state: RepoState,
    params: Partial<LayoutParams> = {},
  ) {
    this.params = { ...defaultLayoutParams, ...params };
  }

  /** Forget all nodes (after RepoState.reset()). */
  reset(): void {
    this.dirKnown.fill(0);
    this.fileKnown.fill(0);
    this.lastVersion = -1;
  }

  /** Recompute targets if the tree changed (or `force`). */
  compute(force = false): void {
    if (!force && this.state.version === this.lastVersion) return;
    this.lastVersion = this.state.version;
    this.extent.clear();
    const root = this.state.root;
    this.measure(root);
    this.ensureDir(root.id);
    this.setVec(this.dirTarget, root.id, 0, 0, 0);
    this.setVec(this.dirNormal, root.id, 0, 1, 0);
    this.place(root, new Vector3(), new Vector3(1, 0, 0), UP.clone(), null);
    this.radius = Math.max(10, this.extent.get(root.id) ?? 10);
  }

  /** Radius of a directory's own star cluster. */
  private clusterRadius(d: DirNode): number {
    const n = d.files.size;
    if (n === 0) return 0.5;
    return this.params.fileSpacing * Math.cbrt((3 * n) / (4 * Math.PI)) + 0.5;
  }

  /** Angular width of a directory's child fan. */
  private fanWidth(d: DirNode): number {
    if (d.parent === null) return Math.PI * 2;
    return Math.min(Math.PI * 1.3, 0.9 + 0.5 * d.dirs.size);
  }

  private sortedChildren(d: DirNode): DirNode[] {
    return [...d.dirs.values()].sort((a, b) => hash01(a.path) - hash01(b.path));
  }

  /**
   * Distance from a system to its ring of child systems. Strict non-overlap of
   * subtree bounding spheres grows exponentially with depth, so this packs by
   * arc length and lets the sparse outer halos of neighbours interleave.
   */
  private ringDistance(d: DirNode, kids: DirNode[]): number {
    let sum = 0;
    let max = 0;
    for (const k of kids) {
      const e = this.extent.get(k.id)!;
      sum += e;
      max = Math.max(max, e);
    }
    const packed = kids.length > 1 ? (sum * 1.1) / this.fanWidth(d) : 0;
    return this.clusterRadius(d) + this.params.gap + Math.max(max * 0.45, packed);
  }

  /** Bottom-up: how far a subtree reaches from its own centre. */
  private measure(d: DirNode): number {
    const kids = [...d.dirs.values()];
    for (const k of kids) this.measure(k);
    let e = this.clusterRadius(d);
    if (kids.length) {
      const dist = this.ringDistance(d, kids);
      for (const k of kids) e = Math.max(e, dist + this.extent.get(k.id)! * 0.7);
    }
    this.extent.set(d.id, e);
    return e;
  }

  /** Top-down: assign targets to a directory's files and child systems. */
  private place(d: DirNode, pos: Vector3, out: Vector3, normal: Vector3, parent: DirNode | null): void {
    // Files: golden-angle directions, cube-root radii → an even ball, flattened into a disc.
    const r = this.clusterRadius(d) - 0.5;
    const n = d.files.size;
    let i = 0;
    for (const f of d.files.values()) {
      this.ensureFile(f.id);
      this.fileDir[f.id] = d.id;
      const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * GOLDEN_ANGLE;
      const rr = n === 1 ? 0 : r * Math.cbrt(((i * 0.618034 + 0.5) % 1) * 0.9 + 0.1);
      // Local frame: y is the disc normal.
      this.setVec(this.fileOffTarget, f.id, Math.cos(phi) * ring * rr, y * rr * this.params.discFlatten, Math.sin(phi) * ring * rr);
      if (!this.fileKnown[f.id]) {
        this.fileKnown[f.id] = 1;
        this.copyVec(this.fileOffTarget, this.fileOff, f.id, 0.05);
        this.setVec(this.fileOffVel, f.id, 0, 0, 0);
      }
      i++;
    }

    const kids = this.sortedChildren(d);
    if (!kids.length) return;
    const dist = this.ringDistance(d, kids);
    const width = this.fanWidth(d);
    let total = 0;
    for (const k of kids) total += this.extent.get(k.id)!;

    // Fan plane: spanned by `out` and a side vector perpendicular to the disc normal.
    const side = new Vector3().crossVectors(normal, out).normalize();
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
    const twist = parent === null ? 0 : this.params.spiralTwist;
    let acc = 0;
    for (const k of kids) {
      const share = (width * this.extent.get(k.id)!) / total;
      const a = (parent === null ? 0 : -width / 2) + acc + share / 2 + twist;
      acc += share;
      const elev = (hash01(k.path, 1) - 0.5) * (parent === null ? 0.25 : 0.7);
      const dir = new Vector3()
        .copy(out)
        .multiplyScalar(Math.cos(a))
        .addScaledVector(side, Math.sin(a))
        .multiplyScalar(Math.cos(elev))
        .addScaledVector(normal, Math.sin(elev))
        .normalize();
      const childPos = new Vector3().copy(pos).addScaledVector(dir, dist);

      // Child disc normal: parent's, tilted by a hashed amount around a hashed axis.
      const tiltAxis = new Vector3().crossVectors(normal, dir).normalize();
      tiltAxis.applyAxisAngle(dir, hash01(k.path, 2) * Math.PI * 2);
      const childNormal = normal.clone().applyAxisAngle(tiltAxis, (hash01(k.path, 3) - 0.3) * this.params.tilt).normalize();

      this.ensureDir(k.id);
      this.setVec(this.dirTarget, k.id, childPos.x, childPos.y, childPos.z);
      this.setVec(this.dirNormal, k.id, childNormal.x, childNormal.y, childNormal.z);
      if (!this.dirKnown[k.id]) {
        // New systems are born at their parent's current position.
        this.dirKnown[k.id] = 1;
        const p = this.dirPos.data;
        this.setVec(this.dirPos, k.id, p[d.id * 3], p[d.id * 3 + 1], p[d.id * 3 + 2]);
        this.setVec(this.dirVel, k.id, 0, 0, 0);
        this.dirSpin.data[k.id] = hash01(k.path, 4) * Math.PI * 2;
      }
      this.place(k, childPos, dir, childNormal, d);
    }
  }

  private ensureDir(id: number): void {
    for (const s of [this.dirTarget, this.dirPos, this.dirVel, this.dirNormal, this.dirSpin]) s.ensure(id);
    if (id >= this.dirKnown.length) {
      const next = new Uint8Array(Math.max(id + 1, this.dirKnown.length * 2));
      next.set(this.dirKnown);
      this.dirKnown = next;
    }
  }

  private ensureFile(id: number): void {
    for (const s of [this.fileOffTarget, this.fileOff, this.fileOffVel]) s.ensure(id);
    if (id >= this.fileKnown.length) {
      const cap = Math.max(id + 1, this.fileKnown.length * 2);
      const known = new Uint8Array(cap);
      known.set(this.fileKnown);
      this.fileKnown = known;
      const dirs = new Int32Array(cap);
      dirs.set(this.fileDir);
      this.fileDir = dirs;
      const pos = new Float32Array(cap * 3);
      pos.set(this.filePositions);
      this.filePositions = pos;
    }
  }

  private setVec(s: Slots, id: number, x: number, y: number, z: number): void {
    const o = id * 3;
    s.data[o] = x;
    s.data[o + 1] = y;
    s.data[o + 2] = z;
  }

  private copyVec(from: Slots, to: Slots, id: number, scale = 1): void {
    const o = id * 3;
    to.data[o] = from.data[o] * scale;
    to.data[o + 1] = from.data[o + 1] * scale;
    to.data[o + 2] = from.data[o + 2] * scale;
  }

  /** Jump every node straight to its target (after a seek). */
  snap(): void {
    this.compute(true);
    const walk = (d: DirNode) => {
      const o = d.id * 3;
      for (let c = 0; c < 3; c++) {
        this.dirPos.data[o + c] = this.dirTarget.data[o + c];
        this.dirVel.data[o + c] = 0;
      }
      for (const f of d.files.values()) {
        const fo = f.id * 3;
        for (let c = 0; c < 3; c++) {
          this.fileOff.data[fo + c] = this.fileOffTarget.data[fo + c];
          this.fileOffVel.data[fo + c] = 0;
        }
      }
      for (const k of d.dirs.values()) walk(k);
    };
    walk(this.state.root);
    this.step(0);
  }

  /** Spring every live node towards its target and write world positions. */
  step(dt: number): void {
    this.time += dt;
    dt = Math.min(dt, 1 / 20);
    const stiffness = 6;
    const damping = 2 * Math.sqrt(stiffness) * 0.9;

    const spring = (pos: Float32Array, vel: Float32Array, tgt: Float32Array, o: number) => {
      for (let c = 0; c < 3; c++) {
        const i = o + c;
        const a = (tgt[i] - pos[i]) * stiffness - vel[i] * damping;
        vel[i] += a * dt;
        pos[i] += vel[i] * dt;
      }
    };

    const state = this.state;
    const walk = (d: DirNode) => {
      spring(this.dirPos.data, this.dirVel.data, this.dirTarget.data, d.id * 3);
      // Smaller systems spin faster, like inner orbits.
      this.dirSpin.data[d.id] += (dt * this.params.spin * 4) / (2 + this.clusterRadius(d));
      for (const k of d.dirs.values()) walk(k);
    };
    walk(state.root);

    const off = this.fileOff.data;
    const vel = this.fileOffVel.data;
    const tgt = this.fileOffTarget.data;
    const dp = this.dirPos.data;
    const dn = this.dirNormal.data;
    const spin = this.dirSpin.data;
    const out = this.filePositions;
    for (const f of state.files.values()) {
      const id = f.id;
      const o = id * 3;
      spring(off, vel, tgt, o);
      const d = this.fileDir[id] * 3;
      // Build the disc frame from its normal, then rotate the local offset by the spin angle.
      const nx = dn[d], ny = dn[d + 1], nz = dn[d + 2];
      // Tangent t = n × x̂, or n × ẑ when n is close to x̂.
      let tx = 0, ty = nz, tz = -ny;
      if (Math.abs(nx) > 0.9) { tx = ny; ty = -nx; tz = 0; }
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      const s = spin[this.fileDir[id]];
      const cs = Math.cos(s), sn = Math.sin(s);
      const lx = off[o] * cs - off[o + 2] * sn;
      const lz = off[o] * sn + off[o + 2] * cs;
      const ly = off[o + 1];
      out[o] = dp[d] + tx * lx + nx * ly + bx * lz;
      out[o + 1] = dp[d + 1] + ty * lx + ny * ly + by * lz;
      out[o + 2] = dp[d + 2] + tz * lx + nz * ly + bz * lz;
    }
  }

  /** World position of a directory (live, not target). */
  dirPosition(id: number, v: Vector3): Vector3 {
    const p = this.dirPos.data;
    return v.set(p[id * 3], p[id * 3 + 1], p[id * 3 + 2]);
  }

  /** World position of a file's star (live). */
  filePosition(id: number, v: Vector3): Vector3 {
    const p = this.filePositions;
    return v.set(p[id * 3], p[id * 3 + 1], p[id * 3 + 2]);
  }

  /** Target (settled) position of a directory. */
  dirTargetPosition(id: number, v: Vector3): Vector3 {
    const p = this.dirTarget.data;
    return v.set(p[id * 3], p[id * 3 + 1], p[id * 3 + 2]);
  }
}
