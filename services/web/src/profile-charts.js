// Profile charts (TanStack Charts), bundled to public/charts.js and loaded on demand.
import { areaY, barY, defineChart, lineY, ruleY } from '@tanstack/charts';
import { crosshair } from '@tanstack/charts/crosshair';
import { d3Curve } from '@tanstack/charts/d3/shape';
import { mountChart } from '@tanstack/charts/dom';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { tooltip } from '@tanstack/charts/tooltip';
import { scaleTime } from 'd3-scale';
import { curveStepAfter } from 'd3-shape';

// win/loss pair, validated for colour-blind separation and 3:1 contrast on the oak panel
const WIN = '#1a5f96';
const LOSS = '#a8401c';

const chips = (n) => Number(n).toLocaleString('en-US');
const signed = (n) => (n > 0 ? `+${chips(n)}` : n < 0 ? `−${chips(-n)}` : '0');
// Each tick at its own precision (like d3's multi-scale format), in local 24-hour time.
function tickLabel(date) {
  const clock = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (date.getMilliseconds()) return '';
  if (date.getSeconds()) return date.toLocaleTimeString(undefined, { ...clock, second: '2-digit' });
  if (date.getHours() || date.getMinutes()) return date.toLocaleTimeString(undefined, clock);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const KIND_LABELS = {
  welcome: 'Welcome bonus',
  purchase: 'Bought chips',
  'buy-in': 'Buy-in',
  'cash-out': 'Cash-out',
};

// Bank balance after every change, as a step line: it holds until the next change.
function balanceDefinition(timeline) {
  const rows = timeline.map((t, i) => ({ id: i, date: new Date(t.createdAt), ...t }));
  // carry the line on to "now" so the latest balance reads as current
  const last = rows.at(-1);
  if (last && Date.now() - last.createdAt > 60_000) {
    rows.push({ ...last, id: rows.length, date: new Date(), kind: 'now', amount: 0 });
  }
  const step = d3Curve(curveStepAfter);
  return defineChart({
    marks: [
      areaY(rows, { x: 'date', y: 'balance', fill: 'currentColor', fillOpacity: 0.1, curve: step }),
      lineY(rows, { x: 'date', y: 'balance', stroke: 'currentColor', strokeWidth: 2, curve: step }),
      crosshair({ x: true, y: false }),
    ],
    scales: {
      x: { scale: scaleTime, axis: { ticks: { spacing: 110, format: tickLabel } } },
      y: {
        scale: scaleLinear,
        nice: true,
        grid: true,
        axis: { ticks: { format: chips } },
      },
    },
    focus: 'nearest-x',
    maxFocusDistance: Number.POSITIVE_INFINITY,
    tooltip: {
      use: tooltip,
      className: 'chart-tooltip',
      format: ({ datum: d }) => (d.kind === 'now'
        ? `Now\n${chips(d.balance)} chips`
        : `${when(d.createdAt)}\n${chips(d.balance)} chips\n${KIND_LABELS[d.kind] || d.kind} ${signed(d.amount)}`),
    },
  });
}

// Net result of each money game, oldest first: wins above zero, losses below.
function gamesDefinition(games) {
  const rows = games.map((g, i) => ({ ...g, label: `#${i + 1}` }));
  return defineChart({
    marks: [
      barY(rows, {
        x: 'label',
        y: 'net',
        key: 'id',
        fill: (g) => (g.net >= 0 ? WIN : LOSS),
        radius: { end: 4 },
        inset: 1,
        maxThickness: 36,
      }),
      ruleY([0], { stroke: 'currentColor', strokeOpacity: 0.6 }),
    ],
    scales: {
      x: {
        scale: () => scaleBand().domain(rows.map((r) => r.label)).padding(0.2),
        axis: { label: 'Game', ticks: { spacing: 36 } },
      },
      y: {
        scale: scaleLinear,
        nice: true,
        grid: true,
        axis: { label: 'Chips won or lost', ticks: { format: signed } },
      },
    },
    tooltip: {
      use: tooltip,
      className: 'chart-tooltip',
      format: ({ datum: g }) => [
        `${g.tableName} · ${when(g.endedAt)}`,
        `${signed(g.net)} chips (${chips(g.buyIn)} in, ${chips(g.cashOut)} out)`,
        `${g.handsWon} of ${g.hands} hands won`,
      ].join('\n'),
    },
  });
}

// Running result of one game: chips won or lost since sitting down, after each hand.
function gameDefinition(hands) {
  let total = 0;
  const rows = hands.map((h) => {
    total += h.delta;
    return { ...h, total };
  });
  return defineChart({
    marks: [
      ruleY([0], { stroke: 'currentColor', strokeOpacity: 0.6 }),
      lineY(rows, { x: 'hand', y: 'total', stroke: WIN, strokeWidth: 2, points: rows.length <= 40 }),
      crosshair({ x: true, y: false }),
    ],
    scales: {
      x: {
        scale: scaleLinear,
        axis: { label: 'Hand', ticks: { spacing: 60, format: (n) => (Number.isInteger(n) ? `#${n}` : '') } },
      },
      y: {
        scale: scaleLinear,
        nice: true,
        grid: true,
        axis: { label: 'Chips won or lost', ticks: { format: signed } },
      },
    },
    focus: 'nearest-x',
    maxFocusDistance: Number.POSITIVE_INFINITY,
    tooltip: {
      use: tooltip,
      className: 'chart-tooltip',
      format: ({ datum: h }) => `Hand #${h.hand}\n${signed(h.delta)} this hand\n${signed(h.total)} so far`,
    },
  });
}

export function mountGameChart(el, hands) {
  if (!hands.length) return () => {};
  const host = mountChart(el, {
    definition: gameDefinition(hands),
    height: 240,
    idPrefix: 'game-',
    ariaLabel: 'Chips won or lost, hand by hand',
  });
  return () => host.destroy();
}

/**
 * Mounts both charts; returns a function that destroys them.
 * `games` are the player's money games, oldest first.
 */
export function mountProfileCharts({ balanceEl, gamesEl, timeline, games }) {
  const hosts = [];
  if (timeline.length > 1) {
    hosts.push(mountChart(balanceEl, {
      definition: balanceDefinition(timeline),
      height: 260,
      idPrefix: 'balance-',
      ariaLabel: 'Bank balance over time',
    }));
  }
  if (games.length) {
    hosts.push(mountChart(gamesEl, {
      definition: gamesDefinition(games),
      height: 260,
      idPrefix: 'games-',
      ariaLabel: 'Chips won or lost in each money game',
    }));
  }
  return () => hosts.forEach((h) => h.destroy());
}
