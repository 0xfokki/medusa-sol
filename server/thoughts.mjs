// The thought intake: people write, this stores it, the page reads it back.
//
// No dependencies — Node's own SQLite and http server. The page is static and served by
// nginx; this only answers /brain/api/*.
//
// What it refuses, and why: a public page quotes these back verbatim, so links, abuse and
// repeats are rejected rather than cleaned up, and one address cannot flood the brain.
// Addresses themselves are never stored — only a salted hash, which is enough to rate
// limit and useless for anything else.

import { createServer } from "http";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const PORT = Number(process.env.PORT ?? 4665);
const DIR = process.env.DATA_DIR ?? "/var/lib/brain";
const MAX_LEN = 140, MIN_LEN = 3;
// overridable so the classifier can be exercised locally without waiting out the limit
const GAP_MS = Number(process.env.GAP_MS ?? 90_000), PER_DAY = Number(process.env.PER_DAY ?? 10);
// Addresses the owner feeds from while working on the page (screenshots, the result card).
// They skip the pace and daily limits only - length, links, abuse and the one-hour duplicate
// rule still apply, so nothing unreadable gets in through here either. Set in the service
// unit (FEED_ALLOW=1.2.3.4,5.6.7.8); raw addresses are compared in memory and never stored,
// the table still keeps only the salted hash.
const FEED_ALLOW = new Set(String(process.env.FEED_ALLOW ?? "").split(",").map(x => x.trim()).filter(Boolean));

mkdirSync(DIR, { recursive: true });
const saltFile = join(DIR, "salt");
if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(24).toString("hex"), { mode: 0o600 });
const SALT = readFileSync(saltFile, "utf8").trim();

const db = new DatabaseSync(join(DIR, "thoughts.db"));
db.exec(`CREATE TABLE IF NOT EXISTS thoughts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  emo TEXT NOT NULL,
  ticker TEXT,
  who TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS thoughts_ts ON thoughts (ts);`);

// Statements are prepared per call: node:sqlite finalises long-held ones, and at this
// volume preparing is free.
const sql = {
  insert: "INSERT INTO thoughts (ts, text, emo, ticker, who) VALUES (?, ?, ?, ?, ?)",
  last:   "SELECT ts FROM thoughts WHERE who = ? ORDER BY id DESC LIMIT 1",
  today:  "SELECT COUNT(*) n FROM thoughts WHERE who = ? AND ts > ?",
  dupe:   "SELECT id FROM thoughts WHERE text = ? AND ts > ? LIMIT 1",
  recent: "SELECT id, ts, text, emo, ticker FROM thoughts WHERE id > ? ORDER BY id DESC LIMIT ?",
  count:  "SELECT COUNT(*) n FROM thoughts",
  days:   "SELECT id, ts, text FROM thoughts WHERE ts > ? ORDER BY id",
  since:  "SELECT COUNT(*) n FROM thoughts WHERE ts > ?",
  bySym:  "SELECT ticker, emo, COUNT(*) n FROM thoughts WHERE ts > ? AND ticker IS NOT NULL GROUP BY ticker, emo"
};
const get = (k, ...a) => db.prepare(sql[k]).get(...a);
const all = (k, ...a) => db.prepare(sql[k]).all(...a);
const run = (k, ...a) => db.prepare(sql[k]).run(...a);

// Same reading the page used to do on its own, moved here so every visitor's thought is
// filed the same way and the answer comes from one place.
const KW = {
  FEAR:  ["zero","crash","dump","scared","fear","top","bubble","rekt","sold","sell","ugly","dying","red","bear","panic","afraid","out"],
  GREED: ["moon","send","pump","100x","printing","buy","bought","loading","leverage","rich","melt","ath","bull","2k"],
  FOMO:  ["missed","everyone","late","regret","fomo","aping","ape","sidelines","barber","chasing","left behind"],
  HOPIUM:["recover","bottom","soon","trust","one day","undervalued","bounce","believe","resting","will"],
  COPE:  ["long term","fine","holding","unrealized","zoom","stuck","value investor","not selling","okay","cope"]
};
const LOBE = { GREED:"frontal", FOMO:"parietal", FEAR:"temporal", HOPIUM:"occipital", COPE:"cerebellum" };
const ABUSE = /\b(fuck\w*|shit\w*|bitch\w*|retard\w*|cunt\w*|nigg\w*|fag\w*|whore\w*|kill yourself|kys)\b/i;

// Which token a thought is about. The list changes as the chain does, so it is read from the
// file the site is served from rather than written in here. If it cannot be read, thoughts
// simply carry no ticker. It has to cover every symbol the page can pair - the trending ten
// it actually shows first, then the market-cap ten, then the wider universe the chain reader
// walks - or a visitor naming a coin that is on screen still gets filed under no ticker.
const CHAIN_FILE = process.env.CHAIN_FILE ?? "/var/www/brain/chain-data.js";
// Symbols that are also ordinary words need their cashtag, or "this is all ai hype" would be
// filed under a token called AI.
const NEEDS_TAG = /^(ai|meme|index|net|up|cat|dog|one|all|it|is|new|the|top|buy|sell)$/i;
let TOKENS = [], tokensAt = 0;

function tokens() {
  if (Date.now() - tokensAt < 600_000) return TOKENS;
  tokensAt = Date.now();
  try {
    const raw = readFileSync(CHAIN_FILE, "utf8");
    const json = raw.slice(raw.indexOf("{", raw.indexOf("CHAIN_READ")));
    const d = JSON.parse(json.replace(/;\s*$/, ""));
    TOKENS = [...new Set([...(d.trending ?? []), ...(d.tokens ?? []), ...(d.universe ?? [])]
      .map(t => t.symbol).filter(Boolean))];
  } catch { /* keep whatever we had */ }
  return TOKENS;
}

function tickerOf(text) {
  for (const sym of tokens()) {
    const s = sym.replace(/[^A-Za-z0-9]/g, "");
    if (!s) continue;
    const tagged = new RegExp("\\$" + s + "\\b", "i");
    if (tagged.test(text)) return sym;
    if (NEEDS_TAG.test(s)) continue;
    if (new RegExp("\\b" + s + "\\b", "i").test(text)) return sym;
  }
  return null;
}

// Keywords match as whole words, not substrings: with plain includes() "layout" read as "out"
// (fear), "stop" as "top", "paper" as "ape" - a sentence with no view at all came back with
// one, and the card has no way to tell it was invented.
const KW_RE = Object.fromEntries(Object.entries(KW).map(([e, words]) =>
  [e, words.map(w => ({ w, re: new RegExp("(^|[^a-z0-9])" + w + "($|[^a-z0-9])") }))]));   // keywords are plain words and phrases, nothing to escape
function classify(text) {
  const t = text.toLowerCase();
  let best = "COPE", score = 0;
  for (const e of Object.keys(KW_RE)) {
    let s = 0;
    for (const { w, re } of KW_RE[e]) if (re.test(t)) s += w.length > 4 ? 2 : 1;
    if (s > score) { score = s; best = e; }
  }
  return { emo: best, ticker: tickerOf(text), hits: score };
}

const whoOf = req => createHash("sha256")
  .update(SALT + "|" + (req.headers["x-real-ip"] || req.socket.remoteAddress || "?"))
  .digest("hex").slice(0, 16);

const send = (res, code, body) => {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  let n = 0, chunks = "";
  req.on("data", c => { n += c.length; if (n > 4096) { reject(new Error("too big")); req.destroy(); } chunks += c; });
  req.on("end", () => resolve(chunks));
  req.on("error", reject);
});

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/thoughts") {
    const after = Number(url.searchParams.get("after") ?? 0) || 0;
    const limit = Math.min(50, Number(url.searchParams.get("limit") ?? 20) || 20);
    return send(res, 200, { thoughts: all("recent", after, limit) });
  }

  // What it remembers, day by day. The digest is taken over that day's thoughts in the order
  // they arrived: change one word of one of them and it stops matching.
  if (req.method === "GET" && url.pathname === "/api/days") {
    const rows = all("days", Date.now() - 14 * 86_400_000);
    const byDay = new Map();
    for (const r of rows) {
      const d = new Date(r.ts).toISOString().slice(0, 10);
      (byDay.get(d) ?? byDay.set(d, []).get(d)).push(r);
    }
    const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7).map(([date, list]) => ({
      date,
      count: list.length,
      digest: createHash("sha256").update(list.map(r => r.id + "|" + r.text).join("\n")).digest("hex")
    }));
    return send(res, 200, { days });
  }

  // What the people who came to the page think, per coin - the third side, next to what X
  // says and what the wallets did. Direction comes from the same five states a thought is
  // already filed under, so nothing new is inferred here: greed, FOMO and hopium lean up,
  // fear and cope lean down. The window is the same 24h the social read uses; pairing a
  // week of opinions with an hour of trading would be two windows called one.
  //
  // `n` is returned per coin on purpose. At this volume most coins will have one or two
  // statements, and a bar drawn from two statements is a made-up signal - the caller is
  // expected to show the count instead until there are enough.
  if (req.method === "GET" && url.pathname === "/api/sentiment") {
    const UP = { GREED: 1, FOMO: 1, HOPIUM: 1 }, DOWN = { FEAR: 1, COPE: 1 };
    const tickers = {};
    let bull = 0, bear = 0;
    for (const r of all("bySym", Date.now() - 86_400_000)) {
      const t = tickers[r.ticker] ??= { bull: 0, bear: 0, n: 0 };
      if (UP[r.emo]) { t.bull += r.n; bull += r.n; }
      else if (DOWN[r.emo]) { t.bear += r.n; bear += r.n; }
      t.n += r.n;
    }
    return send(res, 200, { windowHours: 24, mood: { bull, bear }, tickers });
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    return send(res, 200, {
      neurons: get("count").n,
      today: get("since", Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z")).n
    });
  }

  if (req.method === "POST" && url.pathname === "/api/thought") {
    let text;
    try { text = String(JSON.parse(await readBody(req)).text ?? "").replace(/\s+/g, " ").trim(); }
    catch { return send(res, 400, { error: "bad request" }); }

    if (text.length < MIN_LEN) return send(res, 400, { error: "too short" });
    if (text.length > MAX_LEN) return send(res, 400, { error: "too long" });
    if (/https?:\/\/|www\./i.test(text)) return send(res, 400, { error: "no links" });
    if (ABUSE.test(text)) return send(res, 400, { error: "not that" });

    const who = whoOf(req), now = Date.now();
    if (get("dupe", text, now - 3_600_000)) return send(res, 409, { error: "already said" });
    const ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress || "");
    if (!FEED_ALLOW.has(ip)) {
      const last = get("last", who);
      if (last && now - last.ts < GAP_MS) return send(res, 429, { error: "wait", retryIn: Math.ceil((GAP_MS - (now - last.ts)) / 1000) });
      if (get("today", who, now - 86_400_000).n >= PER_DAY) return send(res, 429, { error: "enough for today" });
    }

    const { emo, ticker, hits } = classify(text);
    const { lastInsertRowid } = run("insert", now, text, emo, ticker, who);
    return send(res, 200, { ok: true, id: Number(lastInsertRowid), ts: now, text, emo, ticker, lobe: LOBE[emo],
      signal: hits > 0, neurons: get("count").n });
  }

  send(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`thought intake on 127.0.0.1:${PORT}, data in ${DIR}`));
