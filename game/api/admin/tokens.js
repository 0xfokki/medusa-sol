// Admin: the token pool. GET lists it, POST adds tokens (an array of
// {address, symbol, name, coin_glyph}), DELETE ?id= removes one. Password-gated
// via x-admin-password; writes go through service_role like every other write.
import { checkAuth } from '../_lib/auth.js';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

const clean = (v, max) => (v ?? '').toString().trim().slice(0, max);

export default async function handler(req, res) {
  if (!checkAuth(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const base = process.env.SUPABASE_URL;
  if (!base || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  const url = `${base}/rest/v1/sol_medusa_tokens`;

  try {
    if (req.method === 'GET') {
      const r = await fetch(`${url}?select=id,symbol,name,address,coin_glyph,created_at&order=created_at.desc`, { headers: supabaseHeaders() });
      res.status(r.status).json(await r.json());
      return;
    }

    if (req.method === 'POST') {
      const list = Array.isArray(req.body) ? req.body : [];
      const rows = [];
      for (const t of list.slice(0, 100)) {
        const address = clean(t?.address, 44);
        const symbol = clean(t?.symbol, 20);
        const name = clean(t?.name, 60) || symbol;
        const coin_glyph = clean(t?.coin_glyph, 4) || symbol.slice(0, 1).toUpperCase();
        if (!ADDR_RE.test(address) || !symbol) {
          res.status(400).json({ error: `Invalid token: ${address || '(no address)'}` });
          return;
        }
        rows.push({ address, symbol, name, coin_glyph });
      }
      if (!rows.length) {
        res.status(400).json({ error: 'Nothing to save' });
        return;
      }
      // Re-adding an address already in the pool is a no-op, not an error.
      const r = await fetch(`${url}?on_conflict=address`, {
        method: 'POST',
        headers: { ...supabaseHeaders(), Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(rows),
      });
      res.status(r.ok ? 200 : r.status).json(await r.json());
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query.id || '').toString();
      if (!UUID_RE.test(id)) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }
      const r = await fetch(`${url}?id=eq.${id}`, { method: 'DELETE', headers: { ...supabaseHeaders(), Prefer: 'return=representation' } });
      res.status(r.ok ? 200 : r.status).json(await r.json());
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(502).json({ error: 'Upstream request failed' });
  }
}
