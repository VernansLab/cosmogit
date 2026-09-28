import { AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Group, Mesh, Points, ShaderMaterial, SphereGeometry } from 'three';

const nebulaVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // Always at the far plane.
  }
`;

const nebulaFragment = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  varying vec3 vDir;

  // 3D value noise + fbm.
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
                   mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                   mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 6; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    float t = uTime * 0.004;
    float n1 = fbm(d * 2.2 + vec3(t, 0.0, -t));
    float n2 = fbm(d * 4.5 - vec3(0.0, t * 1.5, 0.0) + n1 * 1.5);
    float band = exp(-pow(d.y * 2.2 + (n1 - 0.5) * 1.2, 2.0)); // a milky band
    vec3 col = mix(uColorA, uColorB, smoothstep(0.3, 0.75, n2));
    col = mix(col, uColorC, smoothstep(0.55, 0.9, n1 * n2 * 1.8));
    float density = pow(smoothstep(0.35, 0.95, n2), 1.6) * (0.35 + 0.65 * band);
    vec3 base = vec3(0.004, 0.005, 0.012);
    gl_FragColor = vec4(base + col * density * uIntensity, 1.0);
  }
`;

const starVertex = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  uniform float uTime;
  varying float vB;
  void main() {
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
    vB = 0.6 + 0.4 * sin(uTime * (0.5 + aPhase) + aPhase * 30.0);
    gl_PointSize = aSize;
  }
`;

const starFragment = /* glsl */ `
  varying float vB;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = exp(-d * d * 6.0) * vB;
    gl_FragColor = vec4(vec3(0.8, 0.85, 1.0) * a, 1.0);
  }
`;

/** Procedural nebula skybox plus a far, twinkling starfield. Follows the camera. */
export class Background {
  readonly object = new Group();
  private nebula: ShaderMaterial;
  private stars: ShaderMaterial;

  constructor(pixelRatio: number) {
    this.nebula = new ShaderMaterial({
      vertexShader: nebulaVertex,
      fragmentShader: nebulaFragment,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0.55 },
        uColorA: { value: [0.18, 0.05, 0.35] },
        uColorB: { value: [0.02, 0.2, 0.35] },
        uColorC: { value: [0.55, 0.15, 0.35] },
      },
      side: BackSide,
      depthWrite: false,
      depthTest: false,
    });
    const sky = new Mesh(new SphereGeometry(1, 64, 32), this.nebula);
    sky.renderOrder = -10;
    sky.frustumCulled = false;

    const n = 6000;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos.set([r * Math.cos(a), u, r * Math.sin(a)], i * 3);
      size[i] = (Math.random() ** 6 * 3 + 0.8) * pixelRatio;
      phase[i] = Math.random();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new BufferAttribute(phase, 1));
    this.stars = new ShaderMaterial({
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: { uTime: { value: 0 } },
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    const field = new Points(geo, this.stars);
    field.renderOrder = -9;
    field.frustumCulled = false;
    this.object.add(sky, field);
  }

  get uniforms() {
    return this.nebula.uniforms;
  }

  update(time: number, cameraPosition: { x: number; y: number; z: number }): void {
    this.nebula.uniforms.uTime.value = time;
    this.stars.uniforms.uTime.value = time;
    this.object.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
  }
}
