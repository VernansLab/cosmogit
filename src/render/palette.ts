import { Color } from 'three/webgpu';
import { hash01 } from '../layout/hash';

const EXT_COLORS: Record<string, string> = {
  ts: '#3b8eea', tsx: '#4fc3f7', js: '#f5d547', jsx: '#ffe082', mjs: '#f5d547', cjs: '#f5d547',
  json: '#9ccc65', md: '#e0e0e0', mdx: '#e0e0e0', txt: '#bdbdbd',
  css: '#ab47bc', scss: '#ec407a', less: '#7e57c2', html: '#ff7043', vue: '#41b883', svelte: '#ff3e00',
  py: '#4dd0e1', rb: '#e53935', go: '#00add8', rs: '#ff8a50', java: '#f89820', kt: '#a97bff',
  swift: '#ff6f3c', c: '#90a4ae', h: '#b0bec5', cpp: '#5c9bd6', hpp: '#7fb3e0', cs: '#68217a',
  php: '#8892bf', sh: '#8bc34a', zsh: '#8bc34a', yml: '#ff80ab', yaml: '#ff80ab', toml: '#ffab91',
  lock: '#546e7a', svg: '#ffb74d', png: '#ce93d8', jpg: '#ce93d8', gif: '#ce93d8',
  dart: '#40c4ff', lua: '#5c6bc0', sql: '#ffca28', xml: '#a1887f',
};

const cache = new Map<string, Color>();

export function extColor(ext: string): Color {
  let c = cache.get(ext);
  if (!c) {
    const known = EXT_COLORS[ext];
    c = known ? new Color(known) : new Color().setHSL(hash01(ext, 7), 0.65, 0.62);
    cache.set(ext, c);
  }
  return c;
}

export function authorColor(name: string): Color {
  return new Color().setHSL(hash01(name, 11), 0.8, 0.65);
}

export function cssColor(c: Color): string {
  return `#${c.getHexString()}`;
}
