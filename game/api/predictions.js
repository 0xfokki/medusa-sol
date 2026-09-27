// Creates a prediction on a live round. Writes go through service_role (RLS only
// allows public reads); results are settled by rounds.js, never by the client.
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL;
  if (!base || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  const url = `${base}/rest/v1/sol_medusa_predictions`;

  try {
    if (req.method === 'POST') {
      const wallet = (req.body?.wallet || '').toString().trim();
      const direction = req.body?.direction === 'down' ? 'down' : req.body?.direction === 'up' ? 'up' : null;
      const points = Math.max(0, Math.min(1000, Math.floor(Number(req.body?.points) || 0)));
      const roundIdRaw = (req.body?.roundId || '').toString();
      const roundId = UUID_RE.test(roundIdRaw) ? roundIdRaw : null;
      if (!WALLET_RE.test(wallet) || !direction || !roundId) {
        res.status(400).json({ error: 'Invalid prediction payload' });
        return;
      }
      // A prediction is only ever on a live round, and the token and its start price
      // come from that round's row - never from the request. Before this, a client could
      // post any symbol with any start price and no round at all, then close it itself.
      const roundRes = await fetch(`${base}/rest/v1/sol_medusa_rounds?round_id=eq.${roundId}&select=symbol,start_price,ends_at`, { headers: supabaseHeaders() });
      const round = roundRes.ok ? (await roundRes.json())[0] : null;
      if (!round || new Date(round.ends_at).getTime() <= Date.now()) {
        res.status(409).json({ error: 'This round is over' });
        return;
      }
      const r = await fetch(url, {
        method: 'POST',
        headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
        body: JSON.stringify([{ wallet, symbol: round.symbol, direction, points, start_price: round.start_price, round_id: roundId }]),
      });
      const data = await r.json();
      if (!r.ok && r.status === 409) {
        // Already predicted this exact round (e.g. a page reload raced the same
        // call) - the unique (wallet, round_id) index caught it. Hand back the
        // existing row instead of erroring, so the client can restore its local
        // "already called" state rather than silently failing.
        const existingRes = await fetch(`${url}?wallet=eq.${wallet}&round_id=eq.${roundId}&select=*`, { headers: supabaseHeaders() });
        const existingRows = existingRes.ok ? await existingRes.json() : [];
        if (existingRows[0]) {
          res.status(200).json({ ...existingRows[0], alreadyPredicted: true });
          return;
        }
      }
      res.status(r.status).json(data?.[0] || data);
      return;
    }

    // There is no client-side resolve: rounds.js settles every prediction on a round
    // with the price it fetches itself when the round ends. The old PATCH here took
    // the final price from the request, which let anyone mark their own call a win.

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(502).json({ error: 'Upstream request failed' });
  }
}
