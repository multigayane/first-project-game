import {
  newGame, play, newMatch, startRound, recordResult, nextRound, matchWinners, vanishingCell, VARIANTS,
} from './game.js';
import { chooseMove } from './ai.js';
import { chooseHoudiniMove } from './ai-houdini.js';

/** Pause before a computer move. Houdini then searches for up to ~0.4 s, so the pace stays about 0.6 s. */
const COMPUTER_DELAY_MS = { childsplay: 600, houdini: 200 };
const CHOOSE_MOVE = {
  childsplay: (game) => chooseMove(game.board, game.currentPlayer),
  houdini: (game) => chooseHoudiniMove(game),
};
const VARIANT_NAMES = { childsplay: "Child's Play", houdini: 'Houdini' };
const NAMES = { 1: 'Cross', 2: 'Circle', 3: 'Triangle' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPES = {
  1: [['line', { x1: 24, y1: 24, x2: 76, y2: 76 }], ['line', { x1: 76, y1: 24, x2: 24, y2: 76 }]],
  2: [['circle', { cx: 50, cy: 50, r: 29 }]],
  3: [['polygon', { points: '50,19 83,78 17,78' }]],
};

/** Inline SVG for a player's mark. Decorative: the name is always given in text or a label. */
function markSvg(player) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', `mark mark--${player}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of SHAPES[player]) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

/** The mark drawn, followed by its name for screen readers only. */
function markInline(player) {
  const name = document.createElement('span');
  name.className = 'sr-only';
  name.textContent = NAMES[player];
  return [markSvg(player), name];
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

export function init(root) {
  const $ = (sel) => root.querySelector(sel);
  const setupForm = $('[data-setup]');
  const gameView = $('[data-game]');
  const infoEl = $('[data-game-info]');
  const playersEl = $('[data-players]');
  const boardEl = $('[data-board]');
  const statusEl = $('[data-status]');
  const nextRoundBtn = $('[data-next-round]');
  const newGameBtn = $('[data-new-game]');

  /**
   * `ghost`: the mark that vanished in the last move ({ cell, player }), shown fading out once.
   * `humanTurnAt`: when the cells were last enabled for the human (performance.now() time).
   * @type {{ humanPlayer: number, match: object|null, game: object|null, pendingTimer: number|null, ghost: object|null, humanTurnAt: number }}
   */
  const state = { humanPlayer: 1, match: null, game: null, pendingTimer: null, ghost: null, humanTurnAt: 0 };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  for (const slot of root.querySelectorAll('[data-mark-icon]')) {
    slot.replaceChildren(markSvg(Number(slot.dataset.markIcon)));
  }

  const cells = Array.from({ length: 16 }, (_, i) => {
    const button = el('button', 'cell');
    button.type = 'button';
    button.dataset.cell = String(i);
    boardEl.append(button);
    return button;
  });

  const isHumanTurn = () =>
    state.game !== null && !state.game.isOver && state.game.currentPlayer === state.humanPlayer;

  function cancelPending() {
    if (state.pendingTimer !== null) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
  }

  // ---------- rendering ----------

  function render({ manageFocus = true } = {}) {
    const { game, match, humanPlayer } = state;
    setupForm.hidden = game !== null;
    gameView.hidden = game === null;
    infoEl.hidden = game === null;
    const ghost = state.ghost;
    state.ghost = null; // shown on this render only
    if (game === null) {
      if (manageFocus) restoreFocus();
      return;
    }

    const { moveLimit } = VARIANTS[game.variant];
    const info = [VARIANT_NAMES[game.variant]];
    if (match) info.push(`Round ${match.round} of 3`);
    if (moveLimit !== null) info.push(`Moves left: ${moveLimit - game.moveCount}`);
    infoEl.textContent = info.join(' · ');

    playersEl.replaceChildren(...[1, 2, 3].map((p) => {
      const current = !game.isOver && game.currentPlayer === p;
      const item = el('li', `player player--${p}${current ? ' is-current' : ''}`,
        markSvg(p),
        el('span', 'sr-only', `${NAMES[p]}, `),
        el('span', 'player-name', p === humanPlayer ? 'You' : 'Computer'));
      if (match) {
        const score = match.scores[p - 1];
        item.append(el('span', 'player-score', el('span', 'sr-only', ', score '), String(score)));
      }
      item.append(el('span', 'player-tag', current ? 'to move' : ' '));
      if (current) item.setAttribute('aria-current', 'true');
      return item;
    }));

    const humanTurn = isHumanTurn();
    boardEl.classList.toggle('is-waiting', !game.isOver && !humanTurn);
    boardEl.classList.toggle('is-over', game.isOver);
    const winCells = new Set(game.winningLine ?? []);
    // Houdini: each player's oldest mark when they have 4; it vanishes on their next move.
    const fading = new Set(game.isOver ? [] : [1, 2, 3].map((p) => vanishingCell(game, p)).filter((c) => c !== null));
    cells.forEach((button, i) => {
      const value = game.board[i];
      let label = `row ${Math.floor(i / 4) + 1}, column ${(i % 4) + 1}, ${value ? NAMES[value] : 'empty'}`;
      if (fading.has(i)) label += ', vanishes next';
      button.setAttribute('aria-label', label);
      button.disabled = !(humanTurn && value === 0);
      button.className = 'cell';
      if (value) button.classList.add('is-filled');
      if (fading.has(i)) button.classList.add('is-vanishing');
      if (winCells.has(i)) button.classList.add('is-win', `win--${game.winner}`);
      const shown = button.firstElementChild;
      if (!value && ghost && ghost.cell === i) showGhost(button, ghost.player);
      else if (!value) button.replaceChildren();
      else if (!shown || shown.classList.contains('is-ghost') || !shown.classList.contains(`mark--${value}`)) {
        button.replaceChildren(markSvg(value));
      }
    });

    statusEl.replaceChildren(...statusContent());
    nextRoundBtn.hidden = !(match && match.roundOver && !match.isOver);
    if (manageFocus) restoreFocus();
  }

  /** The mark that just vanished, fading out in its (now empty) cell; removed when the animation ends. */
  function showGhost(button, player) {
    const svg = markSvg(player);
    svg.classList.add('is-ghost');
    svg.addEventListener('animationend', () => {
      if (svg.parentNode !== button) return;
      svg.remove();
      button.classList.remove('is-vanished');
    }, { once: true });
    button.classList.add('is-vanished');
    button.replaceChildren(svg);
  }

  function statusContent() {
    const { game, match, humanPlayer } = state;
    if (game.isOver) {
      const parts = game.winner
        ? [...markInline(game.winner), game.winner === humanPlayer ? ' wins — that’s you!' : ' wins!']
        : [VARIANTS[game.variant].moveLimit === null ? 'Draw — the board is full.' : `Draw: ${VARIANTS[game.variant].moveLimit} moves played`];
      if (match && match.isOver) parts.push(' ', el('span', 'match-result', ...matchResult()));
      return parts;
    }
    if (game.currentPlayer === humanPlayer) return ['Your turn: place a ', ...markInline(humanPlayer)];
    return ['Computer ', ...markInline(game.currentPlayer), ' is thinking…'];
  }

  function matchResult() {
    const { match, humanPlayer } = state;
    const winners = matchWinners(match);
    const score = match.scores.join('–');
    if (winners.length === 1) {
      const [w] = winners;
      return [`Match over (${score}): `, ...markInline(w),
        w === humanPlayer ? ' wins the match — you win!' : ' wins the match.'];
    }
    const shared = winners.flatMap((w, i) => [i ? ' and ' : '', ...markInline(w)]);
    return [`Match over (${score}): shared by `, ...shared, winners.includes(humanPlayer) ? ' — including you!' : '.'];
  }

  /** Keep keyboard play possible: if focus fell off a disabled/hidden control, put it somewhere useful. */
  function restoreFocus() {
    const active = document.activeElement;
    const lost = !active || active === document.body || active.disabled || active.closest('[hidden]');
    if (!lost) return;
    const { game } = state;
    let target = null;
    if (game === null) target = setupForm.querySelector('input[name="variant"]:checked');
    else if (game.isOver) target = nextRoundBtn.hidden ? newGameBtn : nextRoundBtn;
    else if (isHumanTurn()) target = cells.find((c) => !c.disabled);
    if (target) target.focus();
  }

  // ---------- turn loop ----------

  /** Play a move and remember a vanished mark so the next render can fade it out. */
  function playMove(cell) {
    const before = state.game;
    state.game = play(before, cell);
    if (state.game.vanished !== null && !reducedMotion.matches) {
      state.ghost = { cell: state.game.vanished, player: before.currentPlayer };
    }
  }

  function advance() {
    const { game } = state;
    if (game === null) return;
    if (game.isOver) {
      if (state.match && !state.match.roundOver) state.match = recordResult(state.match, game);
      render();
      return;
    }
    if (game.currentPlayer !== state.humanPlayer) {
      render();
      cancelPending();
      const expected = game;
      state.pendingTimer = setTimeout(() => {
        state.pendingTimer = null;
        if (state.game !== expected) return; // the game changed (New game) while we waited
        playMove(CHOOSE_MOVE[expected.variant](expected));
        advance();
      }, COMPUTER_DELAY_MS[game.variant]);
      return;
    }
    state.humanTurnAt = performance.now();
    render();
  }

  // ---------- events ----------

  // A Houdini computer move blocks the page for up to ~0.4 s. Clicks and key presses made
  // meanwhile are queued and only delivered once the cells are enabled for the human, so
  // they would play on a board the human has not seen. Ignore input older than the turn.
  // (event.timeStamp and performance.now() share the same clock.)
  const isStale = (event) => event.timeStamp < state.humanTurnAt;
  let staleGesture = false; // the press that started the current click came too early
  boardEl.addEventListener('pointerdown', (event) => { staleGesture = isStale(event); }, true);
  boardEl.addEventListener('keydown', (event) => {
    staleGesture = isStale(event);
    if (staleGesture && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  }, true);
  boardEl.addEventListener('keyup', (event) => {
    if (staleGesture && event.key === ' ') event.preventDefault();
  }, true);

  boardEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cell]');
    const stale = staleGesture || isStale(event);
    staleGesture = false;
    if (!button || !isHumanTurn() || stale) return;
    const cell = Number(button.dataset.cell);
    if (state.game.board[cell] !== 0) return;
    playMove(cell);
    advance();
  });

  setupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    cancelPending();
    const data = new FormData(setupForm);
    state.humanPlayer = Number(data.get('mark'));
    const variant = data.get('variant');
    state.ghost = null;
    state.match = data.get('mode') === 'match' ? newMatch(state.humanPlayer, variant) : null;
    state.game = state.match ? startRound(state.match) : newGame(1, variant);
    advance();
  });

  nextRoundBtn.addEventListener('click', () => {
    if (!state.match || !state.match.roundOver || state.match.isOver) return;
    cancelPending();
    state.ghost = null;
    state.match = nextRound(state.match);
    state.game = startRound(state.match);
    advance();
  });

  newGameBtn.addEventListener('click', () => {
    cancelPending();
    state.match = null;
    state.game = null;
    state.ghost = null;
    for (const button of cells) { // no ghost, fading or old mark survives
      button.className = 'cell';
      button.replaceChildren();
    }
    render();
  });

  render({ manageFocus: false });
}
