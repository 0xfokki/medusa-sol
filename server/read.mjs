// One ticker, read on demand: where it trades on pump.fun, the last hour of wallets moving
// through its bonding curve, what X liked most about it today, and the same verdict the
// board gives - (buyers - sellers) / wallets against (bull - bear) / posts.
//
// The chain side goes through Helius (metered, bounded by CHAIN.sigCap per read) and
// DexScreener's keyless API. The X side is one request per read (~20 posts, about a third
// of a cent), so the caller caches by symbol and paces each seat; this module just reads.

import { readFileSync } from "fs";
import { join } from "path";
import { CHAIN } from "../scripts/chains.mjs";
import { tradesOf, walletKinds, loadCache, saveCache, isAddress } from "../scripts/solana.mjs";
import * as X from "../scripts/pull-x.mjs";

const DEX = "https://api.dexscreener.com";
const isContract = isAddress;
// base58 is case-sensitive: an address is compared as written, never lowercased
const low = a => String(a || "");
const num = v => (v == null || v === "" || isNaN(Number(v))) ? null : Number(v);
// a bonding curve reports no liquidity: the deepest pair is then the one with a market cap
const depth = p => (p.liquidity?.usd || 0) || (p.marketCap || 0) / 1e6;

/* ---------- what the site already knows ---------- */
function readJsLiteral(file, marker) {
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw.slice(raw.indexOf("{", raw.indexOf(marker))).replace(/;\s*$/, ""));
  } catch { return null; }
}
const boardOf = site => readJsLiteral(join(site, "chain-data.js"), "CHAIN_READ");
const liveOf = site => readJsLiteral(join(site, "chain-live.js"), "CHAIN_LIVE");

/* ---------- 1. where it trades ---------- */
function marketOf(p) {
  return {
    price: num(p.priceUsd), change: { h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
    volume: { h1: num(p.volume?.h1), h24: num(p.volume?.h24) },
    liquidity: num(p.liquidity?.usd), mcap: num(p.marketCap ?? p.fdv),
    txns: { h1: p.txns?.h1 || null, h24: p.txns?.h24 || null },
    ageH: p.pairCreatedAt ? Math.round((Date.now() - p.pairCreatedAt) / 36e5) : null,
    dex: p.dexId || null, version: (p.labels || [])[0] || null
  };
}
const best = pairs => (pairs || []).filter(p => p.chainId === CHAIN.dexscreener && p.baseToken?.address)
  .sort((a, b) => depth(b) - depth(a))[0] || null;
async function dex(path) {
  const r = await fetch(DEX + path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("dexscreener " + r.status);
  return r.json();
}

export async function resolveToken(q, site) {
  q = String(q || "").trim().replace(/^\$/, "");
  if (!q) throw new Error("which token?");
  let p = null;
  if (isContract(q)) {
    p = best(await dex("/tokens/v1/" + CHAIN.dexscreener + "/" + q));
  } else {
    const UP = q.toUpperCase(), board = boardOf(site);
    const known = board && [...(board.trending || []), ...(board.tokens || []), ...(board.universe || [])].find(t => String(t.symbol).toUpperCase() === UP);
    if (known?.address) p = best(await dex("/tokens/v1/" + CHAIN.dexscreener + "/" + known.address));
    if (!p) {
      const found = ((await dex("/latest/dex/search?q=" + encodeURIComponent(UP))).pairs || []).filter(x => x.chainId === CHAIN.dexscreener && x.baseToken?.address);
      const exact = found.filter(x => String(x.baseToken.symbol).toUpperCase() === UP);
      // one ticker, several contracts: that is the caller's call, not a liquidity coin-flip.
      // Nothing is spent on X until they pick one by address.
      const byAddr = new Map();
      for (const x of exact) { const a = low(x.baseToken.address); if (!byAddr.has(a) || (x.liquidity?.usd || 0) > (byAddr.get(a).liquidity?.usd || 0)) byAddr.set(a, x); }
      if (byAddr.size > 1) {
        return { choose: [...byAddr.values()].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)).slice(0, 8).map(x => ({
          symbol: x.baseToken.symbol, name: x.baseToken.name || x.baseToken.symbol, address: low(x.baseToken.address), url: x.url,
          mcap: num(x.marketCap ?? x.fdv), liquidity: num(x.liquidity?.usd), volume24: num(x.volume?.h24),
          ageH: x.pairCreatedAt ? Math.round((Date.now() - x.pairCreatedAt) / 36e5) : null
        })), query: UP };
      }
      p = best(exact) || best(found.filter(x => String(x.baseToken.symbol).toUpperCase().includes(UP)));
    }
  }
  if (!p) return null;
  return {
    symbol: p.baseToken.symbol, name: p.baseToken.name || p.baseToken.symbol,
    address: low(p.baseToken.address), pair: p.pairAddress, url: p.url,
    explorer: CHAIN.explorer + "/token/" + low(p.baseToken.address),
    market: marketOf(p)
  };
}

/* ---------- 2. the last hour of wallets ---------- */
// The service's own copy of the parsed-trade cache (scripts/solana.mjs), in its data
// folder: every read only pays Helius for what happened since the last one.
let sol = { at: 0, file: null, data: null };
function solCache(dataDir) {
  const file = join(dataDir, "sol-cache.json");
  if (!sol.data || sol.file !== file || Date.now() - sol.at > 6 * 3_600_000) sol = { at: Date.now(), file, data: loadCache(file) };
  return sol;
}

export async function walk({ address, pair, price, minutes = 60, site, dataDir }) {
  if (!isAddress(pair)) throw new Error("no pool address for this coin");
  const { file, data: cache } = solCache(dataDir);
  const r = await tradesOf({ mint: address, curve: pair, minutes, cache });
  const net = new Map();
  for (const x of r.trades) net.set(x.sig + "|" + x.wallet, (net.get(x.sig + "|" + x.wallet) ?? 0) + x.amount);
  const counterparties = [...new Set([...net.keys()].map(k => k.split("|")[1]))];
  const { isWallet } = await walletKinds(counterparties, cache);
  saveCache(file, cache);
  const calls = r.calls, failed = 0, head = null;
  minutes = r.covered;
  const t = { buys: 0, sells: 0, buyers: new Set(), sellers: new Set(), prints: [], buySizes: [], volume: 0 };
  for (const [key, amount] of net) {
    const [tx, who] = key.split("|");
    if (Math.abs(amount) < 1e-9 || !isWallet(who)) continue;
    const usd = price ? Math.abs(amount) * price : null;
    if (amount > 0) { t.buys++; t.buyers.add(who); if (usd) t.buySizes.push(usd); }
    else { t.sells++; t.sellers.add(who); }
    if (usd) t.volume += usd;
    t.prints.push({ side: amount > 0 ? "buy" : "sell", amount: Math.abs(amount), usd, wallet: who, tx, txUrl: CHAIN.explorer + "/tx/" + tx });
  }
  t.prints.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const sizes = t.buySizes.sort((a, b) => a - b);
  const buyers = t.buyers.size, sellers = t.sellers.size, wallets = buyers + sellers;
  return {
    source: "walk", windowMinutes: minutes, capped: r.capped, head, calls, failed,
    buyers, sellers, wallets, buys: t.buys, sells: t.sells,
    lean: wallets ? +((buyers - sellers) / wallets).toFixed(3) : 0,
    volumeUsd: price ? Math.round(t.volume) : null,
    medianBuyUsd: sizes.length ? +sizes[sizes.length >> 1].toFixed(2) : null,
    prints: t.prints.slice(0, 3).map(p => ({ ...p, usd: p.usd ? Math.round(p.usd) : null }))
  };
}

// the board already walked this token minutes ago: same numbers, no wait
function fromLive(symbol, site) {
  const live = liveOf(site);
  if (!live || Date.now() - Date.parse(live.updated) > 15 * 60_000) return null;
  const t = (live.tokens || []).find(x => String(x.symbol).toUpperCase() === symbol.toUpperCase());
  if (!t) return null;
  const wallets = (t.buyers || 0) + (t.sellers || 0);
  return {
    source: "board", windowMinutes: live.windowMinutes || 60, head: live.head, updated: live.updated,
    buyers: t.buyers || 0, sellers: t.sellers || 0, wallets, buys: t.buys || 0, sells: t.sells || 0,
    lean: wallets ? +(((t.buyers || 0) - (t.sellers || 0)) / wallets).toFixed(3) : 0,
    volumeUsd: t.volume ?? null, medianBuyUsd: t.medianBuyUsd ?? null,
    prints: (t.prints || []).slice(0, 3).map(p => ({ side: p.side, amount: p.amount, usd: p.usd, wallet: p.who || p.wallet, tx: p.tx, txUrl: CHAIN.explorer + "/tx/" + p.tx }))
  };
}
// the chain did not answer: DexScreener's fills for the hour, which count trades, not wallets
function fromDex(market) {
  const h1 = market.txns?.h1; if (!h1) return null;
  const buys = h1.buys || 0, sells = h1.sells || 0, n = buys + sells;
  return { source: "dexscreener", windowMinutes: 60, buyers: null, sellers: null, wallets: null, buys, sells, lean: n ? +((buys - sells) / n).toFixed(3) : 0, volumeUsd: market.volume?.h1 ?? null, medianBuyUsd: null, prints: [] };
}

/* ---------- 3. what X liked most about it today ---------- */
// X's API hands text back with entities in it ("for &amp; celebrate"); the page escapes on
// its own, so they are undone here once
const unescapeHtml = s => String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
// Copy-pasted drives ("YOUR vote matters! Listing ID: 4252") arrive from twenty accounts
// at once and say nothing about the coin; they are dropped before anything is counted.
const CAMPAIGN = /\b(your vote matters|votes? (are |is )?needed|every vote counts|listing id|vote for \$|top ?\d+ leaderboard|community growth)\b/i;
export async function social({ symbol, address, hours = 24, xKey = null, max = 6, queryType = "Top" }) {
  if (!xKey && !X.hasKey()) return { posts: [], bull: 0, bear: 0, messages: 0, note: "no X key on this seat" };
  const UP = symbol.toUpperCase(), since = Math.floor((Date.now() - hours * 3600e3) / 1000);
  const narrow = X.COLLIDES.has(UP) || UP.length <= 3;
  const query = "$" + symbol + (narrow ? " solana" : "") + " lang:en -filter:retweets -filter:replies since_time:" + since;
  const raw = await X.search(query, 1, queryType, xKey || undefined);
  const about = [], seen = new Set(), shapes = new Set();
  let messages = 0, bull = 0, bear = 0;
  for (const t of raw) {
    if (seen.has(t.id)) continue; seen.add(t.id);
    const a = t.author || {}, text = unescapeHtml(X.clean(t.text));
    if (X.firstTag(text) !== UP) continue;
    if (CAMPAIGN.test(text)) continue;                                  // a vote drive is not a view
    const shape = text.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z$ ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
    if (shapes.has(shape)) continue;                                     // the same words from another account
    shapes.add(shape);
    const quoted = (text.match(X.ADDRESSES) || []).map(low);
    if (address && quoted.length && !quoted.includes(address)) continue;
    if (narrow && !CHAIN.chainWord.test(text) && !(address && text.toLowerCase().includes(address))) continue;
    if (a.isAutomated || X.ABUSE.test(text) || X.SHILL_NO_CA.test(text)) continue;
    messages++;
    const side = X.readingTicker(text);
    if (side === "Bullish") bull++; else if (side === "Bearish") bear++;
    about.push({ t, a, text, side });
  }
  about.sort((x, y) => (y.t.likeCount ?? 0) - (x.t.likeCount ?? 0));
  const posts = [], authors = new Set();
  for (const { t, a, text, side } of about) {
    if (authors.has(a.id)) continue; authors.add(a.id);
    posts.push({
      url: t.url || "https://x.com/" + a.userName + "/status/" + t.id,
      name: a.name || a.userName, handle: a.userName, verified: Boolean(a.isBlueVerified),
      avatar: (a.profilePicture || "").replace("_normal.", "_bigger.") || null, followers: a.followers ?? 0,
      text: text.slice(0, 280), sentiment: side, emo: side ? X.emotion(text, side === "Bullish") : null,
      likes: t.likeCount ?? 0, views: t.viewCount ?? 0, at: new Date(t.createdAt).toISOString()
    });
    if (posts.length >= max) break;
  }
  return { posts, bull, bear, messages, read: raw.length, hours, cost: +(raw.length / 1000 * 0.15).toFixed(4), ownKey: !!xKey };
}

/* ---------- 4. the verdict, the board's own formula ---------- */
export function verdict(chain, soc, market) {
  const wallets = chain?.wallets, thinKnown = wallets != null && wallets < 3;
  const chainLean = chain ? chain.lean : 0;
  const messages = (soc?.bull || 0) + (soc?.bear || 0), hasSocial = messages >= 2;
  const socialLean = hasSocial ? (soc.bull - soc.bear) / messages : null;
  let score, tag;
  if (!chain) { score = hasSocial ? Math.round(socialLean * 100) : 0; tag = hasSocial ? "SOCIAL ONLY" : "NO READ"; }
  else if (thinKnown) { score = 0; tag = "TOO THIN"; }
  else if (hasSocial) { score = Math.round(((chainLean + socialLean) / 2) * 100); tag = Math.sign(chainLean) === Math.sign(socialLean) ? "CONFIRMED" : "CONTRADICTED"; }
  else { score = Math.round(chainLean * 100); tag = "CHAIN ONLY"; }
  const fresh = market?.ageH != null && market.ageH < 24;
  const runner = !!chain && !fresh && !thinKnown && chainLean >= .5 && (wallets == null || wallets >= 5) && (!hasSocial || socialLean >= 0);
  const up = chainLean > 0;
  const line = tag === "TOO THIN" ? "Under three wallets touched it in the last hour. Nothing to read yet."
    : tag === "NO READ" ? "No wallets read and X is quiet. She has nothing to say about it."
    : tag === "SOCIAL ONLY" ? (socialLean > 0 ? "X is bullish and the chain could not be read." : "X is bearish and the chain could not be read.")
    : tag === "CONFIRMED" ? (up ? "Money and words agree: buying." : "Money and words agree: selling.")
    : tag === "CONTRADICTED" ? (up ? "Wallets are buying while the crowd talks it down." : "The crowd is loud and the wallets are leaving.")
    : (up ? "X is quiet; the last hour of money leans up." : chainLean < 0 ? "X is quiet; the last hour of money leans down." : "X is quiet and the hour is flat.");
  // The grade answers the only question a visitor has: is this good or not. Five bands
  // on the score, then the caveats that make a +40 on nine wallets worth less than it looks.
  const abs = Math.abs(score);
  let grade;
  if (tag === "TOO THIN" || tag === "NO READ") grade = { level: 0, label: "NO READ", note: "Not enough to grade." };
  else if (abs < 25) grade = { level: 0, label: "NOISE", note: "Nothing to act on. Money and words are flat." };
  else if (score >= 50) grade = { level: 2, label: "STRONG", note: "Real buying, and the crowd is behind it. As good as her reads get." };
  else if (score >= 25) grade = { level: 1, label: "DECENT", note: "Leaning up, not by much. Worth a look, not a bet." };
  else if (score <= -50) grade = { level: -2, label: "BAD", note: "Real selling. Stay out." };
  else grade = { level: -1, label: "WEAK", note: "Leaning down. Sellers have the hour." };
  const caveats = [];
  if (wallets != null && wallets < 20 && grade.level !== 0) caveats.push("thin sample: " + wallets + " wallets in the hour");
  if (tag === "CONTRADICTED") caveats.push("money and words disagree; trust the money");
  if (tag === "CHAIN ONLY" && grade.level !== 0) caveats.push("X is quiet, this is the chain alone");
  if (tag === "SOCIAL ONLY") caveats.push("words only, the chain could not be read");
  if (fresh) caveats.push("under a day old, no history to judge by");
  if (runner) caveats.push("runner watch: buyers outnumber sellers 3 to 1");
  grade.caveats = caveats;
  return { score, tag, runner, fresh, grade, line: (runner ? "RUNNER WATCH · " : "") + line,
    chainLean: +chainLean.toFixed(3), socialLean: socialLean == null ? null : +socialLean.toFixed(3) };
}

const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " took too long")), ms))]);

/* ---------- the read ---------- */
export async function readTicker(q, { site, dataDir, xKey = null, maxPosts = 6 }) {
  const t0 = Date.now();
  const token = await resolveToken(q, site);
  if (!token) return null;
  if (token.choose) return token;                       // several tokens carry this ticker: ask, spend nothing
  const notes = [];
  const chainP = (async () => {
    const live = fromLive(token.symbol, site);
    if (live) return live;
    try { return await timeout(walk({ address: token.address, pair: token.pair, price: token.market.price, site, dataDir }), 55_000, "the chain walk"); }
    catch (e) { notes.push("chain: " + e.message); return fromDex(token.market); }
  })();
  const socialP = social({ symbol: token.symbol, address: token.address, xKey, max: maxPosts }).catch(e => {
    if (e.code === "KEY") throw e;                        // their key is bad: say so instead of a half read
    notes.push("x: " + e.message); return { posts: [], bull: 0, bear: 0, messages: 0, note: e.message };
  });
  // from here on X has been asked (or is being asked): a failure still cost a read
  const spent = e => { e.spent = true; throw e; };
  const [chain, soc] = await Promise.all([chainP, socialP]).catch(spent);
  return { ...token, generated: new Date().toISOString(), chain: CHAIN.key, chainName: CHAIN.name, onchain: chain, social: soc, verdict: verdict(chain, soc, token.market), notes, ms: Date.now() - t0 };
}
