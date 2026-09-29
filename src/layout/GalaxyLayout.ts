import { Vector3 } from 'three/webgpu';
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
 * compute() sets targets when the tree changes. Directories spring towards
 * theirs on the CPU in step(); there are few of them. Files only get a target
 * offset in their system's disc frame: the GPU springs and spins them
 * (see render/Stars.ts), and filePosition() evaluates the settled position
 * analytically for the CPU's few needs (beam targets, camera).
 */
export class GalaxyLayout {
  params: LayoutParams;

  // Directory state (stride 3): target, current, velocity, disc normal; plus spin angle.
  private dirTarget = new Slots(3);
  private dirPos = new Slots(3);
  private dirVel = new Slots(3);
  private dirNormal = new Slots(3);
  private dirSpin = new Slots(1);
  private dirKnown = new Uint8Array(256);

  /** Per file (stride 4): target offset xyz in the disc frame, w = directory id. */
  fileTargets = new Float32Array(256 * 4);
  /** Bumped whenever fileTargets changes, so the GPU copy can be refreshed. */
  targetsVersion = 0;

  /** Overall galaxy radius, for camera framing. */
  radius = 10;
  private extent = new Map<number, number>();
  private lastVersion = -1;
  /** filesVersion each directory's stars were last placed at (-1 = never). */
  private placedFiles = new Int32Array(256).fill(-1);
  /** Per-directory sort key, hashed once. */
  private seeds = new Map<number, number>();

  constructor(
    private state: RepoState,
    params: Partial<LayoutParams> = {},
  ) {
    this.params = { ...defaultLayoutParams, ...params };
  }

  /** Live directory positions (stride 3), indexed by dir id. */
  get dirPositions(): Float32Array {
    return this.dirPos.data;
  }

  /** Forget all nodes (after RepoState.reset()). */
  reset(): void {
    this.dirKnown.fill(0);
    this.placedFiles.fill(-1);
    this.seeds.clear();
    this.lastVersion = -1;
  }

  /** Recompute targets if the tree changed (or `force`). */
  compute(force = false): void {
    if (!force && this.state.version === this.lastVersion) return;
    if (force) this.placedFiles.fill(-1);
    this.lastVersion = this.state.version;
    this.extent.clear();
    const root = this.state.root;
    this.measure(root);
    this.ensureDir(root.id);
    this.dirKnown[root.id] = 1;
    this.setVec(this.dirTarget, root.id, 0, 0, 0);
    this.setVec(this.dirNormal, root.id, 0, 1, 0);
    this.place(root, new Vector3(), new Vector3(1, 0, 0), UP.clone(), null);
    this.radius = Math.max(10, this.extent.get(root.id) ?? 10);
    this.targetsVersion++;
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

  private seed(d: DirNode): number {
    let s = this.seeds.get(d.id);
    if (s === undefined) {
      s = hash01(d.path);
      this.seeds.set(d.id, s);
    }
    return s;
  }

  private sortedChildren(d: DirNode): DirNode[] {
    return [...d.dirs.values()].sort((a, b) => this.seed(a) - this.seed(b));
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
    // Star offsets only depend on this directory's own file list; skip if unchanged.
    if (d.id >= this.placedFiles.length) {
      const next = new Int32Array(Math.max(d.id + 1, this.placedFiles.length * 2)).fill(-1);
      next.set(this.placedFiles);
      this.placedFiles = next;
    }
    const filesDirty = this.placedFiles[d.id] !== d.filesVersion;
    this.placedFiles[d.id] = d.filesVersion;
    const r = this.clusterRadius(d) - 0.5;
    const n = filesDirty ? d.files.size : 0;
    let i = 0;
    for (const f of filesDirty ? d.files.values() : []) {
      this.ensureFile(f.id);
      const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * GOLDEN_ANGLE;
      const rr = n === 1 ? 0 : r * Math.cbrt(((i * 0.618034 + 0.5) % 1) * 0.9 + 0.1);
      // Local frame: y is the disc normal.
      const o = f.id * 4;
      this.fileTargets[o] = Math.cos(phi) * ring * rr;
      this.fileTargets[o + 1] = y * rr * this.params.discFlatten;
      this.fileTargets[o + 2] = Math.sin(phi) * ring * rr;
      this.fileTargets[o + 3] = d.id;
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
    if ((id + 1) * 4 <= this.fileTargets.length) return;
    let len = this.fileTargets.length;
    while (len < (id + 1) * 4) len *= 2;
    const next = new Float32Array(len);
    next.set(this.fileTargets);
    this.fileTargets = next;
  }

  private setVec(s: Slots, id: number, x: number, y: number, z: number): void {
    const o = id * 3;
    s.data[o] = x;
    s.data[o + 1] = y;
    s.data[o + 2] = z;
  }

  /** Jump every directory straight to its target (after a seek). */
  snap(): void {
    this.compute(true);
    const walk = (d: DirNode) => {
      const o = d.id * 3;
      for (let c = 0; c < 3; c++) {
        this.dirPos.data[o + c] = this.dirTarget.data[o + c];
        this.dirVel.data[o + c] = 0;
      }
      for (const k of d.dirs.values()) walk(k);
    };
    walk(this.state.root);
  }

  /** Spring every live directory towards its target and advance spins. */
  step(dt: number): void {
    dt = Math.min(dt, 1 / 20);
    const stiffness = 6;
    const damping = 2 * Math.sqrt(stiffness) * 0.9;
    const pos = this.dirPos.data;
    const vel = this.dirVel.data;
    const tgt = this.dirTarget.data;
    const walk = (d: DirNode) => {
      const o = d.id * 3;
      for (let c = 0; c < 3; c++) {
        const i = o + c;
        const a = (tgt[i] - pos[i]) * stiffness - vel[i] * damping;
        vel[i] += a * dt;
        pos[i] += vel[i] * dt;
      }
      // Smaller systems spin faster, like inner orbits.
      this.dirSpin.data[d.id] += (dt * this.params.spin * 4) / (2 + this.clusterRadius(d));
      for (const k of d.dirs.values()) walk(k);
    };
    walk(this.state.root);
  }

  /**
   * Pack directory frames for the GPU: per dir, vec4(position, spin) and
   * vec4(normal, 0). Returns the number of directories written.
   */
  packDirs(posSpin: Float32Array, normals: Float32Array): number {
    const n = Math.min(this.dirKnown.length, posSpin.length / 4);
    const p = this.dirPos.data;
    const nm = this.dirNormal.data;
    const sp = this.dirSpin.data;
    const count = Math.min(n, p.length / 3);
    for (let i = 0; i < count; i++) {
      posSpin[i * 4] = p[i * 3];
      posSpin[i * 4 + 1] = p[i * 3 + 1];
      posSpin[i * 4 + 2] = p[i * 3 + 2];
      posSpin[i * 4 + 3] = sp[i];
      normals[i * 4] = nm[i * 3];
      normals[i * 4 + 1] = nm[i * 3 + 1];
      normals[i * 4 + 2] = nm[i * 3 + 2];
    }
    return count;
  }

  /** World position of a directory (live, not target). */
  dirPosition(id: number, v: Vector3): Vector3 {
    const p = this.dirPos.data;
    return v.set(p[id * 3], p[id * 3 + 1], p[id * 3 + 2]);
  }

  /**
   * World position of a file's star: its directory's live position plus the
   * target offset, rotated into the spinning disc frame. The same maths runs
   * on the GPU in Stars.ts; keep them in sync.
   */
  filePosition(id: number, v: Vector3): Vector3 {
    const o = id * 4;
    if (o + 3 >= this.fileTargets.length) return v.set(0, 0, 0);
    const d = this.fileTargets[o + 3];
    const lx0 = this.fileTargets[o];
    const ly = this.fileTargets[o + 1];
    const lz0 = this.fileTargets[o + 2];
    const dn = this.dirNormal.data;
    const dp = this.dirPos.data;
    const nx = dn[d * 3], ny = dn[d * 3 + 1], nz = dn[d * 3 + 2];
    // Tangent t = n × x̂, or n × ẑ when n is close to x̂; bitangent b = n × t.
    let tx = 0, ty = nz, tz = -ny;
    if (Math.abs(nx) > 0.9) { tx = ny; ty = -nx; tz = 0; }
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const s = this.dirSpin.data[d];
    const cs = Math.cos(s), sn = Math.sin(s);
    const lx = lx0 * cs - lz0 * sn;
    const lz = lx0 * sn + lz0 * cs;
    return v.set(
      dp[d * 3] + tx * lx + nx * ly + bx * lz,
      dp[d * 3 + 1] + ty * lx + ny * ly + by * lz,
      dp[d * 3 + 2] + tz * lx + nz * ly + bz * lz,
    );
  }

  /** Target (settled) position of a directory. */
  dirTargetPosition(id: number, v: Vector3): Vector3 {
    const p = this.dirTarget.data;
    return v.set(p[id * 3], p[id * 3 + 1], p[id * 3 + 2]);
  }
}
