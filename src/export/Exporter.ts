import { BufferTarget, CanvasSource, getFirstEncodableVideoCodec, Mp4OutputFormat, Output, QUALITY_HIGH } from 'mediabunny';
import type { App } from '../App';
import type { Commit } from '../data/types';
import { authorColor, cssColor } from '../render/palette';
import type { ExportChoice } from '../ui/Panel';

const SIZES: Record<ExportChoice['resolution'], [number, number]> = {
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4k': [3840, 2160],
};

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export interface ExportHost {
  setExporting(v: boolean): void;
  progress(fraction: number, label: string): void;
  done(message: string): void;
}

/**
 * Offline MP4 renderer. Steps the app with a fixed timestep (so the result
 * is smooth regardless of how long each frame takes to render), composites
 * the HUD text onto each frame, and encodes with WebCodecs via mediabunny.
 */
export class Exporter {
  private cancelled = false;
  running = false;

  constructor(
    private app: App,
    private host: ExportHost,
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
    const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height });
    if (!codec) {
      this.host.done(`No encoder available for ${width}×${height}`);
      return;
    }

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
    const source = new CanvasSource(frame, { codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: choice.fps });

    let message = '';
    try {
      await output.start();
      app.resize(width, height, 1);
      if (choice.fromStart) {
        app.seek(0);
        app.director.establish();
      }
      const total = Math.round(choice.seconds * choice.fps);
      const dt = 1 / choice.fps;
      const started = performance.now();
      for (let i = 0; i < total; i++) {
        if (this.cancelled) break;
        app.advance(dt);
        g.drawImage(app.renderer.domElement, 0, 0, width, height);
        this.drawOverlay(g, width, height, recent);
        await source.add(i * dt, dt);
        if (i % 10 === 0) {
          const f = (i + 1) / total;
          const elapsed = (performance.now() - started) / 1000;
          const eta = (elapsed / f) * (1 - f);
          this.host.progress(f, `Rendering ${width}×${height} · ${Math.round(f * 100)}% · ${Math.ceil(eta)}s left · Esc to stop`);
          // Yield so the page stays responsive.
          await new Promise((r) => setTimeout(r, 0));
        }
        if (app.playback?.done && !app.settings.loop && i > choice.fps) {
          // Let the last effects play out for two seconds, then stop.
          const tail = Math.min(total - i - 1, choice.fps * 2);
          for (let j = 0; j < tail; j++) {
            app.advance(dt);
            g.drawImage(app.renderer.domElement, 0, 0, width, height);
            this.drawOverlay(g, width, height, recent);
            await source.add((i + 1 + j) * dt, dt);
          }
          break;
        }
      }
      await output.finalize();
      const buffer = (output.target as BufferTarget).buffer!;
      const blob = new Blob([buffer], { type: 'video/mp4' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${app.log?.repo ?? 'cosmogit'}-${choice.resolution}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      message = `Saved ${a.download} (${(blob.size / 1e6).toFixed(1)} MB)${this.cancelled ? ', stopped early' : ''}`;
    } catch (err) {
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
