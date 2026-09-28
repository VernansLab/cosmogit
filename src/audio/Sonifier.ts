import * as Tone from 'tone';
import { hash32 } from '../layout/hash';
import type { ApplyKind } from '../sim/RepoState';

/** C minor pentatonic: never sounds wrong, however many notes overlap. */
const SCALE = ['C', 'Eb', 'F', 'G', 'Bb'];

function note(seed: number, baseOctave: number, span = 2): string {
  return `${SCALE[seed % SCALE.length]}${baseOctave + ((seed >>> 4) % span)}`;
}

/**
 * Turns repository activity into music.
 * - add: bright pluck, pitch from the file extension
 * - modify: soft FM bell, timbre from the author, loudness from diff size
 * - delete: low filtered thump
 * - big commit: a slow pad chord
 * A voice budget keeps bursts of hundreds of changes from turning into noise.
 */
export class Sonifier {
  enabled = true;
  volume = 0.6;
  private started = false;
  private master!: Tone.Volume;
  private pluck!: Tone.PolySynth;
  private bells: Tone.PolySynth<Tone.FMSynth>[] = [];
  private thump!: Tone.MembraneSynth;
  private pad!: Tone.PolySynth<Tone.AMSynth>;
  private budget = 0;
  private lastPad = 0;

  /** Must be called from a user gesture (browser autoplay rules). */
  async start(): Promise<void> {
    if (!this.started) this.build();
    await Tone.start();
  }

  private get running(): boolean {
    return this.started && Tone.getContext().state === 'running';
  }

  private build(): void {
    this.started = true;
    const limiter = new Tone.Limiter(-2).toDestination();
    const reverb = new Tone.Reverb({ decay: 7, wet: 0.45 }).connect(limiter);
    const delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.32, wet: 0.22 }).connect(reverb);
    this.master = new Tone.Volume(-8).connect(delay);

    this.pluck = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle8' },
      envelope: { attack: 0.002, decay: 0.25, sustain: 0.05, release: 0.6 },
      volume: -10,
    }).connect(this.master);
    this.pluck.maxPolyphony = 16;

    // Four bell timbres; each author gets one.
    for (const [harmonicity, index] of [[3, 8], [2, 4], [1.5, 12], [5, 3]]) {
      const bell = new Tone.PolySynth(Tone.FMSynth, {
        harmonicity,
        modulationIndex: index,
        envelope: { attack: 0.005, decay: 0.8, sustain: 0, release: 1.2 },
        modulationEnvelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.5 },
        volume: -16,
      }).connect(this.master);
      bell.maxPolyphony = 12;
      this.bells.push(bell);
    }

    const lowpass = new Tone.Filter(420, 'lowpass').connect(this.master);
    this.thump = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 3, envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.3 }, volume: -8 }).connect(lowpass);

    this.pad = new Tone.PolySynth(Tone.AMSynth, {
      harmonicity: 1.01,
      envelope: { attack: 1.2, decay: 1, sustain: 0.6, release: 4 },
      volume: -20,
    }).connect(this.master);
    this.applyVolume();
  }

  applyVolume(): void {
    if (!this.started) return;
    this.master.volume.rampTo(this.enabled && this.volume > 0 ? Tone.gainToDb(this.volume) - 8 : -Infinity, 0.2);
  }

  /** Call once per frame to refill the voice budget. */
  tick(dt: number): void {
    this.budget = Math.min(8, this.budget + dt * 28);
  }

  play(kind: ApplyKind, ext: string, author: number, strength: number, delay = 0): void {
    if (!this.running || !this.enabled || this.budget < 1) return;
    this.budget -= 1;
    const when = Tone.now() + delay + Math.random() * 0.02;
    const seed = hash32(ext);
    const velocity = 0.25 + strength * 0.7;
    try {
      switch (kind) {
        case 'add':
        case 'rename':
          this.pluck.triggerAttackRelease(note(seed, 5), '16n', when, velocity);
          break;
        case 'modify':
          this.bells[author % this.bells.length].triggerAttackRelease(note(seed, 4, 3), '8n', when, velocity);
          break;
        case 'delete':
          this.thump.triggerAttackRelease(note(seed, 1, 1), '8n', when, velocity);
          break;
      }
    } catch {
      // Tone throws if two events land on the exact same time for a mono synth; skip the note.
    }
  }

  /** A swell for large commits. */
  swell(size: number): void {
    if (!this.running || !this.enabled) return;
    const now = Tone.now();
    if (now - this.lastPad < 2.5) return;
    this.lastPad = now;
    const root = hash32(String(size)) % SCALE.length;
    const chord = [0, 2, 4].map((i) => `${SCALE[(root + i) % SCALE.length]}${3 + Math.floor((root + i) / SCALE.length)}`);
    this.pad.triggerAttackRelease(chord, 2.5, now, Math.min(1, 0.3 + Math.log10(size + 1) / 6));
  }
}
