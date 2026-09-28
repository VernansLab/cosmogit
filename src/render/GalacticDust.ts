import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uRadius;
  uniform float uScale;
  attribute vec3 aColor;
  attribute float aSize;
  varying vec3 vColor;
  void main() {
    // Differential rotation: inner dust orbits faster.
    float r = length(position.xz);
    float ang = uTime * 0.04 / (0.3 + r);
    float c = cos(ang), s = sin(ang);
    vec3 p = vec3(position.x * c - position.z * s, position.y, position.x * s + position.z * c) * uRadius;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(aSize * uRadius * uScale / -mv.z, 1.0, 64.0);
    vColor = aColor;
  }
`;

const fragment = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = exp(-d * d * 4.0) * (1.0 - d);
    gl_FragColor = vec4(vColor * a * uOpacity, 1.0);
  }
`;

function gauss(): number {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

/**
 * Decorative spiral-arm dust in the galactic plane, scaled to the repo's
 * galaxy. Purely ambient: it gives the constellations a galaxy to live in.
 */
export class GalacticDust {
  readonly object: Points;
  private material: ShaderMaterial;
  private radius = 10;

  constructor(count = 24000, arms = 3) {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Radius in unit galaxy space, denser towards the core.
      const r = Math.pow(Math.random(), 1.6) * 1.15;
      const arm = i % arms;
      const theta = (arm / arms) * Math.PI * 2 + Math.log(1 + r * 6) * 2.2 + gauss() * (0.18 + 0.25 * (1 - r));
      const spread = 0.04 + 0.06 * r;
      pos[i * 3] = Math.cos(theta) * r + gauss() * spread;
      pos[i * 3 + 1] = gauss() * (0.02 + 0.08 * Math.exp(-r * 4));
      pos[i * 3 + 2] = Math.sin(theta) * r + gauss() * spread;
      // Warm core, blue-violet arms, occasional pink star-forming knots.
      const t = Math.min(1, r * 1.3);
      const knot = Math.random() < 0.04;
      col[i * 3] = knot ? 1.0 : 1.0 - 0.6 * t;
      col[i * 3 + 1] = knot ? 0.45 : 0.78 - 0.3 * t;
      col[i * 3 + 2] = knot ? 0.75 : 0.55 + 0.45 * t;
      size[i] = 0.0025 + Math.random() ** 3 * 0.008;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new BufferAttribute(col, 3));
    geo.setAttribute('aSize', new BufferAttribute(size, 1));
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uTime: { value: 0 },
        uRadius: { value: 10 },
        uScale: { value: 300 },
        uOpacity: { value: 0.22 },
      },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.object = new Points(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = -5;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  set pixelScale(v: number) {
    this.material.uniforms.uScale.value = v;
  }

  update(dt: number, time: number, galaxyRadius: number): void {
    // Ease towards the galaxy's size so growth feels continuous.
    this.radius += (galaxyRadius * 1.1 - this.radius) * (1 - Math.exp(-dt * 0.8));
    this.material.uniforms.uRadius.value = this.radius;
    this.material.uniforms.uTime.value = time;
  }
}
