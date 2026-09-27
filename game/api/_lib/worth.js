// The wallet card's numbers. One rule: the fatter the wallet, the bigger the
// figure, and a good trading record multiplies it. Everything tunable sits in
// the three tables below so the card copy can quote them verbatim.

// The wallet's WEIGHT: what it holds plus half of what it has realised in profit.
// Losses never subtract - a losing wallet is just its balance.
export const PNL_WEIGHT = 0.5;
export function walletWeightUsd({ balanceUsd = 0, pnlUsd = 0 }) {
  return Math.max(0, balanceUsd) + PNL_WEIGHT * Math.max(0, pnlUsd);
}

// Marine ladder by weight, with MEDUSA's own "Top X%" anchored at each threshold.
// Between two thresholds the percent slides on a log scale, so two whales never
// read the same and every extra dollar moves the number. Owner-set, 2026-09-23:
// thresholds low enough that the top tiers are reachable.
export const WALLET_TIERS = [
  { name: 'BACTERIA', min: 0, top: 100 },
  { name: 'PLANKTON', min: 5, top: 85 },
  { name: 'SHRIMP', min: 50, top: 65 },
  { name: 'FISH', min: 500, top: 40 },
  { name: 'DOLPHIN', min: 2500, top: 18 },
  { name: 'SHARK', min: 8000, top: 8 },
  { name: 'WHALE', min: 25000, top: 3 },
  { name: 'MEGALODON', min: 100000, top: 1 },
];

export function topPctFor(weightUsd) {
  const w = Math.max(0, weightUsd);
  const t = WALLET_TIERS;
  if (w >= t[t.length - 1].min) return 1;
  let i = 0;
  while (i + 1 < t.length && w >= t[i + 1].min) i++;
  const lo = t[i], hi = t[i + 1];
  // log interpolation inside the band (linear inside the first, which starts at 0)
  const f = lo.min > 0 ? Math.log(w / lo.min) / Math.log(hi.min / lo.min) : w / hi.min;
  const pct = lo.top + (hi.top - lo.top) * Math.min(1, Math.max(0, f));
  return Math.min(100, Math.max(1, Math.round(pct)));
}

// The next rung and how many dollars of weight it takes to get there.
export function nextTierFor(weightUsd) {
  const w = Math.max(0, weightUsd);
  const next = WALLET_TIERS.find((t) => t.min > w);
  return next ? { name: next.name, needUsd: next.min - w } : null;
}

// Trader grade (score.js WALLET_GRADES) -> multiplier on the estimate.
export const GRADE_MULT = { NONE: 1, NEW: 1.15, ACTIVE: 1.3, PROFITABLE: 1.6, SHARP: 2, ELITE: 3 };

// estimate = (base + balance * perBalanceUsd + max(pnl, 0) * perPnlUsd) * gradeMult
export const WORTH = { baseUsd: 5, perBalanceUsd: 0.1, perPnlUsd: 0.03 };

// Native coin on Solana is SOL. Used only when the price lookup fails
// and nothing is cached yet; a stale-but-real figure beats a zero on a card.
export const ETH_FALLBACK_USD = 120; // SOL, Coinbase spot on 2026-09-27

// Second axis: how the wallet BEHAVES. Checked top to bottom, first match wins.
// This is the badge people post - it is about identity, not size.
// Inputs: GMGN wallet_stats (see parseWalletStats) plus grade, balanceUsd, ageDays.
const DAY = 86400;
const SMART_TAGS = ['smart_degen', 'pump_smart', 'smart_money', 'renowned'];
export const CHARACTERS = [
  { name: 'KOL', test: (s) => s.tags.includes('kol') || s.twitterFans >= 10000 },
  { name: 'SMART MONEY', test: (s) => s.tags.some((t) => SMART_TAGS.includes(t)) },
  { name: 'DEV', test: (s) => s.createdTokens > 0 },
  { name: 'GHOST', test: (s) => s.trades === 0 && s.balanceUsd < 10 },
  { name: 'TOURIST', test: (s) => s.trades === 0 || (s.ageDays !== null && s.ageDays < 3 && s.trades <= 2) },
  { name: 'INSIDER', test: (s) => s.grade === 'ELITE' },
  { name: 'SNIPER', test: (s) => s.tags.includes('snipe_bot') || s.tags.includes('sniper') || s.grade === 'SHARP' },
  { name: 'MOONBOY', test: (s) => s.x5 >= 2 },
  { name: 'DIAMOND', test: (s) => s.trades >= 5 && s.holdSec >= 7 * DAY },
  { name: 'PAPER HANDS', test: (s) => s.trades >= 5 && ((s.holdSec > 0 && s.holdSec < 3600) || s.winRatePct < 35) },
  { name: 'DEGEN', test: (s) => s.trades >= 20 && s.pnlUsd < 0 },
  { name: 'UP ONLY', test: (s) => s.pnlUsd > 0 },
  { name: 'TRADER', test: () => true },
];

export function characterFor(stats) {
  const s = {
    trades: 0, buys: 0, sells: 0, pnlUsd: 0, winRatePct: 0, balanceUsd: 0, grade: 'NONE',
    tags: [], twitterFans: 0, createdTokens: 0, x5: 0, holdSec: 0, ageDays: null,
    ...stats,
  };
  if (!Array.isArray(s.tags)) s.tags = [];
  return CHARACTERS.find((c) => c.test(s)).name;
}

// 45m / 6h / 12d
export function fmtDuration(sec) {
  if (!(sec > 0)) return null;
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < DAY) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / DAY)}d`;
}

export function walletTierFor(weightUsd) {
  let tier = WALLET_TIERS[0];
  for (const t of WALLET_TIERS) if (weightUsd >= t.min) tier = t;
  return tier.name;
}

export function estimateWorthUsd({ balanceUsd = 0, pnlUsd = 0, grade = 'NONE' }) {
  const mult = GRADE_MULT[grade] ?? 1;
  const raw = (WORTH.baseUsd + balanceUsd * WORTH.perBalanceUsd + Math.max(pnlUsd, 0) * WORTH.perPnlUsd) * mult;
  return Math.max(0, Math.round(raw));
}

// $4 / $189 / $27.2k / $622k / $4.85M - three significant figures like a price tag.
export function fmtUsd(n, { sign = false } = {}) {
  const neg = n < 0;
  const v = Math.abs(n);
  let body;
  if (v >= 1e9) body = `${Number((v / 1e9).toPrecision(3))}B`;
  else if (v >= 1e6) body = `${Number((v / 1e6).toPrecision(3))}M`;
  else if (v >= 1e3) body = `${Number((v / 1e3).toPrecision(3))}k`;
  else body = `${Math.round(v)}`;
  const prefix = neg ? '-' : sign && v > 0 ? '+' : '';
  return `${prefix}$${body}`;
}

export function fmtNative(n) {
  if (n >= 100) return `${Math.round(n)} SOL`;
  if (n >= 1) return `${Number(n.toPrecision(3))} SOL`;
  if (n > 0) return `${Number(n.toFixed(3))} SOL`;
  return '0 SOL';
}

export function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
