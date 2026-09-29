import { App } from './App';
import { Sonifier } from './audio/Sonifier';
import { Exporter } from './export/Exporter';
import { parseAny } from './data/parse';
import type { RepoLog } from './data/types';
import { Hud } from './ui/Hud';
import { Labels } from './ui/Labels';
import { exportChoice, Panel } from './ui/Panel';
import type { GitWorkerIn, GitWorkerOut } from './data/gitWorker';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const drop = document.getElementById('drop')!;
const toastEl = document.getElementById('toast')!;

const params = new URLSearchParams(location.search);
// ?webgl forces the WebGL2 fallback, for comparison and debugging.
const app = await App.create(canvas, { forceWebGL: params.has('webgl') });
const hud = new Hud(app);
const sound = new Sonifier();
const labels = new Labels(app);
app.hooks = {
  onLoad: (log) => hud.onLoad(log),
  onCommit: (c, log) => hud.onCommit(c, log),
  // The sound lands when the beam hits the star.
  onAction: ({ author, applied }, strength) => {
    sound.play(applied.kind, applied.file.ext, author, strength, 0.45);
    labels.onAction(applied.kind, applied.file);
  },
  onSeek: () => labels.clear(),
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
  labels,
);
const record = () => {
  if (exporter.running) exporter.cancel();
  else if (app.playback) void exporter.run(exportChoice);
};
recordBtn.addEventListener('click', record);
new Panel(app, { audio: audioSettings, labels, exportVideo: (choice) => exporter.run(choice) });

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
  document.title = `${log.repo} · Cosmogit`;
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
async function loadFile(file: File): Promise<void> {
  try {
    start(parseAny(await file.text(), file.name.replace(/(\.cosmogit)?\.[^.]+$/, '')));
  } catch (err) {
    toast(`Could not read ${file.name}: ${(err as Error).message}`, 4000);
  }
}
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer?.files[0];
  if (file) void loadFile(file);
});
// ---- Open a repo folder: read .git in a worker, nothing uploaded ----
const openBtn = document.getElementById('open-folder') as HTMLButtonElement;
const dirPick = document.getElementById('dirpick') as HTMLInputElement;
const reading = document.getElementById('reading')!;
const readingText = document.getElementById('reading-text')!;
const readingFill = document.getElementById('reading-fill')!;

function readFolder(msg: GitWorkerIn): void {
  const worker = new Worker(new URL('./data/gitWorker.ts', import.meta.url), { type: 'module' });
  openBtn.disabled = true;
  reading.hidden = false;
  readingText.textContent = 'Opening…';
  readingFill.style.width = '0';
  const finish = () => {
    worker.terminate();
    openBtn.disabled = false;
    reading.hidden = true;
  };
  worker.onmessage = (e: MessageEvent<GitWorkerOut>) => {
    const m = e.data;
    if (m.type === 'progress') {
      readingText.textContent = m.text;
      readingFill.style.width = `${Math.round(m.fraction * 100)}%`;
    } else if (m.type === 'done') {
      finish();
      start(m.log);
    } else {
      finish();
      toast(m.message, 7000);
    }
  };
  worker.onerror = (e) => {
    finish();
    toast(`Could not read that folder: ${e.message}`, 7000);
  };
  worker.postMessage(msg);
}

openBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const pick = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (pick) {
    try {
      readFolder({ handle: await pick({ mode: 'read', id: 'cosmogit-repo' }) });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast((err as Error).message, 5000);
    }
  } else {
    // Safari/Firefox: pick the folder as an upload; only the .git contents are kept.
    dirPick.click();
  }
});
dirPick.addEventListener('change', () => {
  const all = [...(dirPick.files ?? [])];
  dirPick.value = '';
  if (!all.length) return;
  const name = all[0].webkitRelativePath.split('/')[0];
  const files = all.filter((f) => f.webkitRelativePath.includes('/.git/'));
  if (!files.length) {
    toast(`“${name}” has no .git folder inside it.`, 6000);
    return;
  }
  readFolder({ files, name });
});

const picker = document.getElementById('file') as HTMLInputElement;
const onPick = () => {
  const file = picker.files?.[0];
  if (file) void loadFile(file);
  picker.value = '';
};
picker.addEventListener('change', onPick);
// A file picked while the GPU was still initialising is still sitting in the input.
if (picker.files?.length) onPick();

// Demo buttons: the bundled public demo, plus (in dev) logs extracted into ./logs.
const samplesBox = document.getElementById('samples')!;
function addSample(label: string, url: string): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => loadUrl(url).catch((err) => toast(err.message));
  samplesBox.append(b);
}
addSample('zustand', '/demo/zustand.json');
if (import.meta.env.DEV) {
  fetch('/logs/index.json')
    .then((r) => (r.ok ? r.json() : []))
    .then((names: string[]) => names.forEach((n) => addSample(n.replace(/\.json$/, ''), `/logs/${n}`)))
    .catch(() => {});
}

document.getElementById('copy')!.addEventListener('click', async (e) => {
  e.stopPropagation();
  const text = document.getElementById('oneliner')!.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied. Paste it in a terminal inside your repo.');
  } catch {
    toast(text, 6000);
  }
});

// Shared links: /s/<id> loads /s/<id>.json.
const shared = /^\/s\/([\w-]+)\/?$/.exec(location.pathname);
if (shared) {
  drop.classList.add('hidden');
  toast('Loading galaxy…', 10_000);
  fetch(`/s/${shared[1]}.json`)
    .then(async (res) => {
      // Unknown ids fall through to the SPA rewrite and come back as HTML.
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error('missing');
      start(parseAny(await res.text(), shared[1]));
      toast('Click anywhere for sound', 4000);
    })
    .catch(() => {
      drop.classList.remove('hidden');
      toast('This link has expired or never existed', 6000);
    });
}

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
    labels.update();
    sound.tick(dt);
  }
  requestAnimationFrame(frame);
}
let exporting = false;
export function setExporting(v: boolean): void {
  exporting = v;
}
requestAnimationFrame(frame);

Object.assign(window, { app, sound, labels });
