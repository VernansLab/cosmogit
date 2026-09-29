import * as Tone from 'tone';
import { hash32 } from '../layout/hash';
import type { ApplyKind } from '../sim/RepoState';

/** C minor pentatonic: never sounds wrong, however many notes overlap. */
const SCALE = ['C', 'Eb', 'F', 'G', 'Bb'];

function note(seed: number, baseOctave: number, span = 2): string {
  return `${SCALE[seed % SCALE.length]}${baseOctave + ((seed >>> 4) % span)}`;
}

/**
 * The synths and effects. Built against whichever Tone context is current,
 * so the same graph plays live and renders offline for video export.
 */
class Graph {
  readonly master: Tone.Volume;
  private reverb: Tone.Reverb;
  private pluck: Tone.PolySynth;
  private bells: Tone.PolySynth<Tone.FMSynth>[] = [];
  private thump: Tone.MembraneSynth;
  private pad: Tone.PolySynth<Tone.AMSynth>;
  private lastThump = -1;

  constructor() {
    const limiter = new Tone.Limiter(-2).toDestination();
    this.reverb = new Tone.Reverb({ decay: 7, wet: 0.45 }).connect(limiter);
    const delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.32, wet: 0.22 }).connect(this.reverb);
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
  }

  /** Resolves once the reverb impulse response has been generated. */
  ready(): Promise<void> {
    return this.reverb.ready;
  }

  trigger(kind: ApplyKind, ext: string, author: number, strength: number, when: number): void {
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
          // Monophonic: keep strictly increasing start times.
          if (when <= this.lastThump) when = this.lastThump + 0.01;
          this.lastThump = when;
          this.thump.triggerAttackRelease(note(seed, 1, 1), '8n', when, velocity);
          break;
      }
    } catch {
      // A voice that can't be scheduled is just skipped.
    }
  }

  swell(size: number, when: number): void {
    const root = hash32(String(size)) % SCALE.length;
    const chord = [0, 2, 4].map((i) => `${SCALE[(root + i) % SCALE.length]}${3 + Math.floor((root + i) / SCALE.length)}`);
    this.pad.triggerAttackRelease(chord, 2.5, when, Math.min(1, 0.3 + Math.log10(size + 1) / 6));
  }
}

/** Scale a buffer so its peak sits at about -1 dBFS (never more than +24 dB of gain). */
function normalize(buf: AudioBuffer): void {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak < 1e-5) return;
  const gain = Math.min(16, 0.89 / peak);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= gain;
  }
}

type SoundEvent =
  | { t: number; type: 'note'; kind: ApplyKind; ext: string; author: number; strength: number }
  | { t: number; type: 'swell'; size: number };

/**
 * Turns repository activity into music.
 * - add: bright pluck, pitch from the file extension
 * - modify: soft FM bell, timbre from the author, loudness from diff size
 * - delete: low filtered thump
 * - big commit: a slow pad chord
 * A voice budget keeps bursts of hundreds of changes from turning into noise.
 *
 * While recording (video export), events are logged against the video clock
 * instead of played, then rendered offline through a fresh Graph.
 */
export class Sonifier {
  enabled = true;
  volume = 0.6;
  private graph: Graph | null = null;
  private budget = 0;
  private lastPad = -Infinity;
  private recording: SoundEvent[] | null = null;
  private clock = 0;

  /** Must be called from a user gesture (browser autoplay rules). */
  async start(): Promise<void> {
    if (!this.graph) {
      this.graph = new Graph();
      this.applyVolume();
    }
    await Tone.start();
  }

  private get live(): boolean {
    return this.graph !== null && Tone.getContext().state === 'running';
  }

  applyVolume(): void {
    if (!this.graph) return;
    this.graph.master.volume.rampTo(this.gainDb(), 0.2);
  }

  private gainDb(): number {
    return this.enabled && this.volume > 0 ? Tone.gainToDb(this.volume) - 8 : -Infinity;
  }

  /** Call once per frame to refill the voice budget. */
  tick(dt: number): void {
    this.budget = Math.min(8, this.budget + dt * 28);
    this.clock += dt;
  }

  play(kind: ApplyKind, ext: string, author: number, strength: number, delay = 0): void {
    if (!this.enabled || this.budget < 1) return;
    if (this.recording) {
      this.budget -= 1;
      this.recording.push({ t: this.clock + delay + Math.random() * 0.02, type: 'note', kind, ext, author, strength });
      return;
    }
    if (!this.live) return;
    this.budget -= 1;
    this.graph!.trigger(kind, ext, author, strength, Tone.now() + delay + Math.random() * 0.02);
  }

  /** A swell for large commits. */
  swell(size: number): void {
    if (!this.enabled) return;
    if (this.clock - this.lastPad < 2.5) return;
    if (this.recording) {
      this.lastPad = this.clock;
      this.recording.push({ t: this.clock, type: 'swell', size });
      return;
    }
    if (!this.live) return;
    this.lastPad = this.clock;
    this.graph!.swell(size, Tone.now());
  }

  /** Start logging sound events against a video clock starting at 0. */
  beginRecording(): void {
    this.recording = [];
    this.clock = 0;
    this.lastPad = -Infinity;
    this.budget = 8;
  }

  /** Stop logging and render the soundtrack offline; null if sound is off or nothing played. */
  async endRecording(duration: number, sampleRate = 48000): Promise<AudioBuffer | null> {
    const events = this.recording ?? [];
    this.recording = null;
    if (!this.enabled || !events.length || duration <= 0) return null;
    const gain = this.gainDb();
    const buffer = await Tone.Offline(async () => {
      const g = new Graph();
      g.master.volume.value = gain;
      await g.ready();
      for (const e of events) {
        if (e.t >= duration) continue;
        if (e.type === 'note') g.trigger(e.kind, e.ext, e.author, e.strength, e.t);
        else g.swell(e.size, e.t);
      }
    }, duration, 2, sampleRate);
    const audio = buffer.get() ?? null;
    if (audio) normalize(audio);
    return audio;
  }
}
