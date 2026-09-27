// Server-authoritative jellyfish round state — every visitor reads the SAME 6
// slots (same token, same start/end time). Rolled over lazily on read (no cron):
// whichever request notices a slot expired performs the rollover for everyone.
//
// Price discipline: a token's price is fetched exactly twice per round — once
// when it's picked (birth) and once when its round expires (death). Never polled
// in between. Death-price + birth-price already stored on each prediction is all
// that's needed to resolve every player's call in one shot, server-side.
import { fetchPricesByAddress } from './_lib/prices.js';
import { computeLifetimeStats } from './_lib/points.js';
import { tierFor, pointsForGrade } from './_lib/score.js';
import { accrueReferralRoyalty } from './_lib/referrals.js';
import { randomUUID } from 'node:crypto';

const SLOT_COUNT = 6;
const ROUND_DURATION_MS = 3600 * 1000;
const STAGGER_MS = ROUND_DURATION_MS / SLOT_COUNT;

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function resolveRoundPredictions(base, headers, roundId, finalPrice) {
  const r = await fetch(`${base}/rest/v1/sol_medusa_predictions?round_id=eq.${roundId}&status=eq.pending&select=id,wallet,direction,points,start_price`, { headers });
  const preds = r.ok ? await r.json() : [];
  if (!preds.length) return;

  await Promise.all(preds.map(async (p) => {
    const won = p.direction === 'up' ? finalPrice >= p.start_price : finalPrice <= p.start_price;
    await fetch(`${base}/rest/v1/sol_medusa_predictions?id=eq.${p.id}&status=eq.pending`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        final_price: finalPrice,
        status: won ? 'won' : 'lost',
        points_awarded: won ? p.points : 0,
        resolved_at: new Date().toISOString(),
      }),
    });
  }));

  const wallets = [...new Set(preds.map((p) => p.wallet))];
  await Promise.all(wallets.map((w) => refreshPlayerPoints(base, headers, w)));
}

async function refreshPlayerPoints(base, headers, wallet) {
  const existingRes = await fetch(`${base}/rest/v1/sol_medusa_players?wallet=eq.${wallet}&select=lifetime_points,referral_points,wallet_grade`, { headers });
  const existingRows = existingRes.ok ? await existingRes.json() : [];
  const existing = existingRows[0];
  if (!existing) return; // they never connected — nothing to keep in sync yet
  const { lifetimePoints, totalCalls, correctCalls } = await computeLifetimeStats(base, headers, wallet);
  // Grade bonus isn't re-derived here (that needs a fresh GMGN call, done on connect/
  // analyze) — carry forward whatever grade points were already stored, so a round
  // resolving doesn't wipe the wallet's on-chain-status bonus.
  const gradeBonus = pointsForGrade(existing.wallet_grade);
  const score = lifetimePoints + gradeBonus + (existing.referral_points || 0);
  await fetch(`${base}/rest/v1/sol_medusa_players?wallet=eq.${wallet}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      lifetime_points: lifetimePoints, total_calls: totalCalls, correct_calls: correctCalls,
      score, tier: tierFor(score), updated_at: new Date().toISOString(),
    }),
  });
  // Top up whoever referred this wallet, now that its lifetime_points is fresh.
  await accrueReferralRoyalty(base, headers, wallet);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const base = process.env.SUPABASE_URL;
  if (!base || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  const headers = supabaseHeaders();
  const roundsUrl = `${base}/rest/v1/sol_medusa_rounds`;

  try {
    const roundsRes = await fetch(`${roundsUrl}?select=*`, { headers });
    const existingRows = roundsRes.ok ? await roundsRes.json() : [];

    const now = Date.now();
    const bySlot = new Map(existingRows.map((r) => [r.slot, r]));
    const stillAlive = existingRows.filter((r) => new Date(r.ends_at).getTime() > now);
    const occupiedSymbols = new Set(stillAlive.map((r) => r.symbol));

    const needsRollover = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const row = bySlot.get(slot);
      if (!row || new Date(row.ends_at).getTime() <= now) needsRollover.push(slot);
    }

    // Fast path: nothing expired, skip the token-pool read entirely — this is
    // the overwhelming majority of requests under normal polling load.
    let tokenPool = [];
    if (needsRollover.length) {
      const tokensRes = await fetch(`${base}/rest/v1/sol_medusa_tokens?select=*`, { headers });
      tokenPool = tokensRes.ok ? await tokensRes.json() : [];
    }

    // Claim before doing any expensive work. Under concurrent load, many
    // simultaneous requests can notice the same expired slot at once — without
    // this, every one of them would fire an Alchemy price lookup before only one
    // wins the final write. The claim is a cheap atomic CAS; only its winner
    // proceeds, everyone else just sees "still alive" and moves on.
    const claimedSlots = [];
    await Promise.all(needsRollover.map(async (slot) => {
      const existing = bySlot.get(slot);
      if (!existing) { claimedSlots.push(slot); return; } // first-ever seed — no prior row to race over
      try {
        const r = await fetch(`${base}/rest/v1/rpc/sol_claim_round_rollover`, {
          method: 'POST', headers,
          body: JSON.stringify({ p_slot: slot, p_expected_ends_at: existing.ends_at }),
        });
        if (!r.ok) return;
        const claimedEndsAt = await r.json();
        if (claimedEndsAt) {
          bySlot.set(slot, { ...existing, ends_at: claimedEndsAt });
          claimedSlots.push(slot);
        }
      } catch {}
    }));

    if (claimedSlots.length && tokenPool.length) {
      const usedThisPass = new Set(occupiedSymbols);
      const picks = claimedSlots.map((slot) => {
        let candidates = tokenPool.filter((t) => !usedThisPass.has(t.symbol));
        if (!candidates.length) candidates = tokenPool;
        const t = candidates[Math.floor(Math.random() * candidates.length)];
        usedThisPass.add(t.symbol);
        return { slot, token: t };
      });

      // One combined price fetch for every new pick AND every dying token —
      // this is the only place prices get requested (birth of the new + death of the old).
      const newAddresses = picks.map((p) => p.token.address);
      const dyingAddresses = claimedSlots
        .map((slot) => bySlot.get(slot))
        .filter((row) => row && row.address)
        .map((row) => row.address);
      const addresses = [...new Set([...newAddresses, ...dyingAddresses])];
      let prices = {};
      try { prices = await fetchPricesByAddress(addresses); } catch {}

      await Promise.all(picks.map(async ({ slot, token }) => {
        const address = token.address;
        const price = prices[address];
        if (price === undefined) return; // couldn't price it — leave slot as-is for this pass
        const existing = bySlot.get(slot);
        const isFirstSeed = !existing && existingRows.length === 0;
        const startedAt = isFirstSeed ? new Date(now - slot * STAGGER_MS) : new Date(now);
        const endsAt = isFirstSeed ? new Date(now - slot * STAGGER_MS + ROUND_DURATION_MS) : new Date(now + ROUND_DURATION_MS);
        const body = {
          slot, symbol: token.symbol, name: token.name, coin_glyph: token.coin_glyph,
          address, start_price: price, started_at: startedAt.toISOString(), ends_at: endsAt.toISOString(),
        };

        if (existing) {
          // Compare-and-swap: only apply if nobody else already rolled this slot over.
          const r = await fetch(`${roundsUrl}?slot=eq.${slot}&ends_at=eq.${encodeURIComponent(existing.ends_at)}`, {
            method: 'PATCH',
            headers: { ...headers, Prefer: 'return=representation' },
            body: JSON.stringify({ ...body, round_id: randomUUID() }),
          });
          if (r.ok) {
            const data = await r.json();
            if (data[0]) {
              bySlot.set(slot, data[0]);
              // We won the CAS race, so we're the one responsible for settling the round we just replaced.
              const dyingPrice = existing.address ? prices[existing.address] : undefined;
              // Awaited (not fire-and-forget): Vercel can freeze the function right
              // after the response is sent, which would kill an unawaited promise.
              if (dyingPrice !== undefined) await resolveRoundPredictions(base, headers, existing.round_id, dyingPrice).catch(() => {});
            }
          }
        } else {
          const r = await fetch(`${roundsUrl}?on_conflict=slot`, {
            method: 'POST',
            headers: { ...headers, Prefer: 'return=representation,resolution=ignore-duplicates' },
            body: JSON.stringify([{ ...body, round_id: randomUUID() }]),
          });
          if (r.ok) {
            const data = await r.json();
            if (data[0]) bySlot.set(slot, data[0]);
          }
        }
      }));
    }

    // Fast path (nothing expired): existingRows is already the full, current
    // state — no need for a second read. Only re-read when rollover actually ran,
    // since a lost CAS race means bySlot may not reflect the latest committed row.
    let finalRows;
    if (!needsRollover.length) {
      finalRows = existingRows.sort((a, b) => a.slot - b.slot);
    } else {
      const finalRes = await fetch(`${roundsUrl}?select=*&order=slot.asc`, { headers });
      finalRows = finalRes.ok ? await finalRes.json() : [...bySlot.values()].sort((a, b) => a.slot - b.slot);
    }

    res.setHeader('Cache-Control', 's-maxage=3, stale-while-revalidate=10');
    res.status(200).json(finalRows);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Upstream request failed' });
  }
}
