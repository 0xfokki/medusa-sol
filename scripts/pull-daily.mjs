// Daily read: what retail is saying on X about the chain's own coins, plus what the crypto
// press is saying about the chain itself (scripts/pull-news.mjs), written to daily-data.js.
//
//   [CHAIN=arc|robinhood] [X_TOP=all] node scripts/pull-daily.mjs
//
// X only, since 2026-09-22: StockTwits had streams for a handful of majors and none for the
// coins that actually trade here, so its tally never met the chain's fills in a verdict, and
// reading it needed a visible browser window on a home connection. X is read through
// twitterapi.io (scripts/pull-x.mjs) with a fixed request budget, so this file needs no
// browser and can run anywhere the key is.
//
// Three reads, in cost order:
//   1. the top post per trending token — one "Top" request each over the last day
//   2. the user's curated accounts — one search, a few pages
//   3. crypto-press RSS — free
//
// Every post is kept word for word and linked to the original. On X nobody tags their own
// post Bullish or Bearish, so every direction here is MEDUSA's reading (readByMedusa), and a
// post whose direction cannot be read is kept for the record but never put on the board.

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { pullX, pullXTop } from "./pull-x.mjs";
import { pullNews } from "./pull-news.mjs";
import { CHAIN } from "./chains.mjs";

const OUT = new URL("../daily-data.js", import.meta.url);
const KEEP_DAYS = 7;
const BOARD = 10;                                // cards on the board — a tape, not a fixed grid
const LOUDEST = 6;

// What scripts/pull-chain.mjs last wrote: the chain's trending ten (the screener's own
// order, one row per ticker, no stablecoins or bridged majors), the market-cap ten and the
// wider universe. Same helper as scripts/pull-news.mjs.
function chainRead() {
  const f = new URL("../chain-data.js", import.meta.url);
  if (!existsSync(f)) return { tokens: [], trending: [], universe: [] };
  try {
    const txt = readFileSync(f, "utf8").replace(/^[\s\S]*?window\.CHAIN_READ\s*=\s*/, "").replace(/;\s*$/, "");
    const d = JSON.parse(txt);
    return { tokens: d.tokens || [], trending: d.trending || [], universe: d.universe || [] };
  } catch { return { tokens: [], trending: [], universe: [] }; }
}
const READ = chainRead();
// The trending ten are the coins the crowd is read about — the same symbols the verdict
// pairs against the chain's fills; a chain-data.js without a trending list (an older pull)
// falls back to the market-cap ten. X_TOP=all reads both tens, at twice the cost.
const TRENDING = READ.trending.length ? READ.trending : READ.tokens;
if (!TRENDING.length) { console.error("no chain-data.js — run scripts/pull-chain.mjs first"); process.exit(1); }
const TOP_TOKENS = process.env.X_TOP === "all"
  ? [...new Map([...TRENDING, ...READ.tokens].map(t => [t.address, t])).values()]
  : TRENDING;

const failed = [];

/* ---- 1. the top post per token ---- */
const xTop = await pullXTop({ tokens: TOP_TOKENS, chainWord: CHAIN.chainWord, chainQuery: CHAIN.key, hours: 24 })
  .catch(e => { failed.push("x top: " + e.message); return { posts: [], top: [], counted: 0, readable: 0, tickers: {}, failed: [] }; });
for (const f of xTop.failed || []) failed.push("x top " + f);

/* ---- 2. the curated accounts ---- */
const x = await pullX()
  .catch(e => { failed.push("x: " + e.message); return { posts: [], counted: 0, readable: 0 }; });
if (x.note) failed.push("x: " + x.note);

/* ---- 3. the press ---- */
const news = await pullNews()
  .catch(e => { failed.push("news: " + e.message); return { posts: [], counted: 0, readable: 0 }; });

if (!xTop.top.length && !x.posts.length) {
  console.error("X gave nothing:", failed.join("; ") || "no posts in the window");
  process.exit(1);
}

// The tally the verdict reads: X's count per cashtag from the top-post pages, plus every
// readable call the curated accounts made, under the coin it named.
const tickers = {};
for (const [sym, v] of Object.entries(xTop.tickers || {})) tickers[sym] = { ...v };
for (const p of x.posts) {
  const t = tickers[p.ticker] ??= { bull: 0, bear: 0, messages: 0 };
  t.messages++;
  t[p.sentiment === "Bullish" ? "bull" : "bear"]++;
}

// Split evenly, and the loudest bull and the loudest bear are always among them where the
// day has both. Taking the biggest accounts outright regardless of side would hand a
// bullish morning the whole board and read as a verdict we never measured.
function balanced(list, n, sideOf, idOf) {
  const out = [], seen = new Set();
  const best = side => list.find(v => sideOf(v) === side && !seen.has(idOf(v)));
  let want = "Bullish";
  while (out.length < n) {
    const other = want === "Bullish" ? "Bearish" : "Bullish";
    const x = best(want) || best(other);          // a one-sided day still fills the board
    if (!x) break;
    seen.add(idOf(x)); out.push(x);
    want = other;
  }
  return out;
}
// Biggest account leads; when the same account calls two different tokens (same
// follower count on both), the more-liked call wins the one slot "one post per author"
// leaves them - not whichever token happened to sit earlier in the watchlist.
const byReach = (a, b) => (b.followers || 0) - (a.followers || 0) || (b.likes || 0) - (a.likes || 0);
// Only posts about a coin on the watchlist reach the cards. The curated accounts post about
// whatever they like, and a card about a coin the rest of the page never mentions reads as
// the page contradicting itself - the posts and the tokens have to be the same ten. Their
// calls on other coins still count in the tally; they just are not shown.
const WATCHED = new Set(TOP_TOKENS.map(t => t.symbol.toUpperCase()));
const onList = p => p.ticker && WATCHED.has(String(p.ticker).toUpperCase());
// X and news are both MEDUSA's own reading, so they compete for the board together, sorted
// by the same reach field (real followers for X, a fixed per-outlet weight for news). News
// is about the chain itself rather than one coin, so it is not held to the watchlist.
const board = balanced([...xTop.posts, ...x.posts.filter(onList), ...news.posts].sort(byReach), BOARD, p => p.sentiment, p => p.handle);

// The loudest six: the biggest accounts talking about the chain's own coins, no bull/bear
// balancing, one post per author.
const loudSeen = new Set();
const loudest = [...xTop.posts, ...x.posts].filter(onList).sort(byReach)
  .filter(p => !loudSeen.has(p.handle) && loudSeen.add(p.handle)).slice(0, LOUDEST);

const mood = Object.values(tickers).reduce((m, v) => (m.bull += v.bull, m.bear += v.bear, m), { bull: 0, bear: 0 });
const today = new Date().toISOString().slice(0, 10);
const entry = {
  date: today, pulledAt: new Date().toISOString(), chain: CHAIN.key,
  source: board.some(p => p.src === "news") ? "X and crypto press" : "X",
  mood: { ...mood, messages: xTop.counted + x.counted },
  sources: { x: xTop.counted + x.counted, xReadable: (xTop.readable || 0) + (x.readable || 0), news: news.counted, newsReadable: news.readable },
  tickers, posts: board, loudest,
  // the most liked post on X about each trending token in the last day, readable or not
  top: xTop.top
};

let days = [];
if (existsSync(OUT)) {
  try { days = JSON.parse(readFileSync(OUT, "utf8").replace(/^[\s\S]*?window\.DAILY_READ\s*=\s*/, "").replace(/;\s*$/, "")).days ?? []; }
  catch { days = []; }
}
// Days from another chain are dropped rather than mixed in; days with no chain key are the
// old Robinhood history and stay.
days = [entry, ...days.filter(d => d.date !== today && (!d.chain || d.chain === CHAIN.key))].slice(0, KEEP_DAYS);
writeFileSync(OUT,
  `// Written by scripts/pull-daily.mjs — ${CHAIN.name}: posts via X and crypto-news outlets, quoted as written.\n` +
  "window.DAILY_READ = " + JSON.stringify({ updated: entry.pulledAt, chain: CHAIN.key, days }, null, 1) + ";\n");

// Faces are kept only while the post they belong to is still on the page.
const AVA = new URL("../avatars/", import.meta.url);
const inUse = new Set(days.flatMap(d => [...d.posts, ...(d.loudest || []), ...(d.top || [])]).map(p => p.avatar).filter(Boolean).map(a => a.split("/").pop()));
if (existsSync(AVA)) for (const f of readdirSync(AVA)) if (!inUse.has(f)) unlinkSync(new URL(f, AVA));

const sides = board.reduce((s, p) => (s[p.sentiment] = (s[p.sentiment] || 0) + 1, s), {});
const withLean = TOP_TOKENS.filter(t => { const v = tickers[t.symbol]; return v && v.bull + v.bear >= 2; }).length;
const cost = ((xTop.counted + x.counted) / 1000 * 0.15).toFixed(3);
console.log(`${today} · ${CHAIN.name}: ${xTop.counted + x.counted} posts on X (${entry.sources.xReadable} with a clear position; ` +
  `top post for ${xTop.top.length}/${TOP_TOKENS.length} tokens, ${xTop.posts.length} readable) + ${news.counted} headlines (${news.readable} on the chain); ` +
  `board: ${sides.Bullish || 0} bulls, ${sides.Bearish || 0} bears; loudest: ${loudest.length}; ` +
  `${withLean}/${TOP_TOKENS.length} tokens with a crowd lean · ~$${cost}` +
  (failed.length ? ` — failed: ${failed.join("; ")}` : ""));
