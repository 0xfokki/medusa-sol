// What the chain is actually trading: [CHAIN=arc|robinhood] node scripts/pull-chain.mjs
//
// The ten biggest tokens by market cap, with the real buy and sell counts behind them. This
// is the "does" side of say vs do, and unlike everything before it, it is not simulated.
//
// Two steps, because only one of them is open:
//   1. the ranking — dexscreener.com/<chain> sorted by market cap. Their ranking API is
//      refused to us (403, Cloudflare), so we open the screener the way a person would and
//      take the pair addresses in the order it lists them. A browser window appears briefly.
//   2. the numbers — api.dexscreener.com, public and keyless, queried by pair address.
//
// Several pairs can share a token (one token can trade against two quotes); the deepest pair
// wins, so a token is never counted twice.

// The screener page needs a real browser (Cloudflare refuses a plain fetch), which means a
// home machine - a data-centre IP does not get through. NO_BROWSER=1 skips it entirely and
// ranks the chain off numbers that are keyless from anywhere, so the whole pipeline can live
// on the server. What is lost that way is discovery of a coin nobody has seen yet: the two
// public feeds below cover part of it, a browser run from home covers the rest.
const NO_BROWSER = process.env.NO_BROWSER === "1";
const { chromium } = NO_BROWSER ? { chromium: null } : await import("playwright");
import { writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { CHAIN } from "./chains.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(HERE, "..", ".st-profile");
const OUT = join(HERE, "..", "chain-data.js");
// Two views of the same chain: what is trading hardest and what is trading most. Between
// them they cover everything with a pulse; the ranking below is ours, off real numbers.
const SCREENER = [
  `https://dexscreener.com/${CHAIN.dexscreener}?rankBy=trendingScoreH24&order=desc`,
  `https://dexscreener.com/${CHAIN.dexscreener}?rankBy=volume&order=desc`
];
const KEEP = 10;
// Floors for the acceleration ranking (server mode). Without them a coin that traded $40 in
// the last hour against $60 all day scores a huge ratio on noise and takes the top slot.
const HOT_MIN_H1 = 500, HOT_MIN_H24 = 5_000, HOT_MIN_LIQ = 25_000;
// A pair younger than a day has all of its 24h volume inside the last hour by definition, so
// the plain ratio pins at 24 for everything newly launched and the list fills with coins an
// hour old. Capping the ratio fixes it without throwing the launches out: past this multiple
// a coin has to bring real volume to climb, so a fresh launch doing millions still rises and
// a fresh launch doing pennies does not.
const HOT_CAP = 4;

// Fresh launches are the most interesting thing on the chain and the most dangerous: in the
// first hours a real launch and a pump-and-dump look the same in every public number, market
// cap included (a launch that died within three hours had a bigger cap at ranking time than
// one that went on to grow twelvefold). What separates them is time and which way the
// liquidity goes. So:
//   - nothing younger than MIN_AGE_H at all - most dumps are over before then;
//   - under FRESH_AGE_H a coin is "fresh": it must hold FRESH_MIN_LIQ in the pool, and at most
//     FRESH_SLOTS of the ten may be fresh, so proven coins still anchor the board;
//   - anything whose liquidity fell by more than LIQ_DROP since the last run is dropped on
//     the spot - that is what a rug looks like from outside, and it should not sit on the
//     page for an hour waiting for the next pass.
// Market cap is deliberately not a filter: on a fresh coin it is price times supply, easy to
// inflate, and it did not tell the dead launch from the live one.
// pump.fun: a coin lives on its curve for hours, not days, so the floors above are read
// against market cap (a curve has no liquidity figure) and the ages are in hours, short.
// A coin whose market cap halved since the last pass was dumped; off the list.
const MIN_AGE_H = 0, FRESH_AGE_H = 24, FRESH_MIN_LIQ = 15_000, FRESH_SLOTS = 10, LIQ_DROP = .5;
// The screener's own trending order, kept separately: this is the list the social read
// follows (which cashtags to search), so it has to be what people are actually looking at
// today, not the ten biggest by market cap.
const TRENDING = Number(process.env.TRENDING || 10);

// Bridged majors and stables ride on this chain but were not born here. The board is for
// tokens this chain made.
const NOT_OURS = CHAIN.notOurs;
// A token minted minutes ago can report a market cap in the quadrillions; that is a broken
// supply, not a valuation.
// Tokenised stocks and funds (Robinhood issues them on its own chain: "NVIDIA • Robinhood
// Token", "SPDR Gold Trust • ...") trade big tickets now and then but are not what the board
// is for; with them in, half the watchlist sat dark in any given hour. Matched on the token's
// name, so a memecoin called "Robinhood Wallet" still gets in.
// (no tokenised stocks on pump.fun; a coin called "Trust Fund" is a coin)
const isStock = () => false;
// A pool with liquidity is judged by it (the Robinhood floors); a bonding curve has none and
// is judged by its market cap instead.
const deep = (t, liq, cap) => t.liquidity > 0 ? t.liquidity >= liq : t.mcap >= cap;
const SANE = t => deep(t, 25_000, 5_000) && t.mcap > 5_000 && t.mcap < 1e12 && t.vol24h >= 2_000;

/* ---- 1. the ranking ---- */
// Server mode: every pair already on file, plus whatever the keyless discovery feeds show
// for this chain right now. Order is filled in later, from measured 24h volume.
// DexScreener's own screener - the page and the io.dexscreener.com endpoints behind it -
// answers 403 to a data-centre IP, which is why that path needs a browser at home. Their
// documented search API does answer, so the chain is enumerated through it instead: search
// returns up to 30 pairs per query across all chains, we keep this chain's. One query alone
// sees very little, so the list below is chosen to sweep from different directions - the
// chain's own quote tokens (every pair here trades against one of them), its name, and the
// words memecoins are actually named after. This is enumeration, not ranking: what comes
// back is a pile of candidates, and 24h volume decides the order later.
const SEARCH_TERMS = [...new Set([
  "solana", "pump", "pumpfun", CHAIN.homeTicker, ...CHAIN.quote.slice(0, 3),
  "cat", "dog", "ai", "meme", "inu", "pepe", "moon", "baby", "trump", "coin"
])].filter(Boolean);

// pump.fun's own lists: what is live on stream, the king of the hill, what traded last.
// Their API answers a plain fetch from anywhere but wants a second between calls. The
// bonding curve is the pair address DexScreener knows the coin by.
// Their edge refuses node's fetch outright (403, a TLS fingerprint rule) and lets curl
// through, so the calls go out through curl.
const PUMP_FEEDS = [
  "/coins/currently-live?limit=50&offset=0&includeNsfw=false",
  "/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false"
];
async function pumpCurves() {
  const { execFileSync } = await import("child_process");
  const out = new Set();
  for (const path of PUMP_FEEDS) {
    try {
      const body = execFileSync("curl", ["-s", "-m", "15", "-A", "Mozilla/5.0", "-H", "accept: application/json", "https://frontend-api-v3.pump.fun" + path], { encoding: "utf8", timeout: 20_000 });
      const j = JSON.parse(body);
      for (const c of (Array.isArray(j) ? j : [j])) if (c && c.bonding_curve && !c.complete) out.add(c.bonding_curve);
    } catch { /* their feed is a bonus, not a dependency */ }
    await new Promise(r => setTimeout(r, 1_200));
  }
  return out;
}

async function knownPairs() {
  const out = await pumpCurves();
  console.log(`pump.fun feeds: ${out.size} live curves`);
  const f = join(HERE, "..", "chain-data.js");
  if (existsSync(f)) {
    try {
      const raw = readFileSync(f, "utf8");
      const d = JSON.parse(raw.slice(raw.indexOf("{", raw.indexOf("CHAIN_READ"))).replace(/;\s*$/, ""));
      for (const t of [...(d.trending ?? []), ...(d.tokens ?? []), ...(d.universe ?? [])])
        if (t.pair) out.add(t.pair);
    } catch {}
  }
  const before = out.size;
  for (const q of SEARCH_TERMS) {
    try {
      const r = await fetch("https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q),
        { headers: { accept: "application/json" } });
      if (!r.ok) continue;
      for (const pair of (await r.json()).pairs ?? [])
        if (pair.chainId === CHAIN.dexscreener && pair.pairAddress) out.add(pair.pairAddress);
    } catch {}
    await new Promise(r => setTimeout(r, 350));       // their public API, so do not hammer it
  }
  console.log(`search swept ${SEARCH_TERMS.length} terms: ${out.size - before} pairs beyond the ones on file`);
  // promotion-driven feeds, so a biased sample: they only ever add candidates, never rank
  for (const url of ["https://api.dexscreener.com/token-boosts/latest/v1",
                     "https://api.dexscreener.com/token-profiles/latest/v1"]) {
    try {
      const rows = await (await fetch(url, { headers: { accept: "application/json" } })).json();
      const mine = (Array.isArray(rows) ? rows : []).filter(r => r.chainId === CHAIN.dexscreener && r.tokenAddress);
      for (let i = 0; i < mine.length; i += 30) {
        const r = await fetch("https://api.dexscreener.com/tokens/v1/" + CHAIN.dexscreener + "/" +
          mine.slice(i, i + 30).map(x => x.tokenAddress).join(","), { headers: { accept: "application/json" } });
        if (!r.ok) continue;
        for (const pair of (await r.json()) ?? []) if (pair.pairAddress) out.add(pair.pairAddress);
      }
    } catch {}
  }
  return [...out];
}

// Last run's liquidity per token address, read before this run overwrites the file.
const prevLiq = new Map();
{
  const f = join(HERE, "..", "chain-data.js");
  if (existsSync(f)) {
    try {
      const raw = readFileSync(f, "utf8");
      const d = JSON.parse(raw.slice(raw.indexOf("{", raw.indexOf("CHAIN_READ"))).replace(/;\s*$/, ""));
      for (const t of [...(d.trending ?? []), ...(d.tokens ?? []), ...(d.universe ?? [])])
        if (t.address && (t.liquidity || t.mcap)) prevLiq.set(t.address.toLowerCase(), Math.max(prevLiq.get(t.address.toLowerCase()) ?? 0, t.liquidity || t.mcap));
    } catch {}
  }
}

const ranked = [];
if (NO_BROWSER) {
  const found = await knownPairs();
  if (!found.length) { console.error("no pairs on file and discovery came back empty"); process.exit(1); }
  ranked.push(...found);
  console.log("no-browser mode: " + found.length + " pairs known or discovered");
} else {
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,                         // headless is turned away by the same check
  viewport: { width: 1400, height: 1000 },
  locale: "en-US", timezoneId: "America/New_York",
  args: ["--disable-blink-features=AutomationControlled"]
});
const page = ctx.pages()[0] ?? await ctx.newPage();
for (const url of SCREENER) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector("a.ds-dex-table-row", { timeout: 60_000 });
  await page.waitForTimeout(3000);         // let the list settle
  // Only the table's own rows: other links on the page (trending strips, ads, the sidebar)
  // point at pairs too and would poison the list.
  const rows = await page.$$eval("a.ds-dex-table-row",
    els => els.map(e => e.getAttribute("href").split("/")[2]).filter(Boolean));
  ranked.push(...rows.slice(0, 60));
}
await ctx.close();
}
const candidates = [...new Set(ranked)];
// With the screener, a pair's position on its page is the rank its token inherits. Without
// it there is no such order, so the rank is filled in from measured 24h volume once the
// numbers are in (see volRank below).
const screenerRank = new Map(candidates.map((p, i) => [p.toLowerCase(), NO_BROWSER ? 1e9 : i]));
if (!candidates.length) { console.error("no pairs to price"); process.exit(1); }
console.log(`${candidates.length} pairs to price`);

/* ---- 2. the numbers, from the public API ---- */
const pairs = [];
for (let i = 0; i < candidates.length; i += 30) {
  const url = `https://api.dexscreener.com/latest/dex/pairs/${CHAIN.dexscreener}/` + candidates.slice(i, i + 30).join(",");
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) { console.error("dexscreener:", res.status); continue; }
  pairs.push(...((await res.json()).pairs ?? []));
}

// One row per token: the deepest pair behind it. A token's rank is its best pair's rank.
const byToken = new Map(), tokenRank = new Map(), heatRank = new Map();
for (const p of pairs) {
  const a = p.baseToken?.address; if (!a) continue;
  if (CHAIN.dexIds && !CHAIN.dexIds.includes(p.dexId)) continue;
  const prev = byToken.get(a);
  if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) byToken.set(a, p);
  const r = screenerRank.get((p.pairAddress || "").toLowerCase()) ?? 1e9;
  tokenRank.set(a, Math.min(tokenRank.get(a) ?? 1e9, r));
  if (NO_BROWSER) {
    // How many trades it is doing right now, weighted by how that hour compares with an
    // average hour of its day: the one that is accelerating leads, which is what "trending"
    // is supposed to mean. Counted in trades, not dollars - a dollar ranking let one whale
    // ticket on a quiet token outrank a coin thousands of wallets were trading. The dollar
    // floors below still keep a coin that did $40 in an hour off the list.
    const v1 = p.volume?.h1 ?? 0, v24 = p.volume?.h24 ?? 0, liq = p.liquidity?.usd ?? 0;
    const t1 = (p.txns?.h1?.buys ?? 0) + (p.txns?.h1?.sells ?? 0);
    const t24 = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
    const ratio = Math.min(t1 * 24 / Math.max(1, t24), HOT_CAP);
    const hot = (v1 >= HOT_MIN_H1 && v24 >= HOT_MIN_H24 && (liq >= HOT_MIN_LIQ || (p.marketCap ?? 0) >= HOT_MIN_LIQ)) ? t1 * ratio : 0;
    heatRank.set(a, Math.max(heatRank.get(a) ?? 0, hot));
  }
}

const tokens = [...byToken.values()]
  .map(p => ({
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    address: p.baseToken.address,
    pair: p.pairAddress,
    url: p.url,
    price: Number(p.priceUsd ?? 0),
    mcap: p.marketCap ?? 0,
    liquidity: Math.round(p.liquidity?.usd ?? 0),
    vol24h: Math.round(p.volume?.h24 ?? 0),
    buys: p.txns?.h24?.buys ?? 0,
    sells: p.txns?.h24?.sells ?? 0,
    change24h: p.priceChange?.h24 ?? 0,
    ageDays: p.pairCreatedAt ? +((Date.now() - p.pairCreatedAt) / 86_400_000).toFixed(1) : null
  }))
  .filter(t => !NOT_OURS.test(t.symbol) && !isStock(t.name) && SANE(t))
  .sort((a, b) => b.mcap - a.mcap)
  .slice(0, KEEP);

// The trending ten, in the screener's order: one row per ticker (two tokens can share a
// symbol; the higher-ranked one keeps it, since the social side searches by symbol), never
// a stablecoin or bridged major, and only with real liquidity behind it. This is the
// watchlist: the daily social read searches exactly these cashtags, the chain reader always
// carries them, and every block on the page shows these ten and no others.
// server mode: the one accelerating hardest leads. A token that clears none of the floors
// scores 0 and simply sorts to the back, behind everything that is actually moving.
if (NO_BROWSER) [...heatRank.entries()].sort((a, b) => b[1] - a[1]).forEach(([addr], i) => tokenRank.set(addr, i));
const takenSym = new Set(), dropped = [];
let freshTaken = 0;
const trending = [...byToken.values()]
  .map(p => ({
    symbol: p.baseToken.symbol, name: p.baseToken.name, address: p.baseToken.address, pair: p.pairAddress, url: p.url,
    price: Number(p.priceUsd ?? 0), mcap: Math.round(p.marketCap ?? 0), liquidity: Math.round(p.liquidity?.usd ?? 0),
    vol24h: Math.round(p.volume?.h24 ?? 0), rank: tokenRank.get(p.baseToken.address) ?? 1e9,
    buys: p.txns?.h24?.buys ?? 0, sells: p.txns?.h24?.sells ?? 0, change24h: p.priceChange?.h24 ?? 0,
    ageDays: p.pairCreatedAt ? +((Date.now() - p.pairCreatedAt) / 86_400_000).toFixed(1) : null,
    ageH: p.pairCreatedAt ? Math.round((Date.now() - p.pairCreatedAt) / 3_600_000) : null
  }))
  .map(t => ({ ...t, fresh: t.ageH != null && t.ageH < FRESH_AGE_H }))
  .filter(t => !NOT_OURS.test(t.symbol) && !isStock(t.name) && deep(t, 5_000, 5_000) && t.mcap < 1e12)
  .filter(t => {
    if (!NO_BROWSER) return true;                    // the screener path keeps its own judgement
    if (t.ageH == null || t.ageH < MIN_AGE_H) { dropped.push(t.symbol + " (too young)"); return false; }
    if (t.fresh && !deep(t, 100_000, FRESH_MIN_LIQ)) { dropped.push(t.symbol + (t.liquidity > 0 ? " (fresh, thin pool)" : " (fresh, tiny cap)")); return false; }
    const before = prevLiq.get(t.address.toLowerCase());
    if (before && (t.liquidity || t.mcap) < before * (1 - LIQ_DROP)) { dropped.push(t.symbol + (t.liquidity > 0 ? " (liquidity pulled)" : " (dumped)")); return false; }
    return true;
  })
  .sort((a, b) => a.rank - b.rank)
  .filter(t => { const k = t.symbol.toUpperCase(); if (takenSym.has(k)) return false; takenSym.add(k); return true; })
  .filter(t => !NO_BROWSER || !t.fresh || freshTaken++ < FRESH_SLOTS)
  .slice(0, TRENDING);
if (dropped.length) console.log("left out: " + dropped.slice(0, 12).join(", ") + (dropped.length > 12 ? ", ..." : ""));

// Everything with a pulse, kept for the reader: the board is what the page shows, the universe
// is what the chain reader walks when it goes looking for the day's tops.
const universe = [...byToken.values()]
  .map(p => ({
    symbol: p.baseToken.symbol, address: p.baseToken.address, pair: p.pairAddress,
    dex: p.dexId, version: (p.labels || [])[0] || null,
    mcap: Math.round(p.marketCap ?? 0), liquidity: Math.round(p.liquidity?.usd ?? 0),
    vol24h: Math.round(p.volume?.h24 ?? 0)
  }))
  .filter(t => !NOT_OURS.test(t.symbol) && deep(t, 3_000, 5_000))
  .sort((a, b) => b.vol24h - a.vol24h)
  .slice(0, 15);          // small on purpose: every coin here costs Helius credits in read-chain.mjs
// A trending token that is not among the 25 deepest would never be read off the chain, and
// the social read about it would have nothing to pair with; so the trending ten always ride
// along in the universe (a few extra RPC calls, well under the 90 that timed out).
for (const t of trending) if (!universe.some(u => u.address === t.address))
  universe.push({ symbol: t.symbol, address: t.address, pair: t.pair, dex: null, version: null,
                  mcap: t.mcap, liquidity: t.liquidity, vol24h: t.vol24h });

writeFileSync(OUT,
  `// Written by scripts/pull-chain.mjs — ${CHAIN.name}, via DexScreener's public API.\n` +
  "window.CHAIN_READ = " + JSON.stringify({ updated: new Date().toISOString(), chain: CHAIN.key, chainName: CHAIN.name, explorer: CHAIN.explorer, tokens, trending, universe }, null, 1) + ";\n");

console.log(`${CHAIN.name} · trending ${trending.length}: ` + trending.map(t => t.symbol + (t.fresh ? "*" : "")).join(", ") + "   (* fresh, under " + FRESH_AGE_H + "h)");
console.log(`${CHAIN.name} · top ${tokens.length} by market cap`);
for (const t of tokens) {
  const net = t.buys + t.sells ? ((t.buys - t.sells) / (t.buys + t.sells) * 100).toFixed(0) : "0";
  console.log("  " + t.symbol.padEnd(10) +
    ("$" + Math.round(t.mcap).toLocaleString("en-US")).padStart(13) +
    ("$" + t.vol24h.toLocaleString("en-US")).padStart(12) +
    (t.buys + "/" + t.sells).padStart(14) + String(net + "% net").padStart(10) + "   " + t.name);
}
