import { clamp, exp, float, Fn, instancedArray, length, mix, mx_fractal_noise_float, normalize, positionLocal, pow, sin, smoothstep, uniform, uv, varying, vec3, vec4 } from 'three/tsl';
import { AdditiveBlending, BackSide, Group, Mesh, MeshBasicNodeMaterial, PointsNodeMaterial, SphereGeometry, Sprite, type StorageBufferNode } from 'three/webgpu';

const SKY_RADIUS = 9000;

/** Procedural nebula skybox plus a far, twinkling starfield. Follows the camera. */
export class Background {
  readonly object = new Group();

  readonly uniforms = {
    uTime: uniform(0),
    uIntensity: uniform(0.55),
  };

  constructor() {
    const u = this.uniforms;

    // ---- Nebula ----
    const nebula = Fn(() => {
      const d = normalize(positionLocal);
      const t = u.uTime.mul(0.004);
      // MaterialX fractal noise is roughly in [-1, 1]; remap to [0, 1].
      const n1 = mx_fractal_noise_float(d.mul(2.2).add(vec3(t, 0, t.negate())), 5, 2.03, 0.5).mul(0.5).add(0.5);
      const n2 = mx_fractal_noise_float(d.mul(4.5).add(vec3(0, t.mul(1.5), 0)).add(n1.mul(1.5)), 5, 2.03, 0.5).mul(0.5).add(0.5);
      // A milky band across the sky.
      const band = exp(pow(d.y.mul(2.2).add(n1.sub(0.5).mul(1.2)), 2).negate());
      const colA = vec3(0.18, 0.05, 0.35);
      const colB = vec3(0.02, 0.2, 0.35);
      const colC = vec3(0.55, 0.15, 0.35);
      const col = mix(mix(colA, colB, smoothstep(0.3, 0.75, n2)), colC, smoothstep(0.55, 0.9, n1.mul(n2).mul(1.8)));
      const density = pow(smoothstep(0.35, 0.95, n2), 1.6).mul(band.mul(0.65).add(0.35));
      return vec4(vec3(0.004, 0.005, 0.012).add(col.mul(density).mul(u.uIntensity)), 1);
    });
    const skyMat = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, depthTest: false });
    skyMat.colorNode = nebula();
    const sky = new Mesh(new SphereGeometry(SKY_RADIUS, 64, 32), skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;

    // ---- Far stars ----
    const n = 6000;
    const data = instancedArray(n, 'vec4') as StorageBufferNode<'vec4'>;
    const arr = data.value.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const y = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      const R = SKY_RADIUS * 0.9;
      arr.set([r * Math.cos(a) * R, y * R, r * Math.sin(a) * R, Math.random()], i * 4);
    }
    const S = data.toAttribute();
    // w carries a random phase; derive size from it too.
    const size = pow(S.w, 6).mul(3).add(0.8);
    const vB = varying(sin(u.uTime.mul(S.w.add(0.5)).add(S.w.mul(30))).mul(0.4).add(0.6));
    const starMat = new PointsNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, sizeAttenuation: false });
    starMat.positionNode = S.xyz;
    starMat.sizeNode = size;
    starMat.colorNode = Fn(() => {
      const d = length(uv().sub(0.5)).mul(2);
      const a = exp(d.mul(d).mul(-6)).mul(vB).mul(clamp(float(1).sub(d), 0, 1));
      return vec4(vec3(0.8, 0.85, 1.0).mul(a), 1);
    })();
    const field = new Sprite(starMat);
    field.count = n;
    field.renderOrder = -9;
    field.frustumCulled = false;

    this.object.add(sky, field);
  }

  update(time: number, cameraPosition: { x: number; y: number; z: number }): void {
    this.uniforms.uTime.value = time;
    this.object.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
  }
}
