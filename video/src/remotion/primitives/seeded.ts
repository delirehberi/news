/**
 * Frame-deterministic seeded PRNG utilities (no `Math.random`).
 * All visual jitter in Remotion primitives is derived from `storyIndex` (and optional sub-seed)
 * so rendering any frame in any order produces identical output.
 */

const UINT32_MAX = 0xffffffff;

/**
 * Deterministic 32-bit FNV-1a + Murmur3 avalanche hash for numeric or string seeds.
 */
export function hashSeed(seed: number | string, salt: number = 0): number {
  let h = (0x811c9dc5 ^ (Math.trunc(Number(salt) || 0) * 0x9e3779b9)) >>> 0;
  const text = typeof seed === 'number' ? `n:${Math.trunc(seed)}` : `s:${seed}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Mulberry32 deterministic PRNG returning values in `[0, 1)`.
 */
export function createSeededRandom(seed: number | string, salt: number = 0): () => number {
  let state = hashSeed(seed, salt) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / (UINT32_MAX + 1);
  };
}

/**
 * Returns a deterministic float in `[min, max]` for `(seed, index)`.
 */
export function seededRange(
  seed: number | string,
  index: number,
  min: number,
  max: number
): number {
  const rng = createSeededRandom(seed, index + 1);
  return min + rng() * (max - min);
}

/**
 * Returns a deterministic symmetric offset in `[-amplitude, +amplitude]` for `(seed, index)`.
 */
export function seededJitter(
  seed: number | string,
  index: number,
  amplitude: number
): number {
  if (amplitude <= 0) {
    return 0;
  }
  return seededRange(seed, index, -amplitude, amplitude);
}
