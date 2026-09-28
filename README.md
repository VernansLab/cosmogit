# 3dgource

Your git history as a living 3D galaxy. Inspired by [Gource](https://gource.io/), rebuilt for the browser with Three.js.

- **Directories are star systems.** The repo root is the galactic core, and subtrees fan out into spiral arms.
- **Files are stars.** Colour comes from the extension and size from the line count. Recently touched stars burn blue-white and cool to a dim red.
- **Contributors are comets.** They fly to the files they change and fire beams at them.
  - A new file goes supernova with a shockwave.
  - An edit pulses the star, scaled by the diff size (green when lines are mostly added, red when mostly removed).
  - A deleted file implodes into dust.
  - A renamed file streaks across the galaxy to its new home.
- **Cinematic camera** that follows activity, dollies in on big commits and pulls out after quiet periods. Drag to take over; it returns to auto after 10 s of no input.
- **Procedural sound**: a pentatonic note per change. File type sets the pitch, diff size the loudness, and the author the instrument.
- **MP4 export** at 720p to 4K, 30/60 fps, rendered offline at a fixed timestep with the HUD burned in.
- HDR bloom, chromatic aberration, bokeh depth of field, nebula skybox and film grain.

## Usage

```sh
pnpm install
pnpm galaxy ~/code/some-repo              # extract history and open the viewer
pnpm galaxy ~/code/some-repo --first-parent   # mainline only (exact final tree)
```

Or extract a log and drop it on the page (`pnpm dev`):

```sh
pnpm extract ~/code/some-repo public/logs/some-repo.json
```

The viewer also accepts Gource custom logs (`gource --output-custom-log`).

Logs in `public/logs/` show up as buttons on the start screen.

### Keys

| key | action |
|---|---|
| space | play / pause |
| ← → | seek ±2% |
| + − | speed up / slow down |
| c | toggle auto / free camera |
| m | mute |
| h | hide HUD |
| Esc | stop an export |

Everything else (speed, look, layout, post FX, camera, sound, export) is in the **Galaxy** panel, top right.

## How it works

```
cli/extract.ts      git log --raw --numstat -> events JSON
src/data/           log parsers (git, Gource custom log)
src/sim/            RepoState (file tree over time), Playback (clock, idle skipping, seek)
src/layout/         deterministic galaxy layout with spring easing
src/render/         stars, filaments, particles, contributors, dust, nebula, post FX
src/camera/         cinematic director + OrbitControls handoff
src/audio/          Tone.js sonifier
src/export/         fixed-timestep WebCodecs MP4 export (mediabunny)
```

History is linearised in `--date-order`. Long-lived release branches that keep touching files deleted on master can leave a few extra stars behind; `--first-parent` gives an exact tree.
