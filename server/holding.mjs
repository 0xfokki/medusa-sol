// Who holds enough $MEDUSA to sit down: the wallet's SPL balance of the mint, priced by the
// deepest DexScreener pool, against two lines - one to enter, a lower one to stay, so a
// launch-day candle does not throw people out and back in.
//
// The token lives in <dataDir>/agent-token.json:
//   { "address": "<mint>", "symbol": "MEDUSA", "minUsd": 10, "keepUsd": 10 }
// With no address the gate is off and only the allow list seats anyone. The file is
// re-read every minute, so launch day is: write the mint, done.
// "native": true gates on SOL itself instead (a stand-in before the token exists).

import { readFileSync } from "fs";
import { join } from "path";
import { CHAIN } from "../scripts/chains.mjs";
import { splBalance, solBalance, solPriceUsd, isAddress } from "../scripts/solana.mjs";

export function holdingGate({ dataDir }) {
  const FILE = join(dataDir, "agent-token.json");
  let cfg = { at: 0, token: null };
  function token() {
    if (Date.now() - cfg.at < 60_000) return cfg.token;
    let t = null;
    try {
      const j = JSON.parse(readFileSync(FILE, "utf8"));
      if (j.native) t = { native: true, address: null, minUsd: Number(j.minUsd ?? 10), keepUsd: Number(j.keepUsd ?? 7), symbol: j.symbol || "SOL" };
      else if (isAddress(j.address || "")) t = { address: j.address, minUsd: Number(j.minUsd ?? 10), keepUsd: Number(j.keepUsd ?? 7), symbol: j.symbol || "MEDUSA",
        // "priceUsd": a hand-set price for the hours before DexScreener quotes the curve; remove it once it does
        priceUsd: Number(j.priceUsd) > 0 ? Number(j.priceUsd) : null };
    } catch { /* no file, no gate */ }
    cfg = { at: Date.now(), token: t };
    return t;
  }

  // the price: the deepest pool on DexScreener (a bonding curve counts by market cap),
  // refreshed every minute, the last one kept for an hour if DexScreener is down
  let price = { at: 0, usd: null, url: null };
  async function priceOf(address) {
    if (Date.now() - price.at < 60_000 && price.usd != null) return price;
    try {
      if (!address) {
        const usd = await solPriceUsd();
        if (usd > 0) { price = { at: Date.now(), usd, url: null }; return price; }
      } else {
        const r = await fetch("https://api.dexscreener.com/tokens/v1/" + CHAIN.dexscreener + "/" + address, { headers: { accept: "application/json" } });
        const pairs = r.ok ? await r.json() : [];
        const depth = p => (p.liquidity?.usd || 0) || (p.marketCap || 0) / 1e6;
        const best = (Array.isArray(pairs) ? pairs : []).filter(p => p.chainId === CHAIN.dexscreener && p.priceUsd).sort((a, b) => depth(b) - depth(a))[0];
        if (best) { price = { at: Date.now(), usd: Number(best.priceUsd), url: best.url }; return price; }
      }
    } catch { /* fall through to the last known */ }
    if (price.usd != null && Date.now() - price.at < 3_600_000) return price;
    return { at: Date.now(), usd: null, url: price.url };
  }

  const balances = new Map();                       // wallet -> { at, balance }
  // a read asks the chain afresh every time (selling and reading in the same minute is the
  // obvious move); the small requests around it live on a two-minute cache
  async function balanceOf(address, wallet, fresh) {
    const hit = balances.get(wallet);
    if (!fresh && hit && Date.now() - hit.at < 2 * 60_000) return hit.balance;
    const balance = address ? (await splBalance(address, wallet)).amount : await solBalance(wallet);
    balances.set(wallet, { at: Date.now(), balance });
    return balance;
  }

  // { ok, usd, balance, price, need, symbol, buy } - or null when the gate is off
  return async function holding(wallet, { entering = false, fresh = false } = {}) {
    const t = token();
    if (!t) return null;
    const need = entering ? t.minUsd : t.keepUsd;
    try {
      const [balance, p] = await Promise.all([balanceOf(t.address, wallet, fresh || entering), t.priceUsd ? { usd: t.priceUsd, url: null } : priceOf(t.address)]);
      if (p.usd == null) return { ok: false, usd: null, balance, price: null, need, symbol: t.symbol, buy: p.url, reason: "the price could not be read" };
      const usd = balance * p.usd;
      return { ok: usd >= need, usd: +usd.toFixed(2), balance, price: p.usd, need, symbol: t.symbol, buy: p.url };
    } catch (e) {
      return { ok: false, usd: null, balance: null, price: null, need, symbol: t.symbol, buy: null, reason: "the chain did not answer: " + e.message.slice(0, 60) };
    }
  };
}
