import { type PerspectiveCamera, Vector3 } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

interface Hit {
  pos: Vector3;
  t: number;
  w: number;
}

export type CameraMode = 'auto' | 'free';

const tmp = new Vector3();

/** Exponential smoothing that is frame-rate independent. */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/**
 * Cinematic auto-camera. Follows the weighted centroid of recent activity,
 * frames it by how spread out it is, slowly orbits, and dollies in on big
 * commits. Any user input hands control to OrbitControls; after a while of
 * no input it eases back to auto.
 */
export class Director {
  readonly controls: OrbitControls;
  mode: CameraMode = 'auto';
  /** When true, never return to auto on its own. */
  locked = false;
  returnAfter = 10;
  orbitSpeed = 0.06;
  /** How much of the frame should be the whole galaxy vs. the hotspot (0..1). */
  context = 0.25;

  private hits: Hit[] = [];
  private target = new Vector3();
  private azimuth = 0.6;
  private elevation = 0.5;
  private distance = 60;
  private dolly = 0;
  private wide = 0;
  private lastInput = -Infinity;
  private time = 0;

  constructor(
    private camera: PerspectiveCamera,
    dom: HTMLElement,
  ) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enabled = true;
    this.controls.addEventListener('start', () => this.takeOver());
  }

  get focusDistance(): number {
    return this.camera.position.distanceTo(this.mode === 'auto' ? this.target : this.controls.target);
  }

  get lookTarget(): Vector3 {
    return this.mode === 'auto' ? this.target : this.controls.target;
  }

  private takeOver(): void {
    if (this.mode === 'auto') {
      this.controls.target.copy(this.target);
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

  /** Dolly in for a moment (big commit). */
  punch(amount: number): void {
    this.dolly = Math.min(0.45, this.dolly + amount * 0.25);
  }

  /** Pull out for an establishing shot (after an idle gap). */
  establish(): void {
    this.wide = 1;
  }

  update(dt: number, galaxyRadius: number): void {
    this.time += dt;

    if (this.mode === 'free') {
      this.controls.update(dt);
      if (!this.locked && this.time - this.lastInput > this.returnAfter) this.releaseToAuto();
      return;
    }

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

    const lambda = 1.2;
    this.target.x = damp(this.target.x, c.x, lambda, dt);
    this.target.y = damp(this.target.y, c.y, lambda, dt);
    this.target.z = damp(this.target.z, c.z, lambda, dt);

    this.wide = damp(this.wide, 0, 0.35, dt);
    this.dolly = damp(this.dolly, 0, 0.8, dt);
    const framed = wsum > 0 ? Math.min(galaxyRadius * 2.2, spread * 2.6 + galaxyRadius * 0.35 + 12) : galaxyRadius * 1.9 + 10;
    const want = (framed * (1 - this.wide) + (galaxyRadius * 2.4 + 10) * this.wide) * (1 - this.dolly);
    this.distance = damp(this.distance, want, 0.7, dt);

    this.azimuth += this.orbitSpeed * dt;
    const wantElev = 0.45 + 0.25 * Math.sin(this.time * 0.05) + this.wide * 0.3;
    this.elevation = damp(this.elevation, wantElev, 0.3, dt);

    const ce = Math.cos(this.elevation);
    this.camera.position.set(
      this.target.x + Math.cos(this.azimuth) * ce * this.distance,
      this.target.y + Math.sin(this.elevation) * this.distance,
      this.target.z + Math.sin(this.azimuth) * ce * this.distance,
    );
    this.camera.lookAt(this.target);
  }
}
