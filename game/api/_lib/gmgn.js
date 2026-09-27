// Thin client for GMGN's OpenAPI "exist-auth" routes (read-only wallet stats).
// No private key involved — only X-APIKEY + timestamp + client_id (replay-protected).
import { randomUUID } from 'node:crypto';

const HOST = 'https://openapi.gmgn.ai';

// Everything /v1/user/wallet_stats tells us about a wallet, in one shape.
// `extra` is what the card's behaviour badges read; it is stored as jsonb on
// sol_medusa_players so a card never needs a second GMGN call.
export function parseWalletStats(stats) {
  const buys = stats.buy || 0;
  const sells = stats.sell || 0;
  const totalCost = parseFloat(stats.total_cost || '0');
  const realizedPnlUsd = parseFloat(stats.realized_profit || '0');
  const ps = stats.pnl_stat || {};
  const c = stats.common || {};
  return {
    balanceNative: parseFloat(stats.native_balance || '0'),
    trades: buys + sells,
    buys,
    sells,
    realizedPnlUsd,
    roiPct: totalCost > 0 ? (realizedPnlUsd / totalCost) * 100 : 0,
    winRatePct: (ps.winrate || 0) * 100,
    twitterUsername: c.twitter_username || null,
    extra: {
      tokens: ps.token_num || 0,
      holdSec: Math.round(ps.avg_holding_period || 0),
      x5: ps.pnl_gt_5x_num || 0,
      x2: ps.pnl_2x_5x_num || 0,
      x0: ps.pnl_0x_2x_num || 0,
      loss: ps.pnl_lt_nd5_num || 0,
      tags: Array.isArray(c.tags) ? c.tags : [],
      tag: c.tag || '',
      ens: c.ens || '',
      firstSeen: c.fund_from_ts || c.created_at || 0,
      fundFrom: c.fund_from || '',
      lastTrade: stats.last_timestamp || 0,
      createdTokens: c.created_token_count || 0,
      twitterFans: c.twitter_fans_num || 0,
    },
  };
}

export async function gmgnGet(subPath, query) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) throw new Error('GMGN not configured');
  const params = new URLSearchParams({
    ...query,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    client_id: randomUUID(),
  });
  const r = await fetch(`${HOST}${subPath}?${params.toString()}`, {
    headers: { 'X-APIKEY': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'medusa-jellyfish/1.0' },
  });
  const data = await r.json();
  if (!r.ok || data.code !== 0) throw new Error(data?.message || data?.reason || `GMGN request failed (${r.status})`);
  return data.data;
}
