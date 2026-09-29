import { App } from './App';
import { Sonifier } from './audio/Sonifier';
import { Exporter } from './export/Exporter';
import { parseAny } from './data/parse';
import type { RepoLog } from './data/types';
import { Hud } from './ui/Hud';
import { exportChoice, Panel } from './ui/Panel';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const drop = document.getElementById('drop')!;
const toastEl = document.getElementById('toast')!;

const params = new URLSearchParams(location.search);
// ?webgl forces the WebGL2 fallback, for comparison and debugging.
const app = await App.create(canvas, { forceWebGL: params.has('webgl') });
const hud = new Hud(app);
const sound = new Sonifier();
app.hooks = {
  onLoad: (log) => hud.onLoad(log),
  onCommit: (c, log) => hud.onCommit(c, log),
  // The sound lands when the beam hits the star.
  onAction: ({ author, applied }, strength) => sound.play(applied.kind, applied.file.ext, author, strength, 0.45),
  onBigCommit: (_c, size) => sound.swell(size),
};

// Browsers only allow audio after a user gesture.
const unlockAudio = () => {
  sound.start().catch(() => {});
  window.removeEventListener('pointerdown', unlockAudio);
  window.removeEventListener('keydown', unlockAudio);
};
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

const audioSettings = {
  get enabled() {
    return sound.enabled;
  },
  set enabled(v: boolean) {
    sound.enabled = v;
  },
  get volume() {
    return sound.volume;
  },
  set volume(v: number) {
    sound.volume = v;
  },
  onChange: () => sound.applyVolume(),
};
const recordBtn = document.getElementById('record')!;
const exporter = new Exporter(
  app,
  {
    setExporting: (v) => {
      setExporting(v);
      recordBtn.classList.toggle('recording', v);
    },
    progress: (_f, label) => toast(label, 60_000),
    done: (msg) => toast(msg, 8000),
  },
  sound,
);
const record = () => {
  if (exporter.running) exporter.cancel();
  else if (app.playback) void exporter.run(exportChoice);
};
recordBtn.addEventListener('click', record);
new Panel(app, { audio: audioSettings, exportVideo: (choice) => exporter.run(choice) });

let toastTimer = 0;
export function toast(msg: string, ms = 2200): void {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), ms);
}

function start(log: RepoLog): void {
  if (!log.commits.length) {
    toast('That log has no commits');
    return;
  }
  drop.classList.add('hidden');
  app.load(log);
  history.replaceState(null, '', location.search || location.pathname);
}

async function loadUrl(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const name = url.split('/').pop()!.replace(/\.[^.]+$/, '');
  start(parseAny(await res.text(), name));
}

// Drag and drop anywhere.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.remove('hidden');
  drop.classList.add('over');
});
window.addEventListener('dragleave', () => drop.classList.remove('over'));
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  try {
    start(parseAny(await file.text(), file.name.replace(/\.[^.]+$/, '')));
  } catch (err) {
    toast(`Could not read ${file.name}: ${(err as Error).message}`, 4000);
  }
});

// Sample logs extracted into public/logs.
fetch('/logs/index.json')
  .then((r) => (r.ok ? r.json() : []))
  .then((names: string[]) => {
    const box = document.getElementById('samples')!;
    for (const n of names) {
      const b = document.createElement('button');
      b.textContent = n.replace(/\.json$/, '');
      b.onclick = () => loadUrl(`/logs/${n}`).catch((err) => toast(err.message));
      box.append(b);
    }
  })
  .catch(() => {});

const logParam = params.get('log');
if (logParam) loadUrl(logParam.startsWith('/') ? logParam : `/${logParam}`).catch((err) => toast(`Could not load ${logParam}: ${err.message}`, 5000));

// Keyboard.
let hudVisible = true;
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('.tp-dfwv, input')) return;
  const pb = app.playback;
  switch (e.key) {
    case 'Escape':
      if (exporter.running) exporter.cancel();
      break;
    case 'r':
      record();
      break;
    case 'n':
      if (app.director.mode === 'auto') {
        app.director.cut();
        toast(`Shot: ${app.director.currentShot}`);
      }
      break;
    case ' ':
      e.preventDefault();
      hud.togglePause();
      break;
    case 'ArrowRight':
      if (pb) app.seek(pb.index + Math.max(1, Math.round(pb.commits.length * 0.02)));
      break;
    case 'ArrowLeft':
      if (pb) app.seek(pb.index - Math.max(1, Math.round(pb.commits.length * 0.02)));
      break;
    case 'm':
      sound.enabled = !sound.enabled;
      sound.applyVolume();
      toast(sound.enabled ? 'Sound on' : 'Sound off');
      break;
    case 'h':
      hudVisible = !hudVisible;
      hud.setVisible(hudVisible);
      break;
    case 'c':
      app.director.setMode(app.director.mode === 'auto' ? 'free' : 'auto');
      toast(`Camera: ${app.director.mode}`);
      break;
    case '+':
    case '=':
      app.settings.secondsPerDay = Math.max(0.02, app.settings.secondsPerDay / 1.5);
      app.applySettings();
      toast(`${app.settings.secondsPerDay.toFixed(2)} s / day`);
      break;
    case '-':
      app.settings.secondsPerDay = Math.min(5, app.settings.secondsPerDay * 1.5);
      app.applySettings();
      toast(`${app.settings.secondsPerDay.toFixed(2)} s / day`);
      break;
  }
});

window.addEventListener('resize', () => app.resize(window.innerWidth, window.innerHeight));

// Realtime loop. Export takes over the loop by setting `app.externalClock`.
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!exporting) {
    app.advance(dt);
    hud.update(dt);
    sound.tick(dt);
  }
  requestAnimationFrame(frame);
}
let exporting = false;
export function setExporting(v: boolean): void {
  exporting = v;
}
requestAnimationFrame(frame);

Object.assign(window, { app, sound });
