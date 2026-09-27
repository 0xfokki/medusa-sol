// MEDUSA status ladder. In-game lifetime points are the primary driver (guaranteed
// data for every player); on-chain wallet performance grants a one-off starting
// bonus on top, never a penalty — a wallet with no/losing trades just gets the
// lowest grade (+0), it never drags points down.
export const TIERS = [
  { name: 'BACTERIA', min: 0 },
  { name: 'PLANKTON', min: 200 },
  { name: 'SHRIMP', min: 600 },
  { name: 'FISH', min: 1500 },
  { name: 'DOLPHIN', min: 4000 },
  { name: 'SHARK', min: 8000 },
  { name: 'WHALE', min: 15000 },
  { name: 'MEGALODON', min: 30000 },
];

// On-chain trader grade → one-off starting points, checked top to bottom (first
// match wins). Kept as a flat table rather than a formula specifically so it can
// be shown to the player verbatim ("Sharp Trader → +900 pts") in the credit popup.
export const WALLET_GRADES = [
  { grade: 'ELITE', label: 'Elite Trader', points: 2000, test: (s) => s.trades >= 25 && s.roiPct >= 50 && s.winRatePct >= 60 },
  { grade: 'SHARP', label: 'Sharp Trader', points: 900, test: (s) => s.trades >= 10 && s.roiPct >= 20 && s.winRatePct >= 50 },
  { grade: 'PROFITABLE', label: 'Profitable Trader', points: 400, test: (s) => s.trades >= 5 && s.roiPct > 0 },
  { grade: 'ACTIVE', label: 'Active Trader', points: 150, test: (s) => s.trades >= 5 },
  { grade: 'NEW', label: 'New Trader', points: 50, test: (s) => s.trades >= 1 },
  { grade: 'NONE', label: 'No On-Chain History', points: 0, test: () => true },
];

export function walletGrade(stats) {
  const s = { trades: 0, roiPct: 0, winRatePct: 0, ...stats };
  const entry = WALLET_GRADES.find((g) => g.test(s));
  return { grade: entry.grade, label: entry.label, points: entry.points };
}

export function pointsForGrade(gradeCode) {
  return WALLET_GRADES.find((g) => g.grade === gradeCode)?.points || 0;
}

export function tierFor(score) {
  let tier = TIERS[0];
  for (const t of TIERS) if (score >= t.min) tier = t;
  return tier.name;
}
