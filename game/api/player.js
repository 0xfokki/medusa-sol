// Upserts a player profile: analyzes their wallet via GMGN, combines it with their
// REAL in-game points (computed server-side from resolved sol_medusa_predictions —
// never trusted from the client) into a score/tier, and persists via service_role.
import { gmgnGet, parseWalletStats } from './_lib/gmgn.js';
import { walletGrade, tierFor, pointsForGrade } from './_lib/score.js';
import { computeLifetimeStats } from './_lib/points.js';
import { referralCodeFor, registerReferral, accrueReferralRoyalty } from './_lib/referrals.js';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REF_CODE_RE = /^[0-9a-f]{4,16}$/i;
const GMGN_REANALYZE_MS = 10 * 60 * 1000; // wallet trading stats don't change second to second

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

function normalizeTwitter(raw) {
  const t = (raw || '').toString().trim().replace(/^@/, '').slice(0, 60);
  return /^[A-Za-z0-9_]{1,15}$/.test(t) ? t : null;
}

// Does this handle actually belong to an account on X? publish.twitter.com's
// oembed endpoint answers without a key or a quota: 200 for a real profile,
// 404 for one that was never taken. Only a definitive 404 rejects a handle -
// a network hiccup or a rate limit must not lock a real player out of linking,
// so anything else is treated as "can't tell, let it through".
async function twitterHandleExists(handle) {
  try {
    const r = await fetch(`https://publish.twitter.com/oembed?url=https://twitter.com/${encodeURIComponent(handle)}`, {
      headers: { 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000),
    });
    return r.status !== 404;
  } catch {
    return true;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const base = process.env.SUPABASE_URL;
  if (!base || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  const headers = supabaseHeaders();

  const wallet = (req.body?.wallet || '').toString().trim();
  const requestedTwitter = normalizeTwitter(req.body?.twitter);
  const refCodeRaw = (req.body?.refCode || '').toString().trim();
  const refCode = REF_CODE_RE.test(refCodeRaw) ? refCodeRaw.toLowerCase() : null;

  if (!ADDR_RE.test(wallet)) {
    res.status(400).json({ error: 'Invalid wallet address' });
    return;
  }

  const [{ lifetimePoints, totalCalls, correctCalls }, existingRes] = await Promise.all([
    computeLifetimeStats(base, headers, wallet),
    fetch(`${base}/rest/v1/sol_medusa_players?wallet=eq.${wallet}&select=wallet_grade,referral_points,wallet_analyzed_at,twitter`, { headers }),
  ]);
  const existingRows = existingRes.ok ? await existingRes.json() : [];
  const existing = existingRows[0];
  const isFirstConnect = !existing;
  const previousGrade = existing?.wallet_grade || null;
  const knownReferralPoints = existing?.referral_points || 0;

  // A twitter handle can only ever belong to one wallet — check before writing,
  // not as an afterthought, so a taken handle never silently overwrites someone
  // else's or causes the whole upsert (incl. this wallet's real points) to fail.
  let twitter = existing?.twitter ?? null;
  let twitterRejected = false;
  let twitterMissing = false;
  if (requestedTwitter && requestedTwitter !== existing?.twitter) {
    const [claimRes, exists] = await Promise.all([
      fetch(`${base}/rest/v1/sol_medusa_players?wallet=neq.${wallet}&twitter=ilike.${encodeURIComponent(requestedTwitter)}&select=wallet`, { headers }),
      twitterHandleExists(requestedTwitter),
    ]);
    const claimRows = claimRes.ok ? await claimRes.json() : [];
    if (claimRows.length) twitterRejected = true;
    else if (!exists) twitterMissing = true;   // no such profile on X - never goes on the board
    else twitter = requestedTwitter;
  }

  // GMGN's wallet stats don't meaningfully change within minutes, and its free
  // tier is rate-limited — re-querying it on every settle-triggered analyze call
  // (potentially every few minutes per active player) wastes calls for nothing.
  // Skip the fresh lookup unless this is the wallet's first connect or its last
  // analysis has gone stale.
  const analyzedRecently = existing?.wallet_analyzed_at && (Date.now() - new Date(existing.wallet_analyzed_at).getTime()) < GMGN_REANALYZE_MS;
  let walletStats = null;
  let grade = null;
  if (analyzedRecently) {
    grade = { grade: previousGrade, label: null, points: pointsForGrade(previousGrade) };
  } else {
    try {
      walletStats = parseWalletStats(await gmgnGet('/v1/user/wallet_stats', { chain: 'sol', wallet_address: wallet, period: 'all' }));
      grade = walletGrade(walletStats);
    } catch {
      // GMGN lookup failing (rate limit, network, new/empty wallet) must NOT be
      // treated as "this wallet has no history" — that would wrongly downgrade
      // an already-graded wallet and even re-pop the credit popup at +0. Keep
      // whatever grade/points they already had until a real lookup succeeds.
      grade = { grade: previousGrade || 'NONE', label: null, points: pointsForGrade(previousGrade) };
    }
  }

  const score = lifetimePoints + grade.points + knownReferralPoints;
  const tier = tierFor(score);
  const gradeIsNew = walletStats !== null && grade.grade !== previousGrade;

  try {
    const body = {
      wallet, twitter,
      referral_code: referralCodeFor(wallet),
      lifetime_points: lifetimePoints,
      total_calls: totalCalls,
      correct_calls: correctCalls,
      wallet_grade: grade.grade,
      tier, score,
      updated_at: new Date().toISOString(),
    };
    if (walletStats) {
      Object.assign(body, {
        wallet_balance_native: walletStats.balanceNative,
        wallet_pnl_usd: walletStats.realizedPnlUsd,
        wallet_roi_pct: walletStats.roiPct,
        wallet_winrate_pct: walletStats.winRatePct,
        wallet_trades: walletStats.trades,
        wallet_buys: walletStats.buys,
        wallet_sells: walletStats.sells,
        wallet_tokens_traded: walletStats.extra.tokens,
        wallet_extra: walletStats.extra,
        wallet_analyzed_at: new Date().toISOString(),
      });
    }

    const r = await fetch(`${base}/rest/v1/sol_medusa_players?on_conflict=wallet`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify([body]),
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: data?.message || 'Save failed' });
      return;
    }

    let referred = false;
    if (isFirstConnect && refCode) {
      const refRes = await fetch(`${base}/rest/v1/sol_medusa_players?referral_code=eq.${refCode}&select=wallet`, { headers });
      const refRows = refRes.ok ? await refRes.json() : [];
      const referrer = refRows[0]?.wallet;
      if (referrer) referred = await registerReferral(base, headers, wallet, referrer);
    }
    // Top up whoever referred THIS wallet, now that its lifetime_points is fresh.
    await accrueReferralRoyalty(base, headers, wallet);

    res.status(200).json({ ...data[0], walletStats, walletGrade: grade, walletGradeIsNew: gradeIsNew, referred, twitterRejected, twitterMissing });
  } catch (err) {
    res.status(502).json({ error: 'Upstream request failed' });
  }
}
