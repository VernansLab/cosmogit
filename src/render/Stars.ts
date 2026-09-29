import {
  abs,
  cameraViewMatrix,
  clamp,
  cos,
  cross,
  exp,
  float,
  Fn,
  If,
  instancedArray,
  instanceIndex,
  int,
  ivec2,
  length,
  max,
  mix,
  mod,
  normalize,
  select,
  sin,
  smoothstep,
  sqrt,
  textureLoad,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { AdditiveBlending, DataTexture, FloatType, NearestFilter, PointsNodeMaterial, RGBAFormat, Sprite, type StorageBufferNode, type WebGPURenderer } from 'three/webgpu';
import type { GalaxyLayout } from '../layout/GalaxyLayout';
import type { FileNode } from '../sim/RepoState';
import { extColor } from './palette';

/** `life.x` (birth time) for slots that hold no star. */
const UNUSED = -1e6;

/** Tracks the id range written since the last upload. */
export class DirtyRange {
  from = Infinity;
  to = -1;
  mark(i: number): void {
    if (i < this.from) this.from = i;
    if (i > this.to) this.to = i;
  }
  get empty(): boolean {
    return this.to < 0;
  }
  reset(): void {
    this.from = Infinity;
    this.to = -1;
  }
}

type Vec4Array = StorageBufferNode<'vec4'>;

/** Row width of the per-directory data textures. */
const DIR_TEX_WIDTH = 1024;

function dirTexture(capacity: number): DataTexture {
  const height = Math.max(1, Math.ceil(capacity / DIR_TEX_WIDTH));
  const tex = new DataTexture(new Float32Array(DIR_TEX_WIDTH * height * 4), DIR_TEX_WIDTH, height, RGBAFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Upload only the dirty slice of a vec4 storage buffer. */
export function uploadRange(node: Vec4Array, range: DirtyRange): void {
  if (range.empty) return;
  const attr = node.value;
  attr.clearUpdateRanges();
  attr.addUpdateRange(range.from * 4, (range.to - range.from + 1) * 4);
  attr.needsUpdate = true;
  range.reset();
}

/**
 * One star per file, all on the GPU.
 *
 * Buffers (one vec4 per file id):
 *   targets  (CPU → GPU)  offset target in the disc frame, w = directory id
 *   offset   (GPU)        current offset, w = initialised flag
 *   velocity (GPU)        spring velocity
 *   world    (GPU)        world position, written by the compute pass, read by the material
 *   life     (CPU → GPU)  born, last touched, pulse strength, died
 *   look     (CPU → GPU)  rgb, base size
 * plus per directory: position + spin angle, disc normal (uploaded every frame).
 * Directory data lives in float textures rather than storage buffers: the
 * kernel gathers it by directory id, which the WebGL2 fallback (transform
 * feedback) can only do through texelFetch.
 *
 * A compute pass springs every offset towards its target and spins it with
 * its system; the material draws each star as an instanced quad with heat,
 * pulses, birth/death animation and per-star bokeh depth of field.
 */
export class Stars {
  readonly object: Sprite;
  readonly capacity: number;
  private material: PointsNodeMaterial;

  private targets: Vec4Array;
  private life: Vec4Array;
  private look: Vec4Array;
  private dirPos: DataTexture;
  private dirNrm: DataTexture;
  private kernel;
  private lifeDirty = new DirtyRange();
  private lookDirty = new DirtyRange();
  private targetsVersion = -1;
  private snapNext = true;

  readonly uniforms = {
    uTime: uniform(0),
    uDt: uniform(0),
    uSnap: uniform(0),
    uScale: uniform(300),
    uMinSize: uniform(2.5),
    uMaxSize: uniform(56),
    uHeatDecay: uniform(8),
    uFocus: uniform(50),
    uAperture: uniform(0),
  };

  constructor(fileCapacity: number, dirCapacity: number) {
    const cap = Math.max(1, fileCapacity);
    const dcap = Math.max(1, dirCapacity);
    this.capacity = cap;
    const u = this.uniforms;

    this.targets = instancedArray(cap, 'vec4');
    const offset = instancedArray(cap, 'vec4');
    const velocity = instancedArray(cap, 'vec4');
    const world = instancedArray(cap, 'vec4');
    this.life = instancedArray(cap, 'vec4');
    this.look = instancedArray(cap, 'vec4');
    this.dirPos = dirTexture(dcap);
    this.dirNrm = dirTexture(dcap);
    const lifeArr = this.life.value.array as Float32Array;
    for (let i = 0; i < cap; i++) lifeArr[i * 4] = UNUSED;

    const targets = this.targets;
    const dirPos = this.dirPos;
    const dirNrm = this.dirNrm;

    // Spring + spin. Mirrors GalaxyLayout.filePosition(); keep them in sync.
    this.kernel = Fn(() => {
      const i = instanceIndex;
      const tgt = targets.element(i).toVar();
      const off = offset.element(i).toVar();
      const vel = velocity.element(i).toVar();

      If(off.w.equal(0).or(u.uSnap.greaterThan(0.5)), () => {
        // New stars start near their system's centre; a snap puts them straight on target.
        off.assign(vec4(tgt.xyz.mul(select(u.uSnap.greaterThan(0.5), float(1), float(0.05))), 1));
        vel.assign(vec4(0));
      });

      const stiffness = 6;
      const damping = 2 * Math.sqrt(stiffness) * 0.9;
      const acc = tgt.xyz.sub(off.xyz).mul(stiffness).sub(vel.xyz.mul(damping));
      vel.assign(vec4(vel.xyz.add(acc.mul(u.uDt)), 0));
      off.assign(vec4(off.xyz.add(vel.xyz.mul(u.uDt)), 1));
      offset.element(i).assign(off);
      velocity.element(i).assign(vel);

      const d = int(tgt.w);
      const texel = ivec2(d.mod(DIR_TEX_WIDTH), d.div(DIR_TEX_WIDTH));
      const ps = textureLoad(dirPos, texel).toVar();
      const n = textureLoad(dirNrm, texel).xyz.toVar();
      const t = vec3(0, n.z, n.y.negate()).toVar();
      If(abs(n.x).greaterThan(0.9), () => {
        t.assign(vec3(n.y, n.x.negate(), 0));
      });
      t.assign(normalize(t));
      const b = cross(n, t);
      const cs = cos(ps.w);
      const sn = sin(ps.w);
      const lx = off.x.mul(cs).sub(off.z.mul(sn));
      const lz = off.x.mul(sn).add(off.z.mul(cs));
      world.element(i).assign(vec4(ps.xyz.add(t.mul(lx)).add(n.mul(off.y)).add(b.mul(lz)), 1));
    })().compute(cap);

    // ---- Material ----
    const W = world.toAttribute();
    const L = this.life.toAttribute();
    const K = this.look.toAttribute();
    const idx = float(instanceIndex);

    const age = u.uTime.sub(L.x);
    const since = max(float(0), u.uTime.sub(L.y));
    const heat = exp(since.negate().div(u.uHeatDecay));
    const pulse = L.z.mul(exp(since.mul(-2.5)));
    // Birth: pop in with an overshoot flash.
    const born = smoothstep(0, 0.5, age).mul(exp(age.mul(-5)).mul(2).add(1));
    const deathT = u.uTime.sub(L.w).div(0.8);
    const dying = select(deathT.greaterThanEqual(1), float(0), float(1).sub(deathT).mul(exp(deathT.mul(-10)).mul(3).add(1)));
    const alive = select(L.w.greaterThan(0), dying, float(1));
    const twinkle = sin(u.uTime.mul(mod(idx, 7).mul(0.4).add(2)).add(idx)).mul(0.12).add(0.88);
    const size = K.w.mul(pulse.mul(0.9).add(heat.mul(0.4)).add(1)).mul(born).mul(alive).mul(twinkle);

    // Depth of field: out-of-focus stars spread into dimmer bokeh discs.
    const depth = max(cameraViewMatrix.mul(vec4(W.xyz, 1)).z.negate(), 0.001);
    const px = size.mul(u.uScale).div(depth);
    const blurPx = u.uAperture.mul(abs(depth.sub(u.uFocus))).div(depth);
    const total = sqrt(px.mul(px).add(blurPx.mul(blurPx)));
    const blur = blurPx.div(max(total, 1e-4));
    // Never shrink below a couple of pixels, dimming instead, so far systems stay visible.
    const shown = max(total, u.uMinSize);
    const energy = px
      .mul(px)
      .div(max(total.mul(total), 1e-4))
      .mul(total.mul(total).div(shown.mul(shown)).mul(0.7).add(0.3));
    const pointSize = select(L.x.lessThan(-1e5).or(size.lessThanEqual(0)), float(0), clamp(shown, 0, u.uMaxSize));

    // Hot stars burn blue-white; cold ones sink into a dim, reddened version of their colour.
    const cold = K.xyz.mul(vec3(1.0, 0.75, 0.65)).mul(0.8);
    const hot = mix(K.xyz, vec3(0.75, 0.88, 1.0), 0.55).mul(2.2);
    const color = mix(cold, hot, heat)
      .add(K.xyz.mul(pulse).mul(2))
      .mul(max(energy, 0.03))
      .mul(blur.mul(1.5).add(1));
    const vColor = varying(color);
    const vBlur = varying(blur);
    const vHeat = varying(heat.add(pulse).mul(float(1).sub(blur)));

    const shape = Fn(() => {
      const p = uv().sub(0.5);
      const dd = length(p).mul(2);
      const core = exp(dd.mul(dd).mul(-22));
      const halo = exp(dd.mul(-5)).mul(0.35);
      const spikes = max(float(0), float(1).sub(abs(p.x).mul(40)))
        .add(max(float(0), float(1).sub(abs(p.y).mul(40))))
        .mul(float(1).sub(dd))
        .mul(0.3)
        .mul(clamp(vHeat, 0, 1.2));
      const sharp = core.add(halo).add(spikes).mul(float(1).sub(smoothstep(0.8, 1.0, dd)));
      const bokeh = float(1).sub(smoothstep(0.82, 1.0, dd)).mul(smoothstep(0.5, 0.95, dd).mul(0.45).add(0.55)).mul(0.35);
      const a = mix(sharp, bokeh, smoothstep(0.2, 0.8, vBlur)).mul(float(1).sub(smoothstep(0.98, 1.0, dd)));
      return vec4(vColor.mul(a), 1);
    });

    this.material = new PointsNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: false });
    this.material.positionNode = W.xyz;
    this.material.sizeNode = pointSize;
    this.material.colorNode = shape();
    this.object = new Sprite(this.material);
    this.object.count = cap;
    this.object.frustumCulled = false;
  }

  /** CSS-pixel scale for world sizes: viewport height / (2·tan(fov/2)). */
  set pixelScale(v: number) {
    this.uniforms.uScale.value = v;
  }

  private writeLife(id: number, born: number | null, touch: number | null, pulse: number | null, died: number | null): void {
    if (id >= this.capacity) return;
    const a = this.life.value.array as Float32Array;
    const o = id * 4;
    if (born !== null) a[o] = born;
    if (touch !== null) a[o + 1] = touch;
    if (pulse !== null) a[o + 2] = pulse;
    if (died !== null) a[o + 3] = died;
    this.lifeDirty.mark(id);
  }

  private writeLook(file: FileNode): void {
    if (file.id >= this.capacity) return;
    const a = this.look.value.array as Float32Array;
    const c = extColor(file.ext);
    const o = file.id * 4;
    a[o] = c.r;
    a[o + 1] = c.g;
    a[o + 2] = c.b;
    a[o + 3] = 0.6 + Math.log2(1 + file.lines) * 0.22;
    this.lookDirty.mark(file.id);
  }

  add(file: FileNode, time: number): void {
    this.writeLook(file);
    this.writeLife(file.id, time, time, 1, 0);
  }

  /** A modification: strength ~ diff size, 0..1. */
  touchFile(file: FileNode, time: number, strength: number): void {
    this.writeLook(file);
    this.writeLife(file.id, null, time, strength, null);
  }

  remove(file: FileNode, time: number): void {
    this.writeLife(file.id, null, time, null, time);
  }

  /** Forget every star (seek). The next compute pass snaps offsets to their targets. */
  clear(): void {
    const a = this.life.value.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) {
      a[i * 4] = UNUSED;
      a[i * 4 + 3] = 0;
    }
    this.lifeDirty.mark(0);
    this.lifeDirty.mark(this.capacity - 1);
    this.snapNext = true;
  }

  /** Instantly place a file with no birth animation (used when seeking). */
  restore(file: FileNode, time: number, touchedAgo: number): void {
    this.writeLook(file);
    this.writeLife(file.id, time - 10, time - touchedAgo, 0, 0);
  }

  update(renderer: WebGPURenderer, time: number, dt: number, layout: GalaxyLayout): void {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uDt.value = Math.min(dt, 1 / 20);
    u.uSnap.value = this.snapNext ? 1 : 0;
    this.snapNext = false;

    if (layout.targetsVersion !== this.targetsVersion) {
      this.targetsVersion = layout.targetsVersion;
      const dst = this.targets.value.array as Float32Array;
      dst.set(layout.fileTargets.subarray(0, Math.min(dst.length, layout.fileTargets.length)));
      this.targets.value.clearUpdateRanges();
      this.targets.value.needsUpdate = true;
    }
    layout.packDirs(this.dirPos.image.data as Float32Array, this.dirNrm.image.data as Float32Array);
    this.dirPos.needsUpdate = true;
    this.dirNrm.needsUpdate = true;
    uploadRange(this.life, this.lifeDirty);
    uploadRange(this.look, this.lookDirty);

    renderer.compute(this.kernel);
  }

  dispose(): void {
    this.material.dispose();
    this.dirPos.dispose();
    this.dirNrm.dispose();
  }
}
