import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { chromaticAberration } from 'three/examples/jsm/tsl/display/ChromaticAberrationNode.js';
import { film } from 'three/examples/jsm/tsl/display/FilmNode.js';
import { float, length, mix, pass, vec2, renderOutput, screenUV, smoothstep, uniform, vec4 } from 'three/tsl';
import { ACESFilmicToneMapping, type Node, type PerspectiveCamera, RenderPipeline, type Scene, type WebGPURenderer } from 'three/webgpu';

export interface PostSettings {
  bloom: boolean;
  bloomIntensity: number;
  bloomThreshold: number;
  chromatic: boolean;
  chromaticAmount: number;
  vignette: boolean;
  grain: boolean;
  grainAmount: number;
}

export const defaultPostSettings: PostSettings = {
  bloom: true,
  bloomIntensity: 0.9,
  bloomThreshold: 0.25,
  chromatic: true,
  chromaticAmount: 0.12,
  vignette: true,
  grain: true,
  grainAmount: 0.12,
};

/**
 * HDR post chain on three's node pipeline:
 * scene → bloom → ACES tonemap → chromatic aberration → vignette → film grain.
 */
export class Post {
  readonly pipeline: RenderPipeline;
  private bloomNode;
  private uChroma = uniform(0);
  private uVignette = uniform(1);
  private uGrain = uniform(0.12);
  /** Extra aberration that decays over time; kicked by big commits. */
  private kick = 0;

  constructor(
    renderer: WebGPURenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    public settings: PostSettings = { ...defaultPostSettings },
  ) {
    renderer.toneMapping = ACESFilmicToneMapping;
    this.pipeline = new RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output');
    this.bloomNode = bloom(color, 0.9, 0.6, 0.25);
    const hdr = color.add(this.bloomNode);
    const toned = renderOutput(hdr);
    // The CA node's typings don't expose it as a vec4 node, though it is one.
    const lens = chromaticAberration(toned, this.uChroma, vec2(0.5, 0.5), float(1.1)) as unknown as Node<'vec4'>;
    const dist = length(screenUV.sub(0.5)).mul(1.414);
    const vignette = mix(float(1), float(1).sub(smoothstep(0.35, 1.05, dist).mul(0.75)), this.uVignette);
    const shaded = vec4(lens.rgb.mul(vignette), 1);
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = film(shaded, this.uGrain);
    this.apply();
  }

  /** Push settings into the effects. Call after editing `settings`. */
  apply(): void {
    const s = this.settings;
    this.bloomNode.strength.value = s.bloom ? s.bloomIntensity : 0;
    this.bloomNode.threshold.value = s.bloomThreshold;
    this.uVignette.value = s.vignette ? 1 : 0;
    this.uGrain.value = s.grain ? s.grainAmount : 0;
  }

  /** Momentary lens distortion, 0..1. */
  punch(amount: number): void {
    this.kick = Math.min(1, this.kick + amount);
  }

  render(dt: number): void {
    this.kick *= Math.exp(-dt * 4);
    this.uChroma.value = this.settings.chromatic ? this.settings.chromaticAmount * (1 + this.kick * 6) : 0;
    this.pipeline.render();
  }
}
