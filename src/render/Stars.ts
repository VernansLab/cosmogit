import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, type WebGLRenderer } from 'three';
import type { GalaxyLayout } from '../layout/GalaxyLayout';
import type { FileNode } from '../sim/RepoState';
import { extColor } from './palette';

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uScale;
  uniform float uMaxSize;
  uniform float uHeatDecay;
  uniform float uFocus;
  uniform float uAperture;
  uniform float uMinSize;
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aBorn;
  attribute float aTouch;
  attribute float aPulse;
  attribute float aDied;
  varying vec3 vColor;
  varying float vHeat;
  varying float vAlpha;
  varying float vBlur;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    float age = uTime - aBorn;
    float since = max(0.0, uTime - aTouch);
    float heat = exp(-since / uHeatDecay);
    float pulse = aPulse * exp(-since * 2.5);
    // Birth: pop in with an overshoot flash.
    float born = smoothstep(0.0, 0.5, age) * (1.0 + 2.0 * exp(-age * 5.0));
    float alive = 1.0;
    if (aDied > 0.0) {
      float d = (uTime - aDied) / 0.8;
      alive = d >= 1.0 ? 0.0 : (1.0 - d) * (1.0 + 3.0 * exp(-d * 10.0));
    }
    float twinkle = 0.88 + 0.12 * sin(uTime * (2.0 + mod(float(gl_VertexID), 7.0) * 0.4) + float(gl_VertexID));
    float size = aSize * (1.0 + 1.8 * pulse + 0.6 * heat) * born * alive * twinkle;
    // Depth of field: out-of-focus stars spread into dimmer bokeh discs.
    float depth = max(-mv.z, 0.001);
    float px = size * uScale / depth;
    float blurPx = uAperture * abs(depth - uFocus) / depth;
    float total = sqrt(px * px + blurPx * blurPx);
    float energy = px * px / max(total * total, 1e-4);
    vBlur = blurPx / max(total, 1e-4);
    // Never shrink below a couple of pixels, dimming instead, so far systems stay visible.
    float shown = max(total, uMinSize);
    energy *= total * total / (shown * shown) * 0.7 + 0.3;
    gl_PointSize = clamp(shown, 0.0, uMaxSize);
    if (aBorn < -1e5 || size <= 0.0) gl_PointSize = 0.0;

    // Hot stars burn blue-white; cold ones sink into a dim, reddened version of their colour.
    vec3 cold = aColor * vec3(1.0, 0.75, 0.65) * 0.8;
    vec3 hot = mix(aColor, vec3(0.75, 0.88, 1.0), 0.55) * 2.2;
    vColor = mix(cold, hot, heat) + aColor * pulse * 3.0;
    vColor *= max(energy, 0.03) * (1.0 + vBlur * 1.5);
    vHeat = (heat + pulse) * (1.0 - vBlur);
    vAlpha = alive;
  }
`;

const fragment = /* glsl */ `
  varying vec3 vColor;
  varying float vHeat;
  varying float vAlpha;
  varying float vBlur;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    float core = exp(-d * d * 22.0);
    float halo = exp(-d * 5.0) * 0.35;
    // Diffraction spikes on hot stars.
    float spikes = (max(0.0, 1.0 - abs(p.x) * 40.0) + max(0.0, 1.0 - abs(p.y) * 40.0)) * (1.0 - d) * 0.6 * min(vHeat, 1.5);
    float sharp = (core + halo + spikes) * (1.0 - smoothstep(0.8, 1.0, d));
    // Bokeh: flat disc with a brighter rim.
    float bokeh = (1.0 - smoothstep(0.82, 1.0, d)) * (0.55 + 0.45 * smoothstep(0.5, 0.95, d)) * 0.35;
    float a = mix(sharp, bokeh, smoothstep(0.2, 0.8, vBlur));
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

/** aBorn value for slots that hold no star. */
const UNUSED = -1e6;

/** One point sprite per file ever seen, indexed by file id. */
export class Stars {
  readonly object: Points;
  private geometry = new BufferGeometry();
  private material: ShaderMaterial;
  private cap = 0;
  private count = 0;

  private position!: BufferAttribute;
  private color!: BufferAttribute;
  private size!: BufferAttribute;
  private born!: BufferAttribute;
  private touch!: BufferAttribute;
  private pulse!: BufferAttribute;
  private died!: BufferAttribute;

  constructor(renderer: WebGLRenderer) {
    const range = renderer.getContext().getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE) as Float32Array;
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 300 },
        uMaxSize: { value: Math.min(range[1], 256) },
        uHeatDecay: { value: 6 },
        uFocus: { value: 50 },
        uAperture: { value: 0 },
        uMinSize: { value: 3 * window.devicePixelRatio },
      },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.grow(1024);
    this.object = new Points(this.geometry, this.material);
    this.object.frustumCulled = false;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  set pixelScale(v: number) {
    this.material.uniforms.uScale.value = v;
  }

  private grow(cap: number): void {
    const make = (itemSize: number, old?: BufferAttribute, fill = 0) => {
      const arr = new Float32Array(cap * itemSize).fill(fill);
      if (old) arr.set(old.array as Float32Array);
      return new BufferAttribute(arr, itemSize);
    };
    this.position = make(3, this.position);
    this.color = make(3, this.color);
    this.size = make(1, this.size);
    this.born = make(1, this.born, UNUSED);
    this.touch = make(1, this.touch, -1000);
    this.pulse = make(1, this.pulse);
    this.died = make(1, this.died);
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('aColor', this.color);
    this.geometry.setAttribute('aSize', this.size);
    this.geometry.setAttribute('aBorn', this.born);
    this.geometry.setAttribute('aTouch', this.touch);
    this.geometry.setAttribute('aPulse', this.pulse);
    this.geometry.setAttribute('aDied', this.died);
    this.cap = cap;
  }

  private ensure(id: number): void {
    if (id >= this.cap) {
      let cap = this.cap;
      while (cap <= id) cap *= 2;
      this.grow(cap);
    }
    this.count = Math.max(this.count, id + 1);
    this.geometry.setDrawRange(0, this.count);
  }

  private sizeFor(file: FileNode): number {
    return 0.6 + Math.log2(1 + file.lines) * 0.22;
  }

  add(file: FileNode, time: number): void {
    this.ensure(file.id);
    const c = extColor(file.ext);
    this.color.setXYZ(file.id, c.r, c.g, c.b);
    this.size.setX(file.id, this.sizeFor(file));
    this.born.setX(file.id, time);
    this.touch.setX(file.id, time);
    this.pulse.setX(file.id, 1);
    this.died.setX(file.id, 0);
    this.markAll();
  }

  /** A modification: strength ~ diff size, 0..1. */
  touchFile(file: FileNode, time: number, strength: number): void {
    this.ensure(file.id);
    this.size.setX(file.id, this.sizeFor(file));
    this.touch.setX(file.id, time);
    this.pulse.setX(file.id, strength);
    this.markAll();
  }

  remove(file: FileNode, time: number): void {
    if (file.id >= this.cap) return;
    this.died.setX(file.id, time);
    this.touch.setX(file.id, time);
    this.markAll();
  }

  /** Forget everything (seek). */
  clear(): void {
    (this.born.array as Float32Array).fill(UNUSED);
    (this.died.array as Float32Array).fill(0);
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
    this.markAll();
  }

  /** Instantly place a file with no birth animation (used when seeking). */
  restore(file: FileNode, time: number, touchedAgo: number): void {
    this.ensure(file.id);
    const c = extColor(file.ext);
    this.color.setXYZ(file.id, c.r, c.g, c.b);
    this.size.setX(file.id, this.sizeFor(file));
    this.born.setX(file.id, time - 10);
    this.touch.setX(file.id, time - touchedAgo);
    this.pulse.setX(file.id, 0);
    this.died.setX(file.id, 0);
    this.markAll();
  }

  private dirty = false;
  private markAll(): void {
    this.dirty = true;
  }

  update(time: number, layout: GalaxyLayout): void {
    this.material.uniforms.uTime.value = time;
    const src = layout.filePositions;
    const dst = this.position.array as Float32Array;
    const n = Math.min(this.count * 3, src.length, dst.length);
    dst.set(src.subarray(0, n));
    this.position.needsUpdate = true;
    if (this.dirty) {
      for (const a of [this.color, this.size, this.born, this.touch, this.pulse, this.died]) a.needsUpdate = true;
      this.dirty = false;
    }
  }
}
