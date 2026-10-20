// The 8 symmetries of the 4x4 board. Each transform t satisfies
// transformed[i] = board[t[i]], i.e. t[newIndex] = oldIndex.
const N = 4;
const M = N - 1;

// Each map takes a new (r, c) to the old (r, c) it is read from.
const MAPS = [
  (r, c) => [r, c],         // identity
  (r, c) => [c, M - r],     // rotate 90
  (r, c) => [M - r, M - c], // rotate 180
  (r, c) => [M - c, r],     // rotate 270
  (r, c) => [r, M - c],     // mirror horizontally
  (r, c) => [M - r, c],     // mirror vertically
  (r, c) => [c, r],         // main diagonal
  (r, c) => [M - c, M - r], // anti-diagonal
];

export const TRANSFORMS = MAPS.map((map) =>
  Array.from({ length: N * N }, (_, i) => {
    const [r, c] = map(Math.floor(i / N), i % N);
    return r * N + c;
  }));

export function applyTransform(board, t) {
  return t.map((old) => board[old]);
}

export function canonical(board) {
  let key = null;
  let transform = null;
  for (const t of TRANSFORMS) {
    const k = applyTransform(board, t).join('');
    if (key === null || k < key) { key = k; transform = t; }
  }
  return { key, transform };
}

export function mapCellBack(cell, transform) {
  return transform[cell];
}
