// What pump.fun traded in the last hour — read off Solana itself, through Helius.
//
//   node scripts/read-chain.mjs [minutes] [universe limit]
//
// Every coin still on its bonding curve trades against one account (the curve; DexScreener
// lists it as the pair address). So the scan is per coin: the curve's recent signatures,
// the successful ones parsed, and what each wallet ended up with, net, in each transaction.
//
// What the raw transfers are not:
//   · a swap is several transfers, and a bot can enter and leave inside one transaction.
//     A fill is what one wallet ended up with in one transaction; net to nothing and it was
//     nobody's trade.
//   · programs' accounts (routers, vaults) receive coins on the way through and would count
//     as buyers. Accounts not owned by the System Program are dropped; only wallets count.
//   · a wallet that buys and sells the same size within the hour was working the spread;
//     one half of the round trip is shown at most.
//
// Helius meters every call, so the parsed transactions live in .sol-cache.json for a day
// and each pass only pays for what is new (scripts/solana.mjs). CHAIN.sigCap bounds a hot
// coin: past it the row covers the last `cap` trades and says how many minutes that was.

import { readFileSync, writeFileSync } from "fs";
import { CHAIN } from "./chains.mjs";
import { tradesOf, walletKinds, loadCache, saveCache, rpc, isAddress } from "./solana.mjs";

const OUT = new URL("../chain-live.js", import.meta.url);
const CACHE = new URL("../.sol-cache.json", import.meta.url);
const MINUTES = Number(process.argv[2] || 60);
const LIMIT = Number(process.argv[3] || process.env.SOL_UNIVERSE || 15);
const QUOTE = new Set(CHAIN.quote.map(s => s.toLowerCase()));

/* ---------- 1. the fills ---------- */
const head = await rpc("getSlot", []);
console.log(`slot ${head} · reading ${MINUTES} min per coin, up to ${CHAIN.sigCap} signatures each`);

const READ = JSON.parse(readFileSync(new URL("../chain-data.js", import.meta.url), "utf8")
  .replace(/^[\s\S]*?window\.CHAIN_READ\s*=\s*/, "").replace(/;\s*$/, ""));
const BOARD = (READ.universe ?? READ.tokens).slice(0, LIMIT);
// The watchlist: the ten trending at the last pull, in its order. Always walked and always
// written, traded this hour or not, so every block on the page shows the same ten.
const WATCH = (READ.trending || []).filter(t => isAddress(t.address));
const WATCH_IDX = new Map(WATCH.map((t, i) => [t.address, i]));
for (const w of WATCH) if (!BOARD.some(b => b.address === w.address)) BOARD.push(w);
console.log(`walking ${BOARD.length} coins (${WATCH.length} on the watchlist)`);

const cache = loadCache(CACHE);
const net = new Map();                       // token|sig|wallet -> signed amount
const add = (k, v) => net.set(k, (net.get(k) ?? 0) + v);
const covered = new Map();                   // token -> minutes the read actually spans
let calls = 0, parsed = 0, failed = 0;
for (const token of BOARD) {
  if (!isAddress(token.address) || !isAddress(token.pair)) { failed++; continue; }
  try {
    const r = await tradesOf({ mint: token.address, curve: token.pair, minutes: MINUTES, cache });
    calls += r.calls; parsed += r.parsed;
    covered.set(token.address, r.covered);
    for (const t of r.trades) add(token.address + "|" + t.sig + "|" + t.wallet, t.amount);
    if (r.capped) console.log(`  ${token.symbol}: capped, the last ${r.covered} min`);
  } catch (e) { failed++; console.log(`  ${token.symbol}: ${e.message}`); }
}
console.log(`${calls} Helius calls · ${parsed} transactions parsed · ${failed} coins failed`);

/* ---------- 2. wallets only ---------- */
const accounts = [...new Set([...net.keys()].map(k => k.split("|")[2]))];
const { isWallet, looked } = await walletKinds(accounts, cache);
saveCache(CACHE, cache);
console.log(`${accounts.length} counterparties · ${looked} newly checked · ${accounts.filter(a => !isWallet(a)).length} are programs`);

/* ---------- 3. per token ---------- */
const byToken = new Map();
for (const [key, amount] of net) {
  const [token, tx, who] = key.split("|");
  if (Math.abs(amount) < 1e-9) continue;                          // in and out again
  if (!isWallet(who)) continue;                                   // a router is not a buyer
  const t = byToken.get(token) ?? { buys:0, sells:0, buyers:new Set(), sellers:new Set(), prints:[], buySizes:[] };
  if (amount > 0) { t.buys++; t.buyers.add(who); t.buySizes.push(amount); }
  else { t.sells++; t.sellers.add(who); }
  t.prints.push({ amount: Math.abs(amount), side: amount > 0 ? "buy" : "sell", who, tx });
  byToken.set(token, t);
}
console.log(`${byToken.size} coins traded by a wallet in the window`);

/* ---------- 4. names and prices ---------- */
const addrs = [...new Set([...byToken.keys(), ...WATCH.map(t => t.address)])];
const meta = {};
for (let i = 0; i < addrs.length; i += 30) {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/${CHAIN.dexscreener}/` + addrs.slice(i, i+30).join(","),
      { headers: { accept: "application/json" } });
    const arr = await r.json();
    for (const p of (Array.isArray(arr) ? arr : arr.pairs ?? [])) {
      const a = p.baseToken?.address; if (!a) continue;
      const prev = meta[a];
      // a bonding curve reports no liquidity; the deepest pair is then the one with a market cap
      const depth = (p.liquidity?.usd ?? 0) || (p.marketCap ?? 0) / 1e6;
      if (!prev || depth > prev.depth)
        meta[a] = { symbol: p.baseToken.symbol, name: p.baseToken.name, price: Number(p.priceUsd || 0),
                    mcap: p.marketCap ?? 0, liq: p.liquidity?.usd ?? 0, url: p.url, dex: p.dexId, depth };
    }
  } catch {}
}

// An untraded watchlist coin still gets its row, with zeros.
for (const w of WATCH) if (!byToken.has(w.address)) byToken.set(w.address, { buys:0, sells:0, buyers:new Set(), sellers:new Set(), prints:[], buySizes:[] });
const watchMeta = Object.fromEntries(WATCH.map(w => [w.address, w]));
const tokens = [...byToken.entries()].map(([addr, t]) => {
  const m = { ...(watchMeta[addr] ? { symbol: watchMeta[addr].symbol, name: watchMeta[addr].name, price: watchMeta[addr].price,
    mcap: watchMeta[addr].mcap, liq: watchMeta[addr].liquidity, url: watchMeta[addr].url } : {}), ...(meta[addr] ?? {}) };
  const usd = v => (m.price ? v * m.price : 0);
  const sorted = t.prints.sort((a,b) => b.amount - a.amount);
  const kept = [];
  for (const p of sorted) {
    const mirrored = kept.some(k => k.who === p.who && k.side !== p.side &&
      Math.abs(k.amount - p.amount) / Math.max(k.amount, p.amount) < 0.02);
    if (!mirrored) kept.push(p);
    if (kept.length >= 2) break;
  }
  const prints = kept.map(p => ({ ...p, usd: Math.round(usd(p.amount)) }));
  return {
    address: addr, watch: WATCH_IDX.has(addr),
    fresh: !!(watchMeta[addr] && watchMeta[addr].fresh), ageH: watchMeta[addr]?.ageH ?? null,
    symbol: m.symbol ?? "?", name: m.name ?? "", price: m.price ?? 0,
    mcap: Math.round(m.mcap ?? 0), liquidity: Math.round(m.liq ?? 0), url: m.url,
    dex: m.dex ?? null, bonding: !!(m.dex && CHAIN.bonding.includes(m.dex)),
    coveredMinutes: covered.get(addr) ?? MINUTES,
    buys: t.buys, sells: t.sells, buyers: t.buyers.size, sellers: t.sellers.size,
    medianBuyUsd: (() => {
      if (!t.buySizes.length) return 0;
      const v = t.buySizes.slice().sort((a,b) => a-b);
      return Math.round(usd(v[Math.floor(v.length/2)]) * 100) / 100;
    })(),
    volume: Math.round(usd(t.prints.reduce((s,p) => s + p.amount, 0))),
    prints
  };
})
// a curve has no liquidity figure; a coin has to at least be worth something to be listed
.filter(t => t.watch || (t.symbol !== "?" && !QUOTE.has(t.symbol.toLowerCase()) && (t.liquidity >= 5_000 || t.mcap >= 5_000)))
.sort((a,b) => (b.watch - a.watch) || (a.watch ? WATCH_IDX.get(a.address) - WATCH_IDX.get(b.address) : b.volume - a.volume));

writeFileSync(OUT,
  `// Written by scripts/read-chain.mjs — read off ${CHAIN.name} (pump.fun), not from an aggregator.\n` +
  "window.CHAIN_LIVE = " + JSON.stringify({
    updated: new Date().toISOString(), chain: CHAIN.key, chainName: CHAIN.name, explorer: CHAIN.explorer,
    windowMinutes: MINUTES, head: Number(head),
    scanned: BOARD.length,
    watchlist: WATCH.map(t => t.symbol),
    wallets: new Set([...net.keys()].map(k => k.split("|")[2]).filter(isWallet)).size,
    tokens: tokens.slice(0, Math.max(40, WATCH.length))
  }, null, 1) + ";\n");

console.log(`\nthe last ${MINUTES} minutes, by money moved`);
for (const t of tokens.slice(0, 12)) {
  const big = t.prints[0];
  console.log("  " + t.symbol.padEnd(11) +
    ("$" + t.volume.toLocaleString("en-US")).padStart(11) +
    ("  " + t.buyers + " bought / " + t.sellers + " sold").padEnd(24) +
    (t.coveredMinutes < MINUTES ? " (" + t.coveredMinutes + " min)" : "") +
    (big ? " biggest: " + big.side + " $" + big.usd.toLocaleString("en-US") : ""));
}
