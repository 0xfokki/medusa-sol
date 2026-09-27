// Everything a wallet card shows, from one place. Prefers the stats already
// saved on the player's row (written by /api/player on connect) so rendering a
// card never burns a GMGN call for a known wallet; only a wallet the game has
// never seen gets a fresh lookup.
import { gmgnGet, parseWalletStats } from './gmgn.js';
import { walletGrade, WALLET_GRADES } from './score.js';
import { referralCodeFor } from './referrals.js';
import { walletTierFor, walletWeightUsd, topPctFor, nextTierFor, estimateWorthUsd, characterFor, ETH_FALLBACK_USD } from './worth.js';

export const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const ETH_PRICE_TTL_MS = 5 * 60 * 1000;
let ethCache = { usd: 0, at: 0 };

// The native coin here is SOL (the Robinhood build priced ETH through Alchemy). Coinbase's
// public spot price, cached five minutes; the last real figure, then a fallback, if it fails.
export async function getEthUsd() {
  if (ethCache.usd && Date.now() - ethCache.at < ETH_PRICE_TTL_MS) return ethCache.usd;
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(6000) });
    const usd = parseFloat((await r.json())?.data?.amount || '0');
    if (!(usd > 0)) throw new Error('no SOL price');
    ethCache = { usd, at: Date.now() };
    return usd;
  } catch {
    return ethCache.usd || ETH_FALLBACK_USD;
  }
}

export async function fetchWalletStats(address) {
  const p = parseWalletStats(await gmgnGet('/v1/user/wallet_stats', { chain: 'sol', wallet_address: address, period: 'all' }));
  return { ...p, twitter: p.twitterUsername };
}

async function readPlayerRow(address) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  try {
    const r = await fetch(
      `${base}/rest/v1/sol_medusa_players?wallet=eq.${address}&select=twitter,wallet_grade,wallet_balance_native,wallet_pnl_usd,wallet_roi_pct,wallet_winrate_pct,wallet_trades,wallet_buys,wallet_sells,wallet_tokens_traded,wallet_extra,wallet_analyzed_at,tier,score,referral_code`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) },
    );
    const rows = r.ok ? await r.json() : [];
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function getCardData(address) {
  const [row, ethUsd] = await Promise.all([readPlayerRow(address), getEthUsd()]);

  let stats;
  let source;
  if (row?.wallet_analyzed_at) {
    stats = {
      balanceNative: parseFloat(row.wallet_balance_native || 0),
      trades: row.wallet_trades || 0,
      buys: row.wallet_buys || 0,
      sells: row.wallet_sells || 0,
      realizedPnlUsd: parseFloat(row.wallet_pnl_usd || 0),
      roiPct: parseFloat(row.wallet_roi_pct || 0),
      winRatePct: parseFloat(row.wallet_winrate_pct || 0),
      twitter: row.twitter || null,
      extra: { tokens: row.wallet_tokens_traded || 0, ...(row.wallet_extra || {}) },
    };
    source = 'player';
  } else {
    stats = await fetchWalletStats(address);
    source = 'gmgn';
  }

  const grade = walletGrade(stats);
  const gradeLabel = WALLET_GRADES.find((g) => g.grade === grade.grade)?.label || 'No On-Chain History';
  const balanceUsd = stats.balanceNative * ethUsd;
  const worthUsd = estimateWorthUsd({ balanceUsd, pnlUsd: stats.realizedPnlUsd, grade: grade.grade });
  const extra = stats.extra || {};
  const ageDays = extra.firstSeen ? Math.max(0, Math.floor((Date.now() / 1000 - extra.firstSeen) / 86400)) : null;
  const character = characterFor({ ...stats, ...extra, pnlUsd: stats.realizedPnlUsd, balanceUsd, grade: grade.grade, ageDays });
  const weightUsd = walletWeightUsd({ balanceUsd, pnlUsd: stats.realizedPnlUsd });
  const next = nextTierFor(weightUsd);

  return {
    address,
    twitter: row?.twitter || stats.twitter || null,
    balanceNative: stats.balanceNative,
    balanceUsd,
    pnlUsd: stats.realizedPnlUsd,
    roiPct: stats.roiPct,
    winRatePct: stats.winRatePct,
    trades: stats.trades,
    buys: stats.buys,
    sells: stats.sells,
    grade: grade.grade,
    gradeLabel,
    weightUsd,
    tier: walletTierFor(weightUsd),
    character,
    extra,
    ageDays,
    topPct: topPctFor(weightUsd),
    nextTier: next ? next.name : null,
    nextNeedUsd: next ? next.needUsd : null,
    worthUsd,
    ethUsd,
    gameTier: row?.tier || null,
    gameScore: row?.score || 0,
    referralCode: row?.referral_code || referralCodeFor(address),
    source,
  };
}
