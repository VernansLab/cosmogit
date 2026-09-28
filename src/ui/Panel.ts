import { Pane } from 'tweakpane';
import type { App } from '../App';

export interface PanelActions {
  exportVideo?: (opts: ExportChoice) => void;
  audio?: { enabled: boolean; volume: number; onChange: () => void };
}

export interface ExportChoice {
  resolution: '720p' | '1080p' | '1440p' | '4k';
  fps: 30 | 60;
  seconds: number;
  fromStart: boolean;
}

/** Tweakpane settings panel. */
export class Panel {
  readonly pane: Pane;

  constructor(app: App, actions: PanelActions) {
    this.pane = new Pane({ title: 'Galaxy', expanded: false });
    const s = app.settings;
    const apply = () => app.applySettings();

    const play = this.pane.addFolder({ title: 'Playback' });
    play.addBinding(s, 'secondsPerDay', { label: 'sec / day', min: 0.02, max: 5, step: 0.01 }).on('change', apply);
    play.addBinding(s, 'autoSkipSeconds', { label: 'skip idle', min: 0.2, max: 10, step: 0.1 }).on('change', apply);
    play.addBinding(s, 'loop').on('change', apply);

    const look = this.pane.addFolder({ title: 'Look' });
    look.addBinding(s, 'starSize', { label: 'star size', min: 0.3, max: 3 }).on('change', apply);
    look.addBinding(s, 'heatDecay', { label: 'heat decay', min: 1, max: 40 }).on('change', apply);
    look.addBinding(s, 'aperture', { label: 'bokeh', min: 0, max: 60 }).on('change', apply);
    look.addBinding(s, 'filaments', { min: 0, max: 1.5 }).on('change', apply);
    look.addBinding(s, 'nebula', { min: 0, max: 1.5 }).on('change', apply);
    look.addBinding(s, 'dust', { label: 'galactic dust', min: 0, max: 1.5 }).on('change', apply);
    look.addBinding(s, 'particleDensity', { label: 'particles', min: 0, max: 3 }).on('change', apply);

    const lp = app.layout.params;
    const layout = this.pane.addFolder({ title: 'Layout', expanded: false });
    const relayout = () => app.layout.compute(true);
    layout.addBinding(lp, 'fileSpacing', { label: 'star spacing', min: 0.5, max: 5 }).on('change', relayout);
    layout.addBinding(lp, 'gap', { min: 0, max: 20 }).on('change', relayout);
    layout.addBinding(lp, 'spiralTwist', { label: 'spiral twist', min: -1.5, max: 1.5 }).on('change', relayout);
    layout.addBinding(lp, 'discFlatten', { label: 'disc flatten', min: 0.05, max: 1 }).on('change', relayout);
    layout.addBinding(lp, 'tilt', { min: 0, max: 1.5 }).on('change', relayout);
    layout.addBinding(lp, 'spin', { min: 0, max: 2 });

    const post = app.post.settings;
    const fx = this.pane.addFolder({ title: 'Post FX', expanded: false });
    const applyPost = () => app.post.apply();
    fx.addBinding(post, 'bloom').on('change', applyPost);
    fx.addBinding(post, 'bloomIntensity', { label: 'intensity', min: 0, max: 5 }).on('change', applyPost);
    fx.addBinding(post, 'bloomThreshold', { label: 'threshold', min: 0, max: 1.5 }).on('change', applyPost);
    fx.addBinding(post, 'chromatic').on('change', applyPost);
    fx.addBinding(post, 'chromaticAmount', { label: 'aberration', min: 0, max: 0.01, step: 0.0001 }).on('change', applyPost);
    fx.addBinding(post, 'vignette').on('change', applyPost);
    fx.addBinding(post, 'grain').on('change', applyPost);
    fx.addBinding(post, 'grainAmount', { label: 'grain amt', min: 0, max: 0.4 }).on('change', applyPost);

    const cam = this.pane.addFolder({ title: 'Camera', expanded: false });
    const camState = { mode: app.director.mode as string };
    cam
      .addBinding(camState, 'mode', { options: { 'Auto (cinematic)': 'auto', Free: 'free' } })
      .on('change', (e) => app.director.setMode(e.value as 'auto' | 'free'));
    cam.addBinding(app.director, 'orbitSpeed', { label: 'orbit speed', min: -0.5, max: 0.5 });
    cam.addBinding(app.director, 'returnAfter', { label: 'auto after (s)', min: 2, max: 60, step: 1 });
    cam.addBinding(app.director, 'context', { min: 0, max: 1 });
    // Keep the dropdown honest when the director switches on its own.
    setInterval(() => {
      if (camState.mode !== app.director.mode) {
        camState.mode = app.director.mode;
        this.pane.refresh();
      }
    }, 500);

    if (actions.audio) {
      const au = actions.audio;
      const sound = this.pane.addFolder({ title: 'Sound', expanded: false });
      sound.addBinding(au, 'enabled').on('change', au.onChange);
      sound.addBinding(au, 'volume', { min: 0, max: 1 }).on('change', au.onChange);
    }

    if (actions.exportVideo) {
      const choice: ExportChoice = { resolution: '1080p', fps: 60, seconds: 30, fromStart: true };
      const ex = this.pane.addFolder({ title: 'Export MP4', expanded: false });
      ex.addBinding(choice, 'resolution', { options: { '720p': '720p', '1080p': '1080p', '1440p': '1440p', '4K': '4k' } });
      ex.addBinding(choice, 'fps', { options: { 30: 30, 60: 60 } });
      ex.addBinding(choice, 'seconds', { label: 'length (s)', min: 5, max: 600, step: 5 });
      ex.addBinding(choice, 'fromStart', { label: 'from start' });
      ex.addButton({ title: 'Render video' }).on('click', () => actions.exportVideo!(choice));
    }
  }
}
