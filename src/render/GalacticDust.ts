import { cameraViewMatrix, clamp, cos, exp, float, Fn, instancedArray, length, max, sin, uniform, uv, varying, vec3, vec4 } from 'three/tsl';
import { AdditiveBlending, PointsNodeMaterial, Sprite, type StorageBufferNode } from 'three/webgpu';

function gauss(): number {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

/**
 * Decorative spiral-arm dust in the galactic plane, scaled to the repo's
 * galaxy. Purely ambient: it gives the constellations a galaxy to live in.
 */
export class GalacticDust {
  readonly object: Sprite;
  private radius = 10;

  readonly uniforms = {
    uTime: uniform(0),
    uRadius: uniform(10),
    uScale: uniform(300),
    uOpacity: uniform(0.22),
  };

  constructor(count = 24000, arms = 3) {
    const pos = instancedArray(count, 'vec4') as StorageBufferNode<'vec4'>;
    const col = instancedArray(count, 'vec4') as StorageBufferNode<'vec4'>;
    const p = pos.value.array as Float32Array;
    const c = col.value.array as Float32Array;
    for (let i = 0; i < count; i++) {
      // Radius in unit galaxy space, denser towards the core.
      const r = Math.pow(Math.random(), 1.6) * 1.15;
      const arm = i % arms;
      const theta = (arm / arms) * Math.PI * 2 + Math.log(1 + r * 6) * 2.2 + gauss() * (0.18 + 0.25 * (1 - r));
      const spread = 0.04 + 0.06 * r;
      p[i * 4] = Math.cos(theta) * r + gauss() * spread;
      p[i * 4 + 1] = gauss() * (0.02 + 0.08 * Math.exp(-r * 4));
      p[i * 4 + 2] = Math.sin(theta) * r + gauss() * spread;
      p[i * 4 + 3] = 0.0025 + Math.random() ** 3 * 0.008;
      // Warm core, blue-violet arms, occasional pink star-forming knots.
      const t = Math.min(1, r * 1.3);
      const knot = Math.random() < 0.04;
      c[i * 4] = knot ? 1.0 : 1.0 - 0.6 * t;
      c[i * 4 + 1] = knot ? 0.45 : 0.78 - 0.3 * t;
      c[i * 4 + 2] = knot ? 0.75 : 0.55 + 0.45 * t;
    }

    const u = this.uniforms;
    const P = pos.toAttribute();
    const C = col.toAttribute();
    // Differential rotation: inner dust orbits faster.
    const ang = u.uTime.mul(0.04).div(length(P.xz).add(0.3));
    const cs = cos(ang);
    const sn = sin(ang);
    const world = vec3(P.x.mul(cs).sub(P.z.mul(sn)), P.y, P.x.mul(sn).add(P.z.mul(cs))).mul(u.uRadius);
    const depth = max(cameraViewMatrix.mul(vec4(world, 1)).z.negate(), 0.001);
    const vColor = varying(C.xyz);

    const material = new PointsNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: false });
    material.positionNode = world;
    material.sizeNode = clamp(P.w.mul(u.uRadius).mul(u.uScale).div(depth), 1, 64);
    material.colorNode = Fn(() => {
      const d = length(uv().sub(0.5)).mul(2);
      const a = exp(d.mul(d).mul(-4)).mul(clamp(float(1).sub(d), 0, 1));
      return vec4(vColor.mul(a).mul(u.uOpacity), 1);
    })();
    this.object = new Sprite(material);
    this.object.count = count;
    this.object.frustumCulled = false;
    this.object.renderOrder = -5;
  }

  set pixelScale(v: number) {
    this.uniforms.uScale.value = v;
  }

  update(dt: number, time: number, galaxyRadius: number): void {
    // Ease towards the galaxy's size so growth feels continuous.
    this.radius += (galaxyRadius * 1.1 - this.radius) * (1 - Math.exp(-dt * 0.8));
    this.uniforms.uRadius.value = this.radius;
    this.uniforms.uTime.value = time;
  }
}
