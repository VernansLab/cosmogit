import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { type PerspectiveCamera, Vector3 } from 'three/webgpu';

interface Hit {
  pos: Vector3;
  t: number;
  w: number;
}

export type CameraMode = 'auto' | 'free';

/**
 * Cinematic shots the auto camera cuts between. Each shapes where the camera
 * wants to be; damping blends one into the next, so "cuts" are smooth moves.
 */
export type ShotKind = 'orbit' | 'swoop' | 'skim' | 'overhead' | 'chase' | 'wide';

interface Shot {
  kind: ShotKind;
  start: number;
  duration: number;
  /** Orbit direction for this shot (+1 / -1). */
  spin: number;
}

const SHOT_WEIGHTS: Record<ShotKind, number> = {
  orbit: 3,
  swoop: 2.5,
  skim: 2,
  overhead: 1.2,
  chase: 2.5,
  wide: 1,
};

const tmp = new Vector3();
const UP = new Vector3(0, 1, 0);

/** Exponential smoothing that is frame-rate independent. */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/**
 * Cinematic auto-camera. Follows the weighted centroid of recent activity and
 * frames it by how spread out it is, while cycling through shots: orbits,
 * swoops in close, skims along the galactic plane, looks down from above,
 * chases the busiest contributor, and pulls wide. Big commits dolly in.
 * Any user input hands control to OrbitControls; after a while of no input
 * it eases back to auto.
 */
export class Director {
  readonly controls: OrbitControls;
  mode: CameraMode = 'auto';
  /** When true, never return to auto on its own. */
  locked = false;
  returnAfter = 10;
  /** 0 = calm, slow orbit only; 1 = restless, frequent dramatic shots. */
  energy = 0.45;
  /** How much of the frame should be the whole galaxy vs. the hotspot (0..1). */
  context = 0.25;

  private hits: Hit[] = [];
  private target = new Vector3();
  private azimuth = 0.6;
  private azimuthSpeed = 0;
  private elevation = 0.5;
  private distance = 60;
  private roll = 0;
  private dolly = 0;
  private wide = 0;
  private lastInput = -Infinity;
  private time = 0;
  private lastEstablish = -Infinity;
  private shot: Shot = { kind: 'wide', start: 0, duration: 6, spin: 1 };
  /** Position of the contributor to chase, set by the app each frame. */
  private pilot: Vector3 | null = null;

  constructor(
    private camera: PerspectiveCamera,
    dom: HTMLElement,
  ) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener('start', () => this.takeOver());
  }

  get focusDistance(): number {
    return this.camera.position.distanceTo(this.mode === 'auto' ? this.target : this.controls.target);
  }

  get currentShot(): ShotKind {
    return this.shot.kind;
  }

  private takeOver(): void {
    if (this.mode === 'auto') {
      this.controls.target.copy(this.target);
      this.camera.up.copy(UP);
      this.mode = 'free';
    }
    this.lastInput = this.time;
  }

  setMode(mode: CameraMode): void {
    if (mode === 'free') this.takeOver();
    else this.releaseToAuto();
    this.locked = mode === 'free';
  }

  private releaseToAuto(): void {
    // Continue smoothly from wherever the user left the camera.
    this.target.copy(this.controls.target);
    tmp.copy(this.camera.position).sub(this.target);
    this.distance = tmp.length();
    this.azimuth = Math.atan2(tmp.z, tmp.x);
    this.elevation = Math.asin(Math.max(-1, Math.min(1, tmp.y / Math.max(this.distance, 1e-3))));
    this.mode = 'auto';
  }

  /** Register activity at a point. */
  hit(pos: Vector3, weight = 1): void {
    this.hits.push({ pos: pos.clone(), t: this.time, w: weight });
  }

  /** The busiest contributor right now, or null. */
  follow(pos: Vector3 | null): void {
    this.pilot = pos;
  }

  /** Dolly in for a moment (big commit). */
  punch(amount: number): void {
    this.dolly = Math.min(0.45, this.dolly + amount * 0.25);
  }

  /**
   * Pull out for an establishing shot. On load (`force`) it cuts to a wide
   * shot; after idle gaps it just eases out a bit, at most every 25 s, so
   * bursty histories don't keep interrupting the other shots.
   */
  establish(force = false): void {
    if (force) {
      this.wide = 1;
      this.cut('wide');
      this.lastEstablish = this.time;
    } else if (this.time - this.lastEstablish > 25) {
      this.wide = Math.max(this.wide, 0.5);
      this.lastEstablish = this.time;
    }
  }

  /** Switch to a specific shot now (or a random next one). */
  cut(kind?: ShotKind): void {
    if (!kind) {
      const options = (Object.keys(SHOT_WEIGHTS) as ShotKind[]).filter((k) => k !== this.shot.kind && (k !== 'chase' || this.pilot));
      const total = options.reduce((n, k) => n + SHOT_WEIGHTS[k], 0);
      let r = Math.random() * total;
      kind = options[options.length - 1];
      for (const k of options) {
        r -= SHOT_WEIGHTS[k];
        if (r <= 0) {
          kind = k;
          break;
        }
      }
    }
    // Calmer cameras hold shots longer.
    const base = 24 - this.energy * 10;
    this.shot = { kind, start: this.time, duration: base * (0.7 + Math.random() * 0.6), spin: Math.random() < 0.5 ? -1 : 1 };
  }

  update(dt: number, galaxyRadius: number): void {
    this.time += dt;

    if (this.mode === 'free') {
      this.controls.update(dt);
      if (!this.locked && this.time - this.lastInput > this.returnAfter) this.releaseToAuto();
      return;
    }

    if (this.time - this.shot.start > this.shot.duration) this.cut();
    const shot = this.shot;
    const phase = Math.min(1, (this.time - shot.start) / shot.duration);
    const e = this.energy;

    // Weighted centroid and spread of recent activity.
    const window = 4;
    this.hits = this.hits.filter((h) => this.time - h.t < window);
    let wsum = 0;
    const c = new Vector3();
    for (const h of this.hits) {
      const w = h.w * (1 - (this.time - h.t) / window);
      c.addScaledVector(h.pos, w);
      wsum += w;
    }
    let spread = galaxyRadius;
    if (wsum > 0) {
      c.divideScalar(wsum);
      let s = 0;
      for (const h of this.hits) s += h.pos.distanceToSquared(c) * h.w;
      spread = Math.sqrt(s / wsum);
      c.multiplyScalar(1 - this.context);
    }
    const framed = wsum > 0 ? Math.min(galaxyRadius * 2.2, spread * 2.6 + galaxyRadius * 0.35 + 12) : galaxyRadius * 1.9 + 10;

    // Per-shot wishes: what to look at, how far, how high, how fast to circle.
    let lookAt = c;
    let distance = framed;
    let elevation = 0.45 + 0.25 * Math.sin(this.time * 0.05);
    let orbit = 0.025 + 0.05 * e;
    let lookLambda = 0.6;
    switch (shot.kind) {
      case 'swoop':
        // Dive in towards the action and back out again.
        distance = framed * (1 - (0.35 + 0.2 * e) * Math.sin(phase * Math.PI));
        orbit *= 1.4;
        elevation = 0.3 + 0.3 * Math.cos(phase * Math.PI);
        break;
      case 'skim':
        // Glide just above the galactic plane.
        elevation = 0.06 + 0.05 * Math.sin(this.time * 0.3);
        distance = framed * 0.8;
        orbit *= 1.2;
        break;
      case 'overhead':
        elevation = 1.25;
        distance = framed * 1.2;
        orbit *= 0.6;
        break;
      case 'chase':
        if (this.pilot) {
          lookAt = this.pilot;
          distance = Math.min(framed, 18 + galaxyRadius * 0.15);
          elevation = 0.35;
          orbit *= 0.8;
          lookLambda = 1.1;
        }
        break;
      case 'wide':
        distance = galaxyRadius * 2.3 + 10;
        elevation = 0.7;
        orbit *= 0.5;
        break;
    }

    this.target.x = damp(this.target.x, lookAt.x, lookLambda, dt);
    this.target.y = damp(this.target.y, lookAt.y, lookLambda, dt);
    this.target.z = damp(this.target.z, lookAt.z, lookLambda, dt);

    this.wide = damp(this.wide, 0, 0.35, dt);
    this.dolly = damp(this.dolly, 0, 0.8, dt);
    const want = (distance * (1 - this.wide) + (galaxyRadius * 2.4 + 10) * this.wide) * (1 - this.dolly);
    this.distance = damp(this.distance, want, 0.3, dt);

    // Ease the orbit speed too, so direction changes between shots are smooth.
    this.azimuthSpeed = damp(this.azimuthSpeed, orbit * shot.spin, 0.25, dt);
    this.azimuth += this.azimuthSpeed * dt;
    this.elevation = damp(this.elevation, elevation + this.wide * 0.3, 0.25, dt);

    // A little banking into the turn.
    const wantRoll = -this.azimuthSpeed * 0.9 * e;
    this.roll = damp(this.roll, wantRoll, 0.5, dt);

    const ce = Math.cos(this.elevation);
    this.camera.position.set(
      this.target.x + Math.cos(this.azimuth) * ce * this.distance,
      this.target.y + Math.sin(this.elevation) * this.distance,
      this.target.z + Math.sin(this.azimuth) * ce * this.distance,
    );
    // Roll: tilt "up" around the view direction.
    tmp.copy(this.target).sub(this.camera.position).normalize();
    this.camera.up.copy(UP).applyAxisAngle(tmp, this.roll);
    this.camera.lookAt(this.target);
  }
}
