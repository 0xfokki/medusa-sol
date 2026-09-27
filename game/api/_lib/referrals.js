// Referral registration + royalty accrual are both atomic Postgres functions
// (see migration add_referral_system) — this file just calls them via PostgREST
// RPC. Never do the read-modify-write in application code; that's exactly the
// race that would let points get double-credited.
export function referralCodeFor(wallet) {
  return wallet.replace(/^0x/, '').slice(0, 8);
}

export async function registerReferral(base, headers, referred, referrer) {
  if (!referrer) return false;
  try {
    const r = await fetch(`${base}/rest/v1/rpc/sol_register_referral`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_referred: referred, p_referrer: referrer }),
    });
    if (!r.ok) return false;
    return await r.json();
  } catch {
    return false;
  }
}

export async function accrueReferralRoyalty(base, headers, referred) {
  try {
    await fetch(`${base}/rest/v1/rpc/sol_accrue_referral_royalty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_referred: referred }),
    });
  } catch {}
}
