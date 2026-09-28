import { Color, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { Director } from './camera/Director';
import type { Commit, RepoLog } from './data/types';
import { GalaxyLayout } from './layout/GalaxyLayout';
import { Background } from './render/Background';
import { type Action, Contributors } from './render/Contributors';
import { Filaments } from './render/Filaments';
import { GalacticDust } from './render/GalacticDust';
import { extColor } from './render/palette';
import { Particles } from './render/Particles';
import { Post } from './render/Post';
import { Stars } from './render/Stars';
import { Playback } from './sim/Playback';
import { RepoState } from './sim/RepoState';

export interface AppSettings {
  secondsPerDay: number;
  autoSkipSeconds: number;
  /** Seconds a star stays hot after being touched. */
  heatDecay: number;
  /** Bokeh strength; 0 disables depth of field. */
  aperture: number;
  starSize: number;
  filaments: number;
  nebula: number;
  dust: number;
  particleDensity: number;
  loop: boolean;
}

export const defaultAppSettings: AppSettings = {
  secondsPerDay: 0.6,
  autoSkipSeconds: 1.5,
  heatDecay: 8,
  aperture: 18,
  starSize: 1.4,
  filaments: 0.8,
  nebula: 0.55,
  dust: 0.22,
  particleDensity: 1,
  loop: false,
};

export interface AppHooks {
  onCommit?: (commit: Commit, log: RepoLog) => void;
  onAction?: (action: Action, strength: number) => void;
  onBigCommit?: (commit: Commit, size: number) => void;
  onLoad?: (log: RepoLog) => void;
}

const BEAM_TIME = 0.45;
const RED = new Color(1.0, 0.3, 0.25);
const GREEN = new Color(0.35, 1.0, 0.55);
const WHITE = new Color(1, 1, 1);
const tmpA = new Vector3();
const tmpB = new Vector3();

export class App {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly director: Director;
  readonly post: Post;
  readonly settings: AppSettings = { ...defaultAppSettings };
  hooks: AppHooks = {};

  log: RepoLog | null = null;
  playback: Playback | null = null;
  state = new RepoState();
  layout = new GalaxyLayout(this.state);
  stars: Stars;
  filaments = new Filaments();
  dust = new GalacticDust();
  particles: Particles;
  background: Background;
  contributors: Contributors | null = null;

  /** App clock in seconds; drives every shader. Advances only via advance(). */
  time = 0;
  private layoutClock = 0;
  private doneFor = 0;
  private width = 1;
  private height = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new PerspectiveCamera(55, 1, 0.1, 20000);
    this.camera.position.set(40, 30, 40);
    this.director = new Director(this.camera, canvas);
    this.stars = new Stars(this.renderer);
    this.particles = new Particles(this.renderer);
    this.background = new Background(this.renderer.getPixelRatio());
    this.scene.add(this.background.object, this.dust.object, this.filaments.object, this.stars.object, this.particles.object);
    this.post = new Post(this.renderer, this.scene, this.camera);
    this.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
    this.applySettings();
  }

  resize(w: number, h: number, pixelRatio = Math.min(window.devicePixelRatio, 2)): void {
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // World-size → pixel factor for point sprites.
    const scale = (h * pixelRatio) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.stars.pixelScale = scale * this.settings.starSize;
    this.particles.pixelScale = scale;
    this.dust.pixelScale = scale;
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  load(log: RepoLog): void {
    this.log = log;
    this.playback = new Playback(log.commits, {
      secondsPerDay: this.settings.secondsPerDay,
      autoSkipSeconds: this.settings.autoSkipSeconds,
    });
    if (this.contributors) this.scene.remove(this.contributors.object);
    this.contributors = new Contributors(
      log.authors,
      this.layout,
      (a) => this.fire(a),
      (pos, color) => this.particles.dust(pos, color, this.time, 1),
    );
    this.scene.add(this.contributors.object);
    this.seek(0);
    this.director.establish();
    this.hooks.onLoad?.(log);
  }

  /** Jump to a commit index, rebuilding the tree silently. */
  seek(index: number): void {
    if (!this.playback || !this.log) return;
    this.state.reset();
    this.layout.reset();
    this.stars.clear();
    this.particles.clear();
    this.contributors?.clear();
    const skipped = this.playback.seek(index);
    for (const c of skipped) this.state.apply(c);
    this.layout.snap();
    const now = this.playback.simTime;
    const spd = this.settings.secondsPerDay;
    for (const f of this.state.files.values()) {
      this.stars.restore(f, this.time, ((now - f.lastTouched) / 86400) * spd);
    }
  }

  applySettings(): void {
    const s = this.settings;
    if (this.playback) {
      this.playback.opts.secondsPerDay = s.secondsPerDay;
      this.playback.opts.autoSkipSeconds = s.autoSkipSeconds;
    }
    this.stars.uniforms.uHeatDecay.value = s.heatDecay;
    this.stars.uniforms.uAperture.value = s.aperture;
    this.filaments.uniforms.uOpacity.value = s.filaments;
    this.background.uniforms.uIntensity.value = s.nebula;
    this.dust.uniforms.uOpacity.value = s.dust;
    this.particles.density = s.particleDensity;
    this.resize(this.width, this.height, this.renderer.getPixelRatio());
  }

  /** A contributor's change reaches its star. */
  private fire({ author, applied }: Action): void {
    const contributors = this.contributors!;
    const from = contributors.position(author, tmpA);
    const color = contributors.colorOf(author);
    const file = applied.file;
    const to = this.layout.filePosition(file.id, tmpB);
    const fileColor = extColor(file.ext);
    const t = this.time;
    const hitAt = t + BEAM_TIME;
    const lines = applied.change.add + applied.change.del;
    const strength = Math.min(1, Math.log2(1 + lines) / 9);

    switch (applied.kind) {
      case 'add':
        this.particles.beam(from, to, color, t, 0.5);
        this.stars.add(file, hitAt);
        this.particles.flash(to, fileColor, hitAt, 3 + strength * 5);
        this.particles.ring(to, fileColor, hitAt, 5 + strength * 10);
        this.particles.sparks(to, fileColor, hitAt, 6 + strength * 14, 2 + strength * 3);
        break;
      case 'modify': {
        this.particles.beam(from, to, color, t, strength);
        this.stars.touchFile(file, hitAt, 0.3 + strength * 0.9);
        const tint = applied.change.add >= applied.change.del ? GREEN : RED;
        this.particles.sparks(to, tint, hitAt, 2 + strength * 16, 1 + strength * 3);
        if (strength > 0.6) this.particles.ring(to, tint, hitAt, 4 + strength * 8, 0.7);
        break;
      }
      case 'delete':
        this.particles.beam(from, to, RED, t, 0.4);
        this.stars.remove(file, hitAt);
        this.particles.implode(to, fileColor, hitAt - 0.1, 3);
        this.particles.flash(to, RED, hitAt + 0.35, 3, 0.3);
        this.particles.dust(to, fileColor, hitAt + 0.4, 12);
        break;
      case 'rename': {
        const prev = applied.prev;
        if (prev) {
          const old = this.layout.filePosition(prev.id, new Vector3());
          this.stars.remove(prev, t);
          this.particles.streak(old, to, fileColor, t);
          this.stars.add(file, t + 1.05);
          this.particles.flash(to, WHITE, t + 1.05, 3);
        } else {
          this.stars.add(file, hitAt);
        }
        this.particles.beam(from, to, color, t, 0.3);
        break;
      }
    }
    this.director.hit(to, 1 + strength * 2);
    this.hooks.onAction?.({ author, applied }, strength);
  }

  private onCommit(commit: Commit): void {
    const applied = this.state.apply(commit);
    this.contributors!.enqueue(commit.author, applied, this.time);
    this.hooks.onCommit?.(commit, this.log!);
    const size = commit.changes.reduce((n, c) => n + c.add + c.del, 0);
    if (commit.changes.length > 40 || size > 3000) {
      const amount = Math.min(1, Math.log10(size + commit.changes.length * 20) / 5);
      this.post.punch(amount);
      this.director.punch(amount);
      this.hooks.onBigCommit?.(commit, size);
    }
  }

  /** Advance everything by dt seconds and render one frame. */
  advance(dt: number): void {
    this.time += dt;
    const pb = this.playback;
    if (pb && this.contributors) {
      const tick = pb.update(dt);
      if (tick.skipped) this.director.establish();
      for (const c of tick.commits) this.onCommit(c);
      if (pb.done && this.settings.loop) {
        this.doneFor += dt;
        if (this.doneFor > 6) {
          this.doneFor = 0;
          this.seek(0);
          this.director.establish();
        }
      }

      this.layoutClock += dt;
      if (this.layoutClock > 0.12) {
        this.layoutClock = 0;
        this.layout.compute();
      }
      this.layout.step(dt);
      this.contributors.update(dt, this.time);
    }

    this.particles.update(this.time);
    this.stars.update(this.time, this.layout);
    this.filaments.update(this.state, this.layout);
    this.dust.update(dt, this.time, this.layout.radius);
    this.director.update(dt, this.layout.radius);
    this.background.update(this.time, this.camera.position);
    this.stars.uniforms.uFocus.value = this.director.focusDistance;
    this.post.render(dt);
  }
}
