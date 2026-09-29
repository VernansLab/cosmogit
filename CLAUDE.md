# Cosmogit

3D, browser-based take on Gource: git history rendered as a galaxy (Three.js WebGPURenderer + TSL, Vite, TypeScript strict, pnpm).

## Commands
- `pnpm dev`: viewer on http://localhost:5178 (`?log=logs/<name>.json` preloads a log)
- `pnpm cosmogit <repo> [--first-parent]`: extract + open
- `pnpm extract <repo> [out.json]`
- `pnpm test` (vitest), `pnpm typecheck`, `pnpm build` (also bundles `cli/get.ts` → `dist/get`)
- `pnpm deploy`: Firebase Hosting, project `cosmogit` (account max@flach.io) → https://cosmogit.web.app

## Architecture notes
- `App.advance(dt)` is the single clock: every shader uses `app.time`, never `performance.now()`. The MP4 exporter relies on this to step at a fixed dt.
- Node ids (files, dirs) are never reused; renderers index GPU buffers by id.
- Star/particle motion is analytic in shaders; the CPU only writes attributes on events (particles use a ring buffer with update ranges).
- Rendering is `WebGPURenderer` with TSL node materials only (no GLSL). It falls back to WebGL2 automatically; `?webgl` forces the fallback. Test both after shader changes.
- Point sprites are `Sprite` + `PointsNodeMaterial` with `count` (instanced quads); sizes are CSS pixels (the renderer applies the pixel ratio).
- Stars: a compute pass (`Stars.ts`) springs/spins every file on the GPU. The CPU only keeps target offsets and directory springs; `GalaxyLayout.filePosition()` evaluates the settled position with the same maths, keep the two in sync.
- Anything the compute kernel gathers by index must be a texture (`textureLoad`), not a storage buffer: the WebGL2 fallback can't random-access storage buffers.
- GPU buffers are sized once per log (`RepoState.capacityFor`), so file/dir ids never outgrow them.
- Additive sprites don't write depth, so DoF is done per-star in the vertex shader (bokeh), not as a post pass. Post (bloom, ACES, CA, vignette, grain) is three's `RenderPipeline`.
- A change's star effects fire when the contributor's beam arrives (`BEAM_TIME` in App.ts), not at commit time.
- `logs/*.json` is gitignored (extracted user data).

## Verifying visually
Background Chrome tabs pause rAF. Drive frames manually via `window.app.advance(1/60)` in the console.

## Privacy
- Local logs live in `./logs` (served by the dev server only). Never put user logs in `public/`: everything there ships in the build and gets deployed.
- `public/demo/zustand.json` is the one public demo (emails stripped).
- `shared/` (gitignored) holds `pnpm share` data, copied to `dist/s/` on build. A deploy from a machine without it removes every shared link.
