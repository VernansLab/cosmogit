import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
} from 'mediabunny';
import type { App } from '../App';
import type { Sonifier } from '../audio/Sonifier';
import type { Commit } from '../data/types';
import { authorColor, cssColor } from '../render/palette';
import type { ExportChoice } from '../ui/Panel';

const SIZES: Record<ExportChoice['resolution'], [number, number]> = {
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4k': [3840, 2160],
};

/** Upper bound for "whole history" renders. */
const MAX_SECONDS = 15 * 60;
/** Seconds of effects to keep rolling after the last commit. */
const TAIL_SECONDS = 3;

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export interface ExportHost {
  setExporting(v: boolean): void;
  progress(fraction: number, label: string): void;
  done(message: string): void;
}

/**
 * Yield to the event loop without setTimeout, which background tabs clamp
 * to once a second. A MessageChannel round trip isn't throttled.
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

/** Save through the dev server into ./exports; returns the path, or null if not available. */
async function saveToProject(blob: Blob, name: string): Promise<string | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const res = await fetch(`/__cosmogit/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    if (!res.ok) return null;
    return ((await res.json()) as { path: string }).path;
  } catch {
    return null;
  }
}

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/**
 * Offline MP4 renderer. Steps the app with a fixed timestep (so the result
 * is smooth regardless of how long each frame takes to render), composites
 * the HUD text onto each frame, encodes with WebCodecs via mediabunny, and
 * renders the soundtrack offline from the sound events logged along the way.
 */
export class Exporter {
  private cancelled = false;
  running = false;

  constructor(
    private app: App,
    private host: ExportHost,
    private sound?: Sonifier,
    private labels?: { update(): void; draw(g: CanvasRenderingContext2D, scale: number): void },
  ) {}

  cancel(): void {
    this.cancelled = true;
  }

  async run(choice: ExportChoice): Promise<void> {
    if (this.running || !this.app.playback) return;
    if (typeof VideoEncoder === 'undefined') {
      this.host.done('This browser has no WebCodecs; use Chrome, Edge or Safari 17+');
      return;
    }
    const [width, height] = SIZES[choice.resolution];
    const videoCodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height });
    if (!videoCodec) {
      this.host.done(`No encoder available for ${width}×${height}`);
      return;
    }
    const audioCodec = this.sound?.enabled ? await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000 }) : null;

    this.running = true;
    this.cancelled = false;
    this.host.setExporting(true);
    const app = this.app;
    const prevSize = app.size;
    const prevRatio = app.renderer.getPixelRatio();
    const prevHook = app.hooks.onCommit;
    const recent: Commit[] = [];
    app.hooks.onCommit = (c, log) => {
      recent.unshift(c);
      recent.length = Math.min(recent.length, 4);
      prevHook?.(c, log);
    };

    const frame = document.createElement('canvas');
    frame.width = width;
    frame.height = height;
    const g = frame.getContext('2d')!;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const video = new CanvasSource(frame, { codec: videoCodec, quality: QUALITY_MEDIUM, keyFrameInterval: 2 });
    output.addVideoTrack(video, { frameRate: choice.fps });
    const audio = audioCodec ? new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH }) : null;
    if (audio) output.addAudioTrack(audio);

    const name = `${app.log?.repo ?? 'cosmogit'}-${choice.resolution}.mp4`;
    let message = '';
    try {
      await output.start();
      app.resize(width, height, 1);
      if (choice.fromStart) {
        app.seek(0);
        app.director.establish(true);
      }
      this.sound?.beginRecording();
      const limit = Math.round((choice.wholeHistory ? MAX_SECONDS : choice.seconds) * choice.fps);
      const dt = 1 / choice.fps;
      const started = performance.now();
      const startIndex = app.playback!.index;
      let frames = 0;
      let tail = -1;

      while (frames < limit && !this.cancelled) {
        app.advance(dt);
        this.sound?.tick(dt);
        g.drawImage(app.renderer.domElement, 0, 0, width, height);
        this.labels?.update();
        this.labels?.draw(g, height / 1080);
        this.drawOverlay(g, width, height, recent);
        await video.add(frames * dt, dt);
        frames++;

        // Once history runs out, let the last effects play for a few seconds.
        if (tail < 0 && app.playback!.done && !app.settings.loop) tail = Math.round(TAIL_SECONDS * choice.fps);
        if (tail >= 0 && tail-- === 0) break;

        if (frames % 10 === 0) {
          const pb = app.playback!;
          const f = choice.wholeHistory
            ? (pb.index - startIndex) / Math.max(1, pb.commits.length - startIndex)
            : frames / limit;
          const elapsed = (performance.now() - started) / 1000;
          const eta = f > 0.01 ? Math.ceil((elapsed / f) * (1 - f)) : '?';
          this.host.progress(f, `Rendering ${width}×${height} · ${Math.round(f * 100)}% · ${(frames / choice.fps).toFixed(0)}s of video · ~${eta}s left · Esc to stop`);
          await yieldToLoop();
        }
      }

      const duration = frames * dt;
      const soundtrack = await this.sound?.endRecording(duration);
      if (audio && soundtrack) {
        this.host.progress(1, 'Mixing soundtrack…');
        await audio.add(soundtrack);
      }
      await output.finalize();
      const blob = new Blob([(output.target as BufferTarget).buffer!], { type: 'video/mp4' });
      const saved = await saveToProject(blob, name);
      if (!saved) download(blob, name);
      const where = saved ?? name;
      message = `Saved ${where} · ${duration.toFixed(0)}s · ${(blob.size / 1e6).toFixed(1)} MB${soundtrack ? ' · with sound' : ''}${this.cancelled ? ' (stopped early)' : ''}`;
    } catch (err) {
      await this.sound?.endRecording(0);
      await output.cancel().catch(() => {});
      message = `Export failed: ${(err as Error).message}`;
    } finally {
      app.hooks.onCommit = prevHook;
      app.resize(prevSize.width, prevSize.height, prevRatio);
      this.host.setExporting(false);
      this.running = false;
      this.host.done(message);
    }
  }

  private drawOverlay(g: CanvasRenderingContext2D, w: number, h: number, recent: Commit[]): void {
    const app = this.app;
    const pb = app.playback!;
    const s = h / 1080;
    const pad = 40 * s;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.8)';
    g.shadowBlur = 10 * s;
    g.textBaseline = 'top';
    g.fillStyle = '#7fb2ff';
    g.font = `500 ${15 * s}px "JetBrains Mono", monospace`;
    g.fillText((app.log?.repo ?? '').toUpperCase().split('').join(' '), pad, pad);
    g.fillStyle = '#e8ecff';
    g.font = `700 ${48 * s}px "Space Grotesk", system-ui, sans-serif`;
    g.fillText(dateFmt.format(Math.max(pb.startTime, pb.simTime) * 1000), pad, pad + 24 * s);
    g.font = `400 ${17 * s}px "JetBrains Mono", monospace`;
    recent.forEach((c, i) => {
      const name = app.log?.authors[c.author]?.name ?? '?';
      const y = pad + (92 + i * 26) * s;
      g.globalAlpha = 1 - i * 0.22;
      g.fillStyle = cssColor(authorColor(name));
      g.fillText(name, pad, y);
      const nw = g.measureText(`${name}  `).width;
      g.fillStyle = '#c8d0f0';
      const msg = c.msg.length > 80 ? `${c.msg.slice(0, 79)}…` : c.msg;
      g.fillText(msg, pad + nw, y);
    });
    g.globalAlpha = 1;
    // Thin progress line along the bottom.
    g.shadowBlur = 12 * s;
    g.shadowColor = '#7fb2ff';
    g.fillStyle = 'rgba(127,178,255,0.8)';
    g.fillRect(0, h - 3 * s, w * pb.progress, 3 * s);
    g.restore();
  }
}
