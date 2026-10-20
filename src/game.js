const SIZE = 4;
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

function buildLines(length) {
  const lines = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      for (const [dr, dc] of DIRECTIONS) {
        const er = r + (length - 1) * dr;
        const ec = c + (length - 1) * dc;
        if (er < 0 || er >= SIZE || ec < 0 || ec >= SIZE) continue;
        lines.push(Array.from({ length }, (_, i) => i).map((i) => (r + i * dr) * SIZE + (c + i * dc)).sort((a, b) => a - b));
      }
    }
  }
  return lines;
}

export const LINES = buildLines(3);
export const LINES_4 = buildLines(4);

export const VARIANTS = {
  childsplay: { winLength: 3, maxMarks: Infinity, moveLimit: null },
  houdini: { winLength: 4, maxMarks: 4, moveLimit: 60 },
};

const linesFor = (variant) => (VARIANTS[variant].winLength === 4 ? LINES_4 : LINES);

export const nextPlayer = (player) => (player % 3) + 1;

export function newGame(startingPlayer = 1, variant = 'childsplay') {
  if (!Object.hasOwn(VARIANTS, variant)) throw new Error(`unknown variant ${variant}`);
  return {
    variant,
    marks: [[], [], []],
    moveCount: 0,
    vanished: null,
    board: new Array(SIZE * SIZE).fill(0),
    startingPlayer,
    currentPlayer: startingPlayer,
    winner: 0,
    winningLine: null,
    isDraw: false,
    isOver: false,
  };
}

export function findWin(board, player) {
  return LINES.find((line) => line.every((i) => board[i] === player)) ?? null;
}

export function vanishingCell(state, player) {
  const own = state.marks[player - 1];
  return own.length >= VARIANTS[state.variant].maxMarks ? own[0] : null;
}

export function legalMoves(state) {
  if (state.isOver) return [];
  const moves = [];
  state.board.forEach((v, i) => { if (v === 0) moves.push(i); });
  return moves;
}

export function play(state, cell) {
  if (state.isOver) throw new Error('game is over');
  if (!Number.isInteger(cell) || cell < 0 || cell >= SIZE * SIZE) throw new Error(`invalid cell ${cell}`);
  if (state.board[cell] !== 0) throw new Error(`cell ${cell} is occupied`);
  const { variant } = state;
  const rules = VARIANTS[variant];
  const board = state.board.slice();
  const marks = state.marks.map((m) => m.slice());
  const own = marks[state.currentPlayer - 1];
  const vanished = vanishingCell(state, state.currentPlayer);
  if (vanished !== null) {
    board[vanished] = 0;
    own.shift();
  }
  board[cell] = state.currentPlayer;
  own.push(cell);
  const moveCount = state.moveCount + 1;
  const winningLine = linesFor(variant).find((line) => line.every((i) => board[i] === state.currentPlayer)) ?? null;
  const isDraw = !winningLine
    && (rules.moveLimit === null ? board.every((v) => v !== 0) : moveCount === rules.moveLimit);
  return {
    variant,
    marks,
    moveCount,
    vanished,
    board,
    startingPlayer: state.startingPlayer,
    currentPlayer: nextPlayer(state.currentPlayer),
    winner: winningLine ? state.currentPlayer : 0,
    winningLine,
    isDraw,
    isOver: Boolean(winningLine) || isDraw,
  };
}

export function newMatch(humanPlayer, variant = 'childsplay') {
  return { humanPlayer, variant, round: 1, scores: [0, 0, 0], roundOver: false, isOver: false };
}

export function startRound(match) {
  return newGame(match.round, match.variant);
}

export function recordResult(match, state) {
  if (!state.isOver) throw new Error('round is not finished');
  if (match.roundOver) throw new Error('round already recorded');
  const scores = match.scores.slice();
  if (state.winner) scores[state.winner - 1] += 1;
  return { ...match, scores, roundOver: true, isOver: match.round === 3 };
}

export function nextRound(match) {
  if (!match.roundOver) throw new Error('round is not finished');
  if (match.isOver) throw new Error('match is over');
  return { ...match, round: match.round + 1, roundOver: false };
}

export function matchWinners(match) {
  const top = Math.max(...match.scores);
  return match.scores.flatMap((s, i) => (s === top ? [i + 1] : []));
}
