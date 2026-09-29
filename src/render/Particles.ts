import { cameraViewMatrix, clamp, exp, float, Fn, instancedArray, length, max, mix, pow, select, sin, sqrt, uniform, uv, varying, vec4 } from 'three/tsl';
import { AdditiveBlending, type Color, PointsNodeMaterial, Sprite, type StorageBufferNode, Vector3 } from 'three/webgpu';
import { DirtyRange } from './Stars';

export const enum PType {
  Beam = 0,
  Spark = 1,
  Implode = 2,
  Dust = 3,
  Ring = 4,
  Flash = 5,
}

const CAPACITY = 1 << 16;
const tmp = new Vector3();
const tmp2 = new Vector3();

/**
 * Ring-buffered GPU particles; motion is computed analytically in the vertex
 * stage from four vec4s per particle:
 *   a: start.xyz, birth    b: end.xyz, life    c: ctrl.xyz, type    d: rgb, size
 */
export class Particles {
  readonly object: Sprite;
  private material: PointsNodeMaterial;
  private buffers: StorageBufferNode<'vec4'>[];
  private head = 0;
  private dirty = new DirtyRange();
  private wrapped = false;
  /** Global multiplier on how many particles effects emit. */
  density = 1;

  readonly uniforms = {
    uTime: uniform(0),
    uScale: uniform(300),
    uMaxSize: uniform(400),
  };

  constructor() {
    const [a, b, c, d] = (this.buffers = [0, 1, 2, 3].map(() => instancedArray(CAPACITY, 'vec4') as StorageBufferNode<'vec4'>));
    const aArr = a.value.array as Float32Array;
    for (let i = 0; i < CAPACITY; i++) aArr[i * 4 + 3] = -1000;
    const u = this.uniforms;

    const A = a.toAttribute();
    const B = b.toAttribute();
    const C = c.toAttribute();
    const D = d.toAttribute();
    const type = C.w;
    const is = (t: PType) => type.greaterThan(t - 0.5).and(type.lessThan(t + 0.5));
    const t = u.uTime.sub(A.w).div(B.w);
    const live = t.greaterThanEqual(0).and(t.lessThanEqual(1));
    const tc = clamp(t, 0, 1);

    // Beam: quadratic bezier from author to star, eased.
    const e = tc.mul(tc).mul(float(3).sub(tc.mul(2)));
    const beamPos = mix(mix(A.xyz, C.xyz, e), mix(C.xyz, B.xyz, e), e);
    const onec = float(1).sub(tc);
    const sparkPos = A.xyz.add(C.xyz.mul(float(1).sub(onec.mul(onec))));
    const implodePos = mix(A.xyz, B.xyz, tc.mul(tc));
    const dustPos = A.xyz.add(C.xyz.mul(tc));
    const pos = select(is(PType.Beam), beamPos, select(is(PType.Spark), sparkPos, select(is(PType.Implode), implodePos, select(is(PType.Dust), dustPos, A.xyz))));

    const pi = Math.PI;
    const sizeMul = select(
      is(PType.Beam),
      sin(tc.mul(pi)).mul(0.8).add(0.6),
      select(
        is(PType.Spark),
        onec,
        select(
          is(PType.Implode),
          tc.add(0.4),
          select(is(PType.Dust), float(1).sub(tc.mul(0.5)), select(is(PType.Ring), sqrt(tc).add(0.15), sqrt(tc).mul(0.8).add(0.5))),
        ),
      ),
    );
    const depth = max(cameraViewMatrix.mul(vec4(pos, 1)).z.negate(), 0.001);
    const px = D.w.mul(sizeMul).mul(u.uScale).div(depth);
    const pointSize = select(live, clamp(px, 0, u.uMaxSize), float(0));

    const vT = varying(tc);
    const vType = varying(type);
    const vColor = varying(D.xyz);

    const shape = Fn(() => {
      const dd = length(uv().sub(0.5)).mul(2);
      const isT = (k: PType) => vType.greaterThan(k - 0.5).and(vType.lessThan(k + 0.5));
      const w = vT.mul(0.1).add(0.06);
      const ring = exp(pow(dd.sub(0.85).div(w), 2).negate()).mul(pow(float(1).sub(vT), 1.5)).mul(1.5);
      const flash = exp(dd.mul(dd).mul(-8)).mul(2).add(exp(dd.mul(-3)).mul(0.4)).mul(pow(float(1).sub(vT), 2));
      const beam = exp(dd.mul(dd).mul(-10)).mul(sin(vT.mul(pi))).mul(1.4);
      const dust = exp(dd.mul(dd).mul(-6)).mul(float(1).sub(vT)).mul(0.5);
      const spark = exp(dd.mul(dd).mul(-12)).mul(float(1).sub(vT.mul(vT)));
      const alpha = select(isT(PType.Ring), ring, select(isT(PType.Flash), flash, select(isT(PType.Beam), beam, select(isT(PType.Dust), dust, spark))));
      const fade = float(1).sub(clamp(dd.sub(0.97).mul(33), 0, 1));
      return vec4(vColor.mul(alpha).mul(fade), 1);
    });

    this.material = new PointsNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: false });
    this.material.positionNode = pos;
    this.material.sizeNode = pointSize;
    this.material.colorNode = shape();
    this.object = new Sprite(this.material);
    this.object.count = CAPACITY;
    this.object.frustumCulled = false;
  }

  set pixelScale(v: number) {
    this.uniforms.uScale.value = v;
  }

  private emit(type: PType, start: Vector3, end: Vector3, ctrl: Vector3, color: Color, size: number, birth: number, life: number): void {
    const i = this.head;
    this.head = (this.head + 1) % CAPACITY;
    if (this.head === 0) this.wrapped = true;
    const [a, b, c, d] = this.buffers.map((n) => n.value.array as Float32Array);
    const o = i * 4;
    a[o] = start.x; a[o + 1] = start.y; a[o + 2] = start.z; a[o + 3] = birth;
    b[o] = end.x; b[o + 1] = end.y; b[o + 2] = end.z; b[o + 3] = life;
    c[o] = ctrl.x; c[o + 1] = ctrl.y; c[o + 2] = ctrl.z; c[o + 3] = type;
    d[o] = color.r; d[o + 1] = color.g; d[o + 2] = color.b; d[o + 3] = size;
    this.dirty.mark(i);
  }

  private count(n: number): number {
    return Math.max(1, Math.round(n * this.density));
  }

  /** A stream of particles arcing from `from` to `to`. */
  beam(from: Vector3, to: Vector3, color: Color, time: number, strength = 1): void {
    const dist = from.distanceTo(to);
    // Bend the arc sideways by a random amount.
    tmp.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(dist * 0.5).add(from).lerp(to, 0.5);
    const n = this.count(6 + strength * 10);
    for (let i = 0; i < n; i++) {
      this.emit(PType.Beam, from, to, tmp, color, 0.9 + strength * 0.6, time + i * 0.025, 0.55 + Math.random() * 0.1);
    }
  }

  sparks(at: Vector3, color: Color, time: number, n: number, speed: number, delay = 0): void {
    n = this.count(n);
    for (let i = 0; i < n; i++) {
      tmp2.randomDirection().multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      this.emit(PType.Spark, at, at, tmp2, color, 0.5 + Math.random() * 0.5, time + delay, 0.6 + Math.random() * 0.6);
    }
  }

  implode(at: Vector3, color: Color, time: number, radius: number): void {
    const n = this.count(18);
    for (let i = 0; i < n; i++) {
      tmp.randomDirection().multiplyScalar(radius).add(at);
      this.emit(PType.Implode, tmp, at, at, color, 0.6, time, 0.45 + Math.random() * 0.1);
    }
  }

  dust(at: Vector3, color: Color, time: number, n: number): void {
    n = this.count(n);
    for (let i = 0; i < n; i++) {
      tmp2.randomDirection().multiplyScalar(0.6 + Math.random());
      this.emit(PType.Dust, at, at, tmp2, color, 0.5, time, 2 + Math.random() * 1.5);
    }
  }

  ring(at: Vector3, color: Color, time: number, size: number, life = 0.9): void {
    this.emit(PType.Ring, at, at, at, color, size, time, life);
  }

  flash(at: Vector3, color: Color, time: number, size: number, life = 0.35): void {
    this.emit(PType.Flash, at, at, at, color, size, time, life);
  }

  /** A comet flying from one place to another (renames). */
  streak(from: Vector3, to: Vector3, color: Color, time: number): void {
    tmp.copy(from).lerp(to, 0.5);
    tmp.y += from.distanceTo(to) * 0.25;
    const n = this.count(24);
    for (let i = 0; i < n; i++) {
      const head = i === 0 ? 2.2 : 1.2 * (1 - i / n);
      this.emit(PType.Beam, from, to, tmp, color, head, time + i * 0.012, 1.1);
    }
  }

  clear(): void {
    const a = this.buffers[0].value.array as Float32Array;
    for (let i = 0; i < CAPACITY; i++) a[i * 4 + 3] = -1000;
    this.dirty.mark(0);
    this.dirty.mark(CAPACITY - 1);
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
    if (this.dirty.empty) return;
    const whole = this.wrapped;
    for (const n of this.buffers) {
      const attr = n.value;
      attr.clearUpdateRanges();
      // After wrapping around the ring the dirty span is not contiguous: upload it all.
      if (!whole) attr.addUpdateRange(this.dirty.from * 4, (this.dirty.to - this.dirty.from + 1) * 4);
      attr.needsUpdate = true;
    }
    this.dirty.reset();
    this.wrapped = false;
  }
}
