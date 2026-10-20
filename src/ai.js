import { LINES, findWin, nextPlayer } from './game.js';
import { canonical, mapCellBack } from './symmetry.js';
import { OPENING_BOOK } from './opening-book.js';

const CELLS = 16;
const EXACT = 0;
const LOWER = 1;
const UPPER = 2;

// For each cell, the other two cells of every line through it, flattened:
// LINE_PAIRS[LINE_START[c] .. LINE_START[c + 1]) holds a0, b0, a1, b1, ...
const LINE_START = new Int32Array(CELLS + 1);
const LINE_PAIRS = new Int8Array(LINES.length * 3 * 2);
for (let cell = 0, n = 0; cell < CELLS; cell++) {
  LINE_START[cell] = n;
  for (const line of LINES) {
    if (!line.includes(cell)) continue;
    for (const c of line) if (c !== cell) LINE_PAIRS[n++] = c;
  }
  LINE_START[cell + 1] = n;
}

// Base-4 cell weights for a compact numeric position key (fits a double exactly).
const WEIGHT = Array.from({ length: CELLS }, (_, i) => 4 ** i);

function winsAt(board, cell, player) {
  for (let k = LINE_START[cell], end = LINE_START[cell + 1]; k < end; k += 2) {
    if (board[LINE_PAIRS[k]] === player && board[LINE_PAIRS[k + 1]] === player) return true;
  }
  return false;
}

function assertPlayable(board) {
  if (!board.includes(0)) throw new Error('board is full');
  for (const p of [1, 2, 3]) if (findWin(board, p)) throw new Error(`player ${p} has already won`);
}

// Paranoid alpha-beta: P maximises, both other players minimise P's score.
// When X completes a line with E empty cells left: X === P ? 100 + E : -(100 + E).
// Full board without a winner: 0.
function makeSearch(board, P) {
  const table = new Map();
  let hash = 0;
  for (let i = 0; i < CELLS; i++) hash += board[i] * WEIGHT[i];

  // Candidate moves for `toMove`, best-looking first. Pruning here is exact:
  // - if the mover can win, only winning cells (every win scores the same, and no
  //   other result is better for the mover);
  // - else if the next player is the mover's opponent (one of them is P) and has a
  //   winning cell, only those cells: any other move lets it win at once, which is
  //   the worst possible result for the mover;
  // - otherwise all empty cells, cells that block a win of either other player first.
  function orderedMoves(toMove) {
    const p2 = nextPlayer(toMove);
    const p3 = nextPlayer(p2);
    const enemyNext = toMove === P || p2 === P;
    const wins = [];
    const threats = [];
    const blocks = [];
    const rest = [];
    for (let i = 0; i < CELLS; i++) {
      if (board[i] !== 0) continue;
      if (winsAt(board, i, toMove)) wins.push(i);
      else if (winsAt(board, i, p2)) { threats.push(i); blocks.push(i); }
      else if (winsAt(board, i, p3)) blocks.push(i);
      else rest.push(i);
    }
    if (wins.length) return wins;
    if (enemyNext && threats.length) return threats;
    return blocks.concat(rest);
  }

  // Value for P of `toMove` playing `cell`, with `empties` empty cells before the move.
  function child(cell, toMove, empties, alpha, beta) {
    board[cell] = toMove;
    hash += toMove * WEIGHT[cell];
    let v;
    if (winsAt(board, cell, toMove)) v = toMove === P ? 100 + empties - 1 : -(100 + empties - 1);
    else if (empties === 1) v = 0;
    else v = search(nextPlayer(toMove), empties - 1, alpha, beta);
    hash -= toMove * WEIGHT[cell];
    board[cell] = 0;
    return v;
  }

  // Fail-soft alpha-beta. Result v: v <= alpha means true value <= v,
  // v >= beta means true value >= v, otherwise v is exact.
  function search(toMove, empties, alpha, beta) {
    const key = hash * 4 + toMove;
    const entry = table.get(key);
    if (entry !== undefined) {
      const score = (entry >> 2) - 128;
      const flag = entry & 3;
      if (flag === EXACT) return score;
      if (flag === LOWER && score >= beta) return score;
      if (flag === UPPER && score <= alpha) return score;
    }
    const alpha0 = alpha;
    const beta0 = beta;
    const maximising = toMove === P;
    let best = maximising ? -Infinity : Infinity;
    for (const cell of orderedMoves(toMove)) {
      const v = child(cell, toMove, empties, alpha, beta);
      if (maximising) {
        if (v > best) best = v;
        if (best > alpha) alpha = best;
      } else {
        if (v < best) best = v;
        if (best < beta) beta = best;
      }
      if (alpha >= beta) break;
    }
    const flag = best <= alpha0 ? UPPER : best >= beta0 ? LOWER : EXACT;
    table.set(key, ((best + 128) << 2) | flag);
    return best;
  }

  return child;
}

export function bestMoves(board, player) {
  assertPlayable(board);
  const b = Int8Array.from(board);
  let empties = 0;
  for (const v of b) if (v === 0) empties++;
  const child = makeSearch(b, player);
  // Every empty cell is searched (the full set of best moves is needed), in a
  // promising order so a high `score` is found early and tightens the window.
  const order = [];
  for (let cell = 0; cell < CELLS; cell++) {
    if (b[cell] !== 0) continue;
    const p2 = nextPlayer(player);
    const rank = winsAt(b, cell, player) ? 0 : winsAt(b, cell, p2) || winsAt(b, cell, nextPlayer(p2)) ? 1 : 2;
    order.push([rank, cell]);
  }
  order.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let score = -Infinity;
  let moves = [];
  for (const [, cell] of order) {
    // Integer scores: with alpha = score - 1, any v >= score is exact; v < score is discarded.
    const v = child(cell, player, empties, score - 1, Infinity);
    if (v > score) { score = v; moves = [cell]; } else if (v === score) moves.push(cell);
  }
  moves.sort((x, y) => x - y);
  return { score, moves };
}

export function bookKey(board, player) {
  return `${canonical(board).key}${player}`;
}

export function chooseMove(board, player, { random = Math.random } = {}) {
  const { key, transform } = canonical(board);
  const book = OPENING_BOOK[`${key}${player}`];
  if (book && book.length) {
    return mapCellBack(book[Math.floor(random() * book.length)], transform);
  }
  const { moves } = bestMoves(board, player);
  return moves[Math.floor(random() * moves.length)];
}
