/** FNV-1a string hash. */
export function hash32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic float in [0, 1) from a string. */
export function hash01(s: string, salt = 0): number {
  return hash32(s, (0x811c9dc5 ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0) / 4294967296;
}
