import { AdditiveBlending, BufferAttribute, BufferGeometry, type Color, Points, ShaderMaterial, Vector3, type WebGLRenderer } from 'three';

export const enum PType {
  Beam = 0,
  Spark = 1,
  Implode = 2,
  Dust = 3,
  Ring = 4,
  Flash = 5,
}

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uScale;
  uniform float uMaxSize;
  attribute vec3 aEnd;
  attribute vec3 aCtrl;
  attribute float aBirth;
  attribute float aLife;
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aType;
  varying vec3 vColor;
  varying float vT;
  varying float vType;

  void main() {
    float t = (uTime - aBirth) / aLife;
    vT = t;
    vType = aType;
    vColor = aColor;
    if (t < 0.0 || t > 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec3 p = position;
    float size = aSize;
    int type = int(aType + 0.5);
    if (type == 0) {
      // Beam: quadratic bezier from author to star, eased.
      float e = t * t * (3.0 - 2.0 * t);
      p = mix(mix(position, aCtrl, e), mix(aCtrl, aEnd, e), e);
      size *= 0.6 + 0.8 * sin(t * 3.14159);
    } else if (type == 1) {
      // Spark: decelerating burst.
      p = position + aCtrl * (1.0 - (1.0 - t) * (1.0 - t));
      size *= 1.0 - t;
    } else if (type == 2) {
      // Implosion: rush inwards, accelerating.
      p = mix(position, aEnd, t * t);
      size *= 0.4 + t;
    } else if (type == 3) {
      // Dust: slow drift.
      p = position + aCtrl * t;
      size *= 1.0 - t * 0.5;
    } else if (type == 4) {
      // Shockwave ring grows.
      size *= 0.15 + 1.0 * sqrt(t);
    } else if (type == 5) {
      // Flash.
      size *= 0.5 + 0.8 * sqrt(t);
    }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(size * uScale / -mv.z, 0.0, uMaxSize);
  }
`;

const fragment = /* glsl */ `
  varying vec3 vColor;
  varying float vT;
  varying float vType;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    int type = int(vType + 0.5);
    float a;
    if (type == 4) {
      float w = 0.06 + 0.1 * vT;
      a = exp(-pow((d - 0.85) / w, 2.0)) * pow(1.0 - vT, 1.5) * 1.5;
    } else if (type == 5) {
      a = (exp(-d * d * 8.0) * 2.0 + exp(-d * 3.0) * 0.4) * pow(1.0 - vT, 2.0);
    } else if (type == 0) {
      a = exp(-d * d * 10.0) * sin(vT * 3.14159) * 1.4;
    } else if (type == 3) {
      a = exp(-d * d * 6.0) * (1.0 - vT) * 0.5;
    } else {
      a = exp(-d * d * 12.0) * (1.0 - vT * vT);
    }
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

const CAPACITY = 1 << 16;
const tmp = new Vector3();
const tmp2 = new Vector3();

/** Ring-buffered GPU particles; motion is computed analytically in the shader. */
export class Particles {
  readonly object: Points;
  private geometry = new BufferGeometry();
  private material: ShaderMaterial;
  private head = 0;
  private attrs: Record<string, BufferAttribute> = {};
  private dirtyFrom = -1;
  private dirtyTo = -1;
  private wrapped = false;
  /** Global multiplier on how many particles effects emit. */
  density = 1;

  constructor(renderer: WebGLRenderer) {
    const range = renderer.getContext().getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE) as Float32Array;
    const add = (name: string, size: number, fill = 0) => {
      const a = new BufferAttribute(new Float32Array(CAPACITY * size).fill(fill), size);
      this.geometry.setAttribute(name, a);
      this.attrs[name] = a;
    };
    add('position', 3);
    add('aEnd', 3);
    add('aCtrl', 3);
    add('aBirth', 1, -1000);
    add('aLife', 1, 1);
    add('aColor', 3);
    add('aSize', 1);
    add('aType', 1);
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 300 },
        uMaxSize: { value: Math.min(range[1], 512) },
      },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.object = new Points(this.geometry, this.material);
    this.object.frustumCulled = false;
  }

  set pixelScale(v: number) {
    this.material.uniforms.uScale.value = v;
  }

  private emit(type: PType, start: Vector3, end: Vector3, ctrl: Vector3, color: Color, size: number, birth: number, life: number): void {
    const i = this.head;
    this.head = (this.head + 1) % CAPACITY;
    if (this.head === 0) this.wrapped = true;
    const a = this.attrs;
    a.position.setXYZ(i, start.x, start.y, start.z);
    a.aEnd.setXYZ(i, end.x, end.y, end.z);
    a.aCtrl.setXYZ(i, ctrl.x, ctrl.y, ctrl.z);
    a.aBirth.setX(i, birth);
    a.aLife.setX(i, life);
    a.aColor.setXYZ(i, color.r, color.g, color.b);
    a.aSize.setX(i, size);
    a.aType.setX(i, type);
    if (this.dirtyFrom === -1) this.dirtyFrom = i;
    this.dirtyTo = i;
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
    (this.attrs.aBirth.array as Float32Array).fill(-1000);
    this.attrs.aBirth.needsUpdate = true;
    this.dirtyFrom = -1;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
    if (this.dirtyFrom === -1) return;
    for (const a of Object.values(this.attrs)) {
      a.clearUpdateRanges();
      if (this.wrapped || this.dirtyTo < this.dirtyFrom) {
        // Wrapped around the ring: just upload it all.
        a.needsUpdate = true;
      } else {
        a.addUpdateRange(this.dirtyFrom * a.itemSize, (this.dirtyTo - this.dirtyFrom + 1) * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.wrapped = false;
    this.dirtyFrom = -1;
  }
}
