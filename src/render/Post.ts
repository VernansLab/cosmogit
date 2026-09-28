import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { HalfFloatType, type PerspectiveCamera, type Scene, Vector2, type WebGLRenderer } from 'three';

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
  bloomIntensity: 1.6,
  bloomThreshold: 0.15,
  chromatic: true,
  chromaticAmount: 0.0012,
  vignette: true,
  grain: true,
  grainAmount: 0.06,
};

/** HDR post chain: bloom → ACES tonemapping → chromatic aberration, vignette, grain. */
export class Post {
  readonly composer: EffectComposer;
  private bloom: BloomEffect;
  private tone: ToneMappingEffect;
  private chroma: ChromaticAberrationEffect;
  private vignette: VignetteEffect;
  private noise: NoiseEffect;
  private hdrPass: EffectPass;
  private lensPass: EffectPass;
  /** Extra aberration that decays over time; kicked by big commits. */
  private kick = 0;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    public settings: PostSettings = { ...defaultPostSettings },
  ) {
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(scene, camera));

    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.15, luminanceSmoothing: 0.2, intensity: 1.6, radius: 0.75, levels: 8 });
    this.tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.hdrPass = new EffectPass(camera, this.bloom, this.tone);
    this.composer.addPass(this.hdrPass);

    this.chroma = new ChromaticAberrationEffect({ offset: new Vector2(0.001, 0.001), radialModulation: true, modulationOffset: 0.2 });
    this.vignette = new VignetteEffect({ offset: 0.3, darkness: 0.65 });
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.lensPass = new EffectPass(camera, this.chroma, this.vignette, this.noise);
    this.composer.addPass(this.lensPass);
    this.apply();
  }

  /** Push settings into the effects. Call after editing `settings`. */
  apply(): void {
    const s = this.settings;
    this.bloom.intensity = s.bloom ? s.bloomIntensity : 0;
    this.bloom.luminanceMaterial.threshold = s.bloomThreshold;
    this.vignette.blendMode.opacity.value = s.vignette ? 1 : 0;
    this.noise.blendMode.opacity.value = s.grain ? s.grainAmount : 0;
  }

  /** Momentary lens distortion, 0..1. */
  punch(amount: number): void {
    this.kick = Math.min(1, this.kick + amount);
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(dt: number): void {
    this.kick *= Math.exp(-dt * 4);
    const a = this.settings.chromatic ? this.settings.chromaticAmount * (1 + this.kick * 6) : 0;
    this.chroma.offset.set(a, a * 0.6);
    this.composer.render(dt);
  }
}
