import type { Commit } from '../data/types';

export interface PlaybackOptions {
  /** Real seconds per day of history. */
  secondsPerDay: number;
  /** Skip ahead when nothing happens for this many real seconds. */
  autoSkipSeconds: number;
}

export interface Tick {
  commits: Commit[];
  /** True when this tick jumped over an idle gap. */
  skipped: boolean;
}

/** Maps real time onto repo history and hands out commits as they come due. */
export class Playback {
  index = 0;
  simTime: number;
  paused = false;

  constructor(
    readonly commits: Commit[],
    public opts: PlaybackOptions,
  ) {
    this.simTime = commits.length ? commits[0].t - 1 : 0;
  }

  get startTime(): number {
    return this.commits[0]?.t ?? 0;
  }

  get endTime(): number {
    return this.commits[this.commits.length - 1]?.t ?? 0;
  }

  get done(): boolean {
    return this.index >= this.commits.length;
  }

  /** 0..1 through history by commit count (smoother than by time for bursty repos). */
  get progress(): number {
    return this.commits.length ? this.index / this.commits.length : 0;
  }

  private get simPerReal(): number {
    return 86400 / Math.max(1e-3, this.opts.secondsPerDay);
  }

  update(dtReal: number): Tick {
    const tick: Tick = { commits: [], skipped: false };
    if (this.paused || this.done) return tick;

    this.simTime += dtReal * this.simPerReal;
    const next = this.commits[this.index];
    const gap = (next.t - this.simTime) / this.simPerReal;
    if (gap > this.opts.autoSkipSeconds) {
      this.simTime = next.t - 0.25 * this.simPerReal;
      tick.skipped = true;
    }
    while (!this.done && this.commits[this.index].t <= this.simTime) {
      tick.commits.push(this.commits[this.index++]);
    }
    return tick;
  }

  /** Jump so that the next commit handed out is `index`. Returns the commits skipped over. */
  seek(index: number): Commit[] {
    index = Math.max(0, Math.min(this.commits.length, index));
    const skipped = this.commits.slice(0, index);
    this.index = index;
    this.simTime = index > 0 ? this.commits[index - 1].t : this.startTime - 1;
    return skipped;
  }
}
