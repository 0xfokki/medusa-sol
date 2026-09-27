// Analyze a Solana wallet via GMGN's wallet_stats (read-only, no private key).
import { gmgnGet, parseWalletStats } from './_lib/gmgn.js';
import { walletGrade } from './_lib/score.js';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const address = (req.query.address || '').toString().trim();
  if (!ADDR_RE.test(address)) {
    res.status(400).json({ error: 'Invalid address' });
    return;
  }

  try {
    const parsed = parseWalletStats(await gmgnGet('/v1/user/wallet_stats', { chain: 'sol', wallet_address: address, period: 'all' }));
    const result = { address, ...parsed };
    // the same grade table /api/player scores a wallet with, so the preview matches
    result.grade = walletGrade(result);
    result.bonus = result.grade.points;

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Wallet analysis failed' });
  }
}
