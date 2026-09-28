import { AdditiveBlending, BufferAttribute, BufferGeometry, LineSegments, ShaderMaterial } from 'three';
import type { GalaxyLayout } from '../layout/GalaxyLayout';
import type { DirNode, RepoState } from '../sim/RepoState';

const vertex = /* glsl */ `
  attribute float aFade;
  varying float vFade;
  void main() {
    vFade = aFade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    gl_FragColor = vec4(uColor * uOpacity * vFade, 1.0);
  }
`;

/** Faint cosmic-web strands from every system to its parent. */
export class Filaments {
  readonly object: LineSegments;
  private geometry = new BufferGeometry();
  private material: ShaderMaterial;
  private cap = 0;
  private positions!: BufferAttribute;
  private fade!: BufferAttribute;

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uColor: { value: [0.45, 0.6, 1.0] },
        uOpacity: { value: 0.8 },
      },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.grow(256);
    this.object = new LineSegments(this.geometry, this.material);
    this.object.frustumCulled = false;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  private grow(cap: number): void {
    this.positions = new BufferAttribute(new Float32Array(cap * 6), 3);
    this.fade = new BufferAttribute(new Float32Array(cap * 2), 1);
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setAttribute('aFade', this.fade);
    this.cap = cap;
  }

  update(state: RepoState, layout: GalaxyLayout): void {
    const p = layout.dirPositions;
    let seg = 0;
    const visit = (d: DirNode) => {
      for (const k of d.dirs.values()) {
        if (seg >= this.cap) this.grow(this.cap * 2);
        const pos = this.positions.array as Float32Array;
        const fade = this.fade.array as Float32Array;
        const o = seg * 6;
        pos[o] = p[d.id * 3];
        pos[o + 1] = p[d.id * 3 + 1];
        pos[o + 2] = p[d.id * 3 + 2];
        pos[o + 3] = p[k.id * 3];
        pos[o + 4] = p[k.id * 3 + 1];
        pos[o + 5] = p[k.id * 3 + 2];
        // Brighter near the core, dimmer out at the tips of the arms.
        fade[seg * 2] = 1 / (1 + d.depth * 0.5);
        fade[seg * 2 + 1] = 0.5 / (1 + k.depth * 0.5);
        seg++;
        visit(k);
      }
    };
    visit(state.root);
    this.positions.needsUpdate = true;
    this.fade.needsUpdate = true;
    this.geometry.setDrawRange(0, seg * 2);
  }
}
