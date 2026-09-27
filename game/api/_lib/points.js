// A wallet's real lifetime points/stats are always derived from resolved
// sol_medusa_predictions rows — never trusted from a client-supplied number.
export async function computeLifetimeStats(base, headers, wallet) {
  const r = await fetch(`${base}/rest/v1/sol_medusa_predictions?wallet=eq.${wallet}&select=status,points_awarded`, { headers });
  const preds = r.ok ? await r.json() : [];
  const lifetimePoints = preds.reduce((s, p) => s + (p.points_awarded || 0), 0);
  const resolved = preds.filter((p) => p.status !== 'pending');
  return {
    lifetimePoints,
    totalCalls: resolved.length,
    correctCalls: resolved.filter((p) => p.status === 'won').length,
  };
}
