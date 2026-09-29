import type { App } from '../App';
import type { Commit, RepoLog } from '../data/types';
import { authorColor, cssColor, extColor } from '../render/palette';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** DOM overlay: date, commit ticker, contributor legend, extension legend, timeline. */
export class Hud {
  private repo = $('repo');
  private date = $('date');
  private ticker = $('ticker');
  private legend = $('legend');
  private exts = $('exts');
  private stats = $('stats');
  private progress = $('progress');
  private timeline = $('timeline');
  private hover = $('hover');
  private spark = $<HTMLCanvasElement>('spark');
  private play = $('play');

  private activity = new Map<number, { n: number; last: number }>();
  private slowClock = 0;
  private fpsFrames = 0;
  private fpsClock = 0;
  private fps = 0;

  constructor(private app: App) {
    this.timeline.addEventListener('click', (e) => {
      const pb = this.app.playback;
      if (!pb) return;
      const f = this.fraction(e);
      this.app.seek(Math.round(f * pb.commits.length));
    });
    this.timeline.addEventListener('mousemove', (e) => {
      const pb = this.app.playback;
      if (!pb || !pb.commits.length) return;
      const f = this.fraction(e);
      const c = pb.commits[Math.min(pb.commits.length - 1, Math.floor(f * pb.commits.length))];
      this.hover.textContent = dateFmt.format(c.t * 1000);
      this.hover.style.left = `${Math.min(Math.max(f * 100, 4), 96)}%`;
    });
    this.play.addEventListener('click', () => this.togglePause());
    window.addEventListener('resize', () => this.drawSpark());
  }

  togglePause(): void {
    const pb = this.app.playback;
    if (!pb) return;
    pb.paused = !pb.paused;
    this.play.textContent = pb.paused ? '▶' : '❚❚';
  }

  private fraction(e: MouseEvent): number {
    const r = this.timeline.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  onLoad(log: RepoLog): void {
    this.repo.textContent = log.repo;
    this.ticker.innerHTML = '';
    this.activity.clear();
    this.drawSpark();
  }

  /** Commit density per bin, by commit index (matches seek), weighted by size. */
  private drawSpark(): void {
    const log = this.app.log;
    if (!log) return;
    const c = this.spark;
    const dpr = window.devicePixelRatio;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const g = c.getContext('2d')!;
    const bins = Math.max(1, Math.floor(c.width / (3 * dpr)));
    const hist = new Float32Array(bins);
    // Bin by time so quiet stretches look quiet; x-axis still maps to commit index for seeking.
    const n = log.commits.length;
    log.commits.forEach((cm, i) => {
      hist[Math.min(bins - 1, Math.floor((i / n) * bins))] += Math.log2(2 + cm.changes.length);
    });
    const max = Math.max(...hist, 1);
    const grad = g.createLinearGradient(0, c.height, 0, 0);
    grad.addColorStop(0, 'rgba(127,178,255,0.05)');
    grad.addColorStop(1, 'rgba(190,140,255,0.55)');
    g.fillStyle = grad;
    const w = c.width / bins;
    for (let i = 0; i < bins; i++) {
      const h = (hist[i] / max) * c.height * 0.85;
      g.fillRect(i * w, c.height - h, Math.max(1, w - dpr), h);
    }
  }

  onCommit(commit: Commit, log: RepoLog): void {
    const author = log.authors[commit.author]?.name ?? '?';
    const a = this.activity.get(commit.author) ?? { n: 0, last: 0 };
    a.n += 1;
    a.last = this.app.time;
    this.activity.set(commit.author, a);

    if (!commit.msg) return;
    const line = document.createElement('div');
    line.className = 'line';
    const repo = commit.repo !== undefined && log.repos ? `<i>${escapeHtml(log.repos[commit.repo])}</i> ` : '';
    line.innerHTML = `${repo}<b style="color:${cssColor(authorColor(author))}">${escapeHtml(author)}</b>  ${escapeHtml(commit.msg)}`;
    this.ticker.prepend(line);
    while (this.ticker.children.length > 5) this.ticker.lastElementChild!.remove();
    [...this.ticker.children].forEach((el, i) => ((el as HTMLElement).style.opacity = String(1 - i * 0.2)));
  }

  update(dt: number): void {
    const pb = this.app.playback;
    this.fpsFrames++;
    this.fpsClock += dt;
    if (this.fpsClock > 0.5) {
      this.fps = this.fpsFrames / this.fpsClock;
      this.fpsFrames = 0;
      this.fpsClock = 0;
    }
    if (!pb) return;
    this.date.textContent = dateFmt.format(Math.max(pb.startTime, pb.simTime) * 1000);
    this.progress.style.width = `${pb.progress * 100}%`;

    this.slowClock += dt;
    if (this.slowClock < 0.5) return;
    this.slowClock = 0;

    const st = this.app.state;
    this.stats.textContent = `${pb.index.toLocaleString()} / ${pb.commits.length.toLocaleString()} commits\n${st.files.size.toLocaleString()} files · ${Math.round(this.fps)} fps · ${this.app.backendName}`;

    // Contributors active in the last few seconds, most active first.
    const now = this.app.time;
    const log = this.app.log!;
    const active = [...this.activity.entries()]
      .filter(([, a]) => now - a.last < 8)
      .sort((x, y) => y[1].n - x[1].n)
      .slice(0, 8);
    this.legend.innerHTML = active
      .map(([i, a]) => {
        const name = log.authors[i]?.name ?? '?';
        const color = cssColor(authorColor(name));
        const fade = Math.max(0.25, 1 - (now - a.last) / 8);
        return `<div class="who" style="opacity:${fade}">${escapeHtml(name)}<span>${a.n}</span><i style="color:${color}"></i></div>`;
      })
      .join('');

    // Top extensions in the live tree.
    const counts = new Map<string, number>();
    for (const f of st.files.values()) counts.set(f.ext, (counts.get(f.ext) ?? 0) + 1);
    this.exts.innerHTML = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ext, n]) => `<div style="color:${cssColor(extColor(ext))}"><i></i>${escapeHtml(ext)} <span>${n}</span></div>`)
      .join('');
  }

  setVisible(v: boolean): void {
    $('hud').classList.toggle('hidden', !v);
  }
}
