# 3dgource

3D, browser-based take on Gource: git history rendered as a galaxy (Three.js + postprocessing, Vite, TypeScript strict, pnpm).

## Commands
- `pnpm dev`: viewer on http://localhost:5178 (`?log=logs/<name>.json` preloads a log)
- `pnpm galaxy <repo> [--first-parent]`: extract + open
- `pnpm extract <repo> [out.json]`
- `pnpm test` (vitest), `pnpm typecheck`, `pnpm build`

## Architecture notes
- `App.advance(dt)` is the single clock: every shader uses `app.time`, never `performance.now()`. The MP4 exporter relies on this to step at a fixed dt.
- Node ids (files, dirs) are never reused; renderers index GPU buffers by id.
- Star/particle motion is analytic in shaders; the CPU only writes attributes on events (particles use a ring buffer with update ranges).
- Additive sprites don't write depth, so DoF is done per-star in the vertex shader (bokeh), not as a post pass.
- A change's star effects fire when the contributor's beam arrives (`BEAM_TIME` in App.ts), not at commit time.
- `public/logs/*.json` is gitignored (extracted user data).

## Verifying visually
Background Chrome tabs pause rAF. Drive frames manually via `window.app.advance(1/60)` in the console.
