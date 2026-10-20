import { LINES_4, VARIANTS, nextPlayer } from './game.js';

const CELLS = 16;
const { maxMarks: MAX_MARKS, moveLimit: MOVE_LIMIT } = VARIANTS.houdini;
const WIN = 10000;
const EXACT = 0;
const LOWER = 1;
const UPPER = 2;
const SCORE_OFFSET = 16384; // packs scores in [-WIN, WIN] into a small positive int
const TIME_UP = Symbol('time up');
const TABLE_BITS = 18;
const DECIDED = WIN - 100; // |score| above this: a forced win or loss, found within the search

const LINE_COUNT = LINES_4.length;
// LINE_MASK[c]: bit l set when cell c is on line l. LINE_IDS[LINE_START[c] .. LINE_START[c + 1])
// lists the same lines.
const LINE_MASK = new Int32Array(CELLS);
const LINE_START = new Int32Array(CELLS + 1);
const LINE_IDS = new Int8Array(LINE_COUNT * 4);
for (let cell = 0, n = 0; cell < CELLS; cell++) {
  LINE_START[cell] = n;
  LINES_4.forEach((line, l) => {
    if (!line.includes(cell)) return;
    LINE_MASK[cell] |= 1 << l;
    LINE_IDS[n++] = l;
  });
  LINE_START[cell + 1] = n;
}

// Moves `cell` (if among the first `n` entries of `moves`) to the front, keeping the rest in order.
function toFront(moves, n, cell) {
  if (cell < 0) return;
  for (let i = 1; i < n; i++) {
    if (moves[i] === cell) {
      moves.copyWithin(1, 0, i);
      moves[0] = cell;
      return;
    }
  }
}

function assertHoudini(state) {
  if (state.variant !== 'houdini') throw new Error('not a Houdini game');
  if (state.isOver) throw new Error('game is over');
}

// Win/loss score for P when `winner` completes a line on move `moveCount`.
const winScore = (winner, P, moveCount) => (winner === P ? WIN - moveCount : moveCount - WIN);

// Fixed-size transposition table shared by the iterations of one call. A slot holds the
// position key, its ply below the root, the iteration (search depth) that wrote it, and
// ((score + SCORE_OFFSET) << 6) | (best cell << 2) | flag. Scores are only trusted from the
// current iteration, so each depth effectively starts with a new table; best cells from
// earlier iterations are only used to order moves. Slots are always replaced.
function makeTable() {
  const size = 1 << TABLE_BITS;
  return {
    mask: size - 1,
    keys: new Float64Array(size),
    data: new Int32Array(size),
    plies: new Int8Array(size),
    iters: new Int8Array(size), // 0 = empty
  };
}

// Paranoid alpha-beta over a mutable copy of `state`: P (the player to move at the root)
// maximises, both other players minimise P's score. Rules mirror game.js `play`:
// place, vanish the mover's oldest mark if they now have 5, check for 4 in a line,
// then a draw if this was move 60.
function makeSearch(state, searchDepth, table, { timed = false, now = null, start = 0, budget = Infinity } = {}) {
  const P = state.currentPlayer;
  const board = Int8Array.from(state.board);
  // Oldest-first queues: player p's marks live in queue[(p - 1) * 4 .. + len[p - 1]).
  const queue = new Int8Array(3 * MAX_MARKS);
  const len = new Int8Array(3);
  for (let p = 0; p < 3; p++) {
    state.marks[p].forEach((c, i) => { queue[p * MAX_MARKS + i] = c; });
    len[p] = state.marks[p].length;
  }
  // count[l * 4 + p]: player p's marks on line l, vanishing marks included.
  const count = new Int8Array(LINE_COUNT * 4);
  for (let c = 0; c < CELLS; c++) {
    if (board[c] !== 0) for (let k = LINE_START[c]; k < LINE_START[c + 1]; k++) count[LINE_IDS[k] * 4 + board[c]]++;
  }
  const rootMoveCount = state.moveCount;
  let moveCount = rootMoveCount;
  // Table entries are keyed by ply below the root and the queue contents. The queues fix the
  // board and the order of every player's marks; the ply fixes the move count, the player to
  // move, the remaining depth and every queue length (so the queue contents decode uniquely).
  const { mask, keys, data, plies, iters } = table;
  let nodes = 0;
  let hash = 0; // 32-bit mix of the key, set by key()
  // A move list per ply, reused across nodes.
  const moveLists = Array.from({ length: searchDepth + 1 }, () => new Int8Array(CELLS));
  const killers = new Int8Array(searchDepth + 1).fill(-1); // last cell that caused a cutoff, per ply

  // Lines through `p`'s vanishing mark (0 when `p` has fewer than 4 marks).
  const vanishingLines = (p) => (len[p - 1] === MAX_MARKS ? LINE_MASK[queue[(p - 1) * MAX_MARKS]] : 0);

  // Lines `p` completes by filling their remaining cell: 3 of `p`'s marks, none of them the
  // vanishing one (no line holds 4, or the game would be over).
  function winLines(p) {
    let m = 0;
    for (let l = 0; l < LINE_COUNT; l++) if (count[l * 4 + p] === 3) m |= 1 << l;
    return m & ~vanishingLines(p);
  }

  // Would `p` placing on the empty `cell` complete a line?
  const winsAt = (cell, p) => (LINE_MASK[cell] & winLines(p)) !== 0;

  function addLines(cell, p, d) {
    for (let k = LINE_START[cell], end = LINE_START[cell + 1]; k < end; k++) count[LINE_IDS[k] * 4 + p] += d;
  }

  // Places `p` on `cell`; returns the vanished cell or -1.
  function apply(cell, p) {
    const base = (p - 1) * MAX_MARKS;
    let gone = -1;
    if (len[p - 1] === MAX_MARKS) {
      gone = queue[base];
      queue[base] = queue[base + 1];
      queue[base + 1] = queue[base + 2];
      queue[base + 2] = queue[base + 3];
      queue[base + 3] = cell;
      board[gone] = 0;
      addLines(gone, p, -1);
    } else {
      queue[base + len[p - 1]] = cell;
      len[p - 1]++;
    }
    board[cell] = p;
    addLines(cell, p, 1);
    moveCount++;
    return gone;
  }

  function undo(cell, p, gone) {
    const base = (p - 1) * MAX_MARKS;
    board[cell] = 0;
    addLines(cell, p, -1);
    moveCount--;
    if (gone >= 0) {
      queue[base + 3] = queue[base + 2];
      queue[base + 2] = queue[base + 1];
      queue[base + 1] = queue[base];
      queue[base] = gone;
      board[gone] = p;
      addLines(gone, p, 1);
    } else {
      len[p - 1]--;
    }
  }

  function key() {
    let k = 0;
    let h = 0;
    for (let p = 0; p < 3; p++) {
      const base = p * MAX_MARKS;
      for (let i = 0; i < len[p]; i++) {
        k = k * CELLS + queue[base + i];
        h = Math.imul(h ^ (queue[base + i] + 1), 0x9e3779b1);
      }
    }
    hash = h ^ (h >>> 16);
    return k; // at most 16^12 = 2^48: exact in a double
  }

  // Σ over lines held by a single player of ±count², vanishing marks excluded.
  function leaf() {
    const g1 = vanishingLines(1);
    const g2 = vanishingLines(2);
    const g3 = vanishingLines(3);
    let value = 0;
    for (let l = 0; l < LINE_COUNT; l++) {
      const n1 = count[l * 4 + 1] - ((g1 >> l) & 1);
      const n2 = count[l * 4 + 2] - ((g2 >> l) & 1);
      const n3 = count[l * 4 + 3] - ((g3 >> l) & 1);
      let owner = 0;
      let n = 0;
      if (n1) { owner = 1; n = n1; }
      if (n2) { if (owner) continue; owner = 2; n = n2; }
      if (n3) { if (owner) continue; owner = 3; n = n3; }
      if (owner) value += owner === P ? n * n : -n * n;
    }
    return value;
  }

  // Value for P of `toMove` playing the empty `cell`, searching `depth - 1` plies after it.
  function child(cell, toMove, depth, alpha, beta) {
    if (winsAt(cell, toMove)) return winScore(toMove, P, moveCount + 1);
    if (moveCount + 1 === MOVE_LIMIT) return 0;
    const gone = apply(cell, toMove);
    const v = depth === 1 ? leaf() : search(nextPlayer(toMove), depth - 1, alpha, beta);
    undo(cell, toMove, gone);
    return v;
  }

  // Fail-soft alpha-beta for a non-terminal position, depth >= 1. Result v: v <= alpha
  // means true value <= v, v >= beta means true value >= v, otherwise v is exact.
  function search(toMove, depth, alpha, beta) {
    if (timed && (++nodes & 1023) === 0 && now() - start > budget) throw TIME_UP;
    const ply = moveCount - rootMoveCount;
    const k = key();
    const slot = (hash ^ Math.imul(ply, 0x85ebca6b)) & mask;
    let hint = -1;
    if (iters[slot] !== 0 && keys[slot] === k && plies[slot] === ply) {
      const entry = data[slot];
      hint = (entry >> 2) & 15;
      if (iters[slot] === searchDepth) {
        const score = (entry >> 6) - SCORE_OFFSET;
        const flag = entry & 3;
        if (flag === EXACT) return score;
        if (flag === LOWER && score >= beta) return score;
        if (flag === UPPER && score <= alpha) return score;
      }
    }

    // Exact shortcuts:
    // - the mover can complete a line: nothing scores better for the mover than winning
    //   now, so that is the value;
    // - the next player is the mover's opponent (one of them is P), has at least two winning
    //   cells, or a winning cell the mover's own vanishing mark frees: every move lets them
    //   win at once (as long as depth >= 2 sees that reply and move 60 is not reached first),
    //   the worst result for the mover, so that is the value;
    // - exactly one such cell: every other move scores that worst result, and blocking scores
    //   strictly better (a later loss, a leaf evaluation, a draw or a win), so only block.
    const p2 = nextPlayer(toMove);
    const p3 = nextPlayer(p2);
    const enemyNext = toMove === P || p2 === P;
    const own = winLines(toMove);
    const next = winLines(p2);
    const after = winLines(p3);
    const blocking = next | after;
    const moves = moveLists[ply];
    let n = 0;
    let threats = 0;
    let threat = -1;
    // Blocks first (cells completing a line of either other player), then the rest.
    for (let i = 0; i < CELLS; i++) {
      if (board[i] !== 0) continue;
      const m = LINE_MASK[i];
      if (m & own) return winScore(toMove, P, moveCount + 1);
      if (m & next) { threats++; threat = i; }
      if (m & blocking) moves[n++] = i;
    }
    if (enemyNext && depth >= 2 && moveCount + 1 < MOVE_LIMIT
      && (threats >= 2 || (vanishingLines(toMove) & next))) return winScore(p2, P, moveCount + 2);
    if (enemyNext && depth >= 2 && moveCount + 1 < MOVE_LIMIT && threats === 1) {
      moves[0] = threat;
      n = 1;
    } else {
      for (let i = 0; i < CELLS; i++) if (board[i] === 0 && !(LINE_MASK[i] & blocking)) moves[n++] = i;
    }

    const alpha0 = alpha;
    const beta0 = beta;
    const maximising = toMove === P;
    // The table's best cell first, then this ply's killer.
    toFront(moves, n, killers[ply]);
    toFront(moves, n, hint);
    let best = maximising ? -Infinity : Infinity;
    let bestCell = moves[0];
    for (let j = 0; j < n; j++) {
      const cell = moves[j];
      const v = child(cell, toMove, depth, alpha, beta);
      if (maximising ? v > best : v < best) { best = v; bestCell = cell; }
      if (maximising) {
        if (best > alpha) alpha = best;
      } else if (best < beta) beta = best;
      if (alpha >= beta) { killers[ply] = cell; break; }
    }
    const flag = best <= alpha0 ? UPPER : best >= beta0 ? LOWER : EXACT;
    keys[slot] = k;
    plies[slot] = ply;
    iters[slot] = searchDepth;
    data[slot] = ((best + SCORE_OFFSET) << 6) | (bestCell << 2) | flag;
    return best;
  }

  // All best root moves at `searchDepth`, ascending. `first` (if any) is searched first.
  return function root(first = -1) {
    const p2 = nextPlayer(P);
    const p3 = nextPlayer(p2);
    const order = [];
    for (let cell = 0; cell < CELLS; cell++) {
      if (board[cell] !== 0) continue;
      const rank = cell === first ? 0 : winsAt(cell, P) ? 1 : winsAt(cell, p2) || winsAt(cell, p3) ? 2 : 3;
      order.push([rank, cell]);
    }
    order.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let score = -Infinity;
    let moves = [];
    for (const [, cell] of order) {
      // Integer scores: with alpha = score - 1, any v >= score is exact; v < score is discarded.
      const v = child(cell, P, searchDepth, score - 1, Infinity);
      if (v > score) { score = v; moves = [cell]; } else if (v === score) moves.push(cell);
    }
    moves.sort((x, y) => x - y);
    return { score, moves };
  };
}

export function bestHoudiniMoves(state, depth) {
  assertHoudini(state);
  if (!Number.isInteger(depth) || depth < 1) throw new Error(`invalid depth ${depth}`);
  // Searching past move 60 finds nothing new.
  return makeSearch(state, Math.min(depth, MOVE_LIMIT - state.moveCount), makeTable())();
}

export function chooseHoudiniMove(state, {
  random = Math.random, timeBudgetMs = 400, maxDepth = Infinity, now = () => performance.now(),
} = {}) {
  assertHoudini(state);
  const start = now();
  // Deeper than the end of the game searches nothing new.
  const lastDepth = Math.max(1, Math.min(maxDepth, MOVE_LIMIT - state.moveCount));
  const table = makeTable();
  let result = makeSearch(state, 1, table)(); // depth 1 always completes
  for (let depth = 2; depth <= lastDepth; depth++) {
    // A forced win or loss is already found: searching deeper cannot change the choice.
    if (Math.abs(result.score) > DECIDED) break;
    if (now() - start > timeBudgetMs) break;
    try {
      // Previous depth's best move first.
      result = makeSearch(state, depth, table, { timed: true, now, start, budget: timeBudgetMs })(result.moves[0]);
    } catch (e) {
      if (e === TIME_UP) break; // abandon this depth; keep the last completed one
      throw e;
    }
  }
  const { moves } = result;
  return moves[Math.floor(random() * moves.length)];
}
