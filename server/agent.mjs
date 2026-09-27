// Agent access: who may open /agent, and what it can read once open.
//
// Sign-in is a wallet signature, nothing else: the page asks for a nonce, the wallet signs a
// short message with it, this checks the signature and the address against the list of
// wallets that may enter. No transaction, no gas, nothing stored about the visitor beyond
// the session cookie they carry.
//
// Who may enter, for now: the addresses in /var/lib/brain/agent-allow (one per line, # for
// comments) plus AGENT_ALLOW in the environment. The file is re-read on every check, so
// editing it takes effect at once, and removing an address ends its sessions and keys the
// next time they are used. The token balance check comes here later: same function, one
// more condition.
//
// The session is a signed cookie and nothing else: no API key, nothing to copy out of the
// page and hand around. The cookie is checked against the allow list on every use.

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { createRequire } from "module";
import { readTicker } from "./read.mjs";
import { holdingGate } from "./holding.mjs";

const COOKIE = "medusa_agent";
const SESSION_DAYS = 7;
const NONCE_MS = 5 * 60_000;
// a Solana address: base58, case-sensitive, so it is never lowercased anywhere below
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function agentRoutes({ dataDir, chainFile, stats }) {
  const SITE = dirname(chainFile);                      // /var/www/brain
  const API_DIR = join(SITE, "api", "v1");              // written by scripts/build-api.mjs
  const ALLOW_FILE = join(dataDir, "agent-allow");
  const TOKEN_FILE = join(dataDir, "agent-token.json"); // the $MEDUSA token, once it exists

  const secretFile = join(dataDir, "agent-secret");
  if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const SECRET = readFileSync(secretFile, "utf8").trim();
  if (!existsSync(ALLOW_FILE)) writeFileSync(ALLOW_FILE, "# wallets that may open /agent, one per line\n", { mode: 0o600 });

  // tweetnacl does the signature maths (ed25519, what every Solana wallet signs with). The
  // service may run from a folder without its own node_modules, so fall back to the site's
  // copy next to chain-data.js.
  const libsP = Promise.all([import("tweetnacl"), import("bs58")]).then(([n, b]) => ({ nacl: n.default || n, bs58: b.default || b })).catch(() => {
    const req = createRequire(join(SITE, "package.json"));
    return { nacl: req("tweetnacl"), bs58: req("bs58").default || req("bs58") };
  });

  const b64 = b => Buffer.from(b).toString("base64url");
  const unb64 = s => Buffer.from(s, "base64url").toString("utf8");
  const mac = s => createHmac("sha256", SECRET).update(s).digest("base64url");
  const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  function allowed(addr) {
    const set = new Set(String(process.env.AGENT_ALLOW ?? "").split(",").map(x => x.trim()).filter(Boolean));
    try {
      for (const line of readFileSync(ALLOW_FILE, "utf8").split("\n")) {
        const a = line.split("#")[0].trim();
        if (a === "*") return true;
        if (ADDR.test(a)) set.add(a);
      }
    } catch { /* no file, no one */ }
    return set.has(addr);
  }

  // ---- sessions: v1.<payload>.<mac>, payload = {a: address, e: expiry ms} ----
  const issue = addr => { const p = b64(JSON.stringify({ a: addr, e: Date.now() + SESSION_DAYS * 86_400_000 })); return "v1." + p + "." + mac("s|" + p); };
  // A seat is the allow list (team, friends, top players) OR enough of the token in the
  // wallet: minUsd to enter, keepUsd to stay (server/holding.mjs). With no token address
  // on file only the list seats anyone.
  const holding = holdingGate({ dataDir });
  // Any wallet that signs may sit down. What the holding decides is the day's free reads:
  // one for everyone, more for a holder (server/holding.mjs, minUsd line). The allow list
  // counts as a holder (team, top players). A read checks the balance afresh.
  async function tierOf(addr, fresh = false) {
    if (allowed(addr)) return { holder: true, via: "list", holding: null };
    const h = await holding(addr, { entering: true, fresh });
    if (!h) return { holder: false, via: "none", holding: null };
    return { holder: !!h.ok, via: "holding", holding: h };
  }
  async function session(req) {
    const m = /(?:^|;\s*)medusa_agent=([^;]+)/.exec(req.headers.cookie || "");
    if (!m) return null;
    const [v, p, sig] = m[1].split(".");
    if (v !== "v1" || !p || !sig || !same(sig, mac("s|" + p))) return null;
    try { const { a, e } = JSON.parse(unb64(p)); if (e > Date.now() && ADDR.test(a)) return a; } catch { /* fall through */ }
    return null;
  }
  const who = req => session(req);

  const cookie = (val, maxAge) => `${COOKIE}=${val}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  const send = (res, code, body, extra = {}) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  };

  // ---- nonces: one per sign-in attempt, five minutes, used once ----
  const nonces = new Map();
  const sweep = () => { const now = Date.now(); for (const [k, t] of nonces) if (now - t > NONCE_MS) nonces.delete(k); };
  const messageFor = (addr, nonce, issued) =>
    `medusa.cash wants you to sign in with your wallet.\n\n` +
    `Address: ${addr}\nNonce: ${nonce}\nIssued: ${issued}\n\n` +
    `Purpose: open the MEDUSA agent. This is a signature, not a transaction. No gas.`;

  // ---- what the seat can read ----
  const file = name => { try { return JSON.parse(readFileSync(join(API_DIR, name), "utf8")); } catch { return null; } };
  const liveChain = () => {
    try {
      const raw = readFileSync(join(SITE, "chain-live.js"), "utf8");
      return JSON.parse(raw.slice(raw.indexOf("{")).replace(/;\s*$/, ""));
    } catch { return null; }
  };
  const tokenInfo = () => { try { const j = JSON.parse(readFileSync(TOKEN_FILE, "utf8")); return { address: j.address || null, symbol: j.symbol || "MEDUSA", minUsd: j.minUsd ?? 10, keepUsd: j.keepUsd ?? 7 }; } catch { return { address: null, symbol: "MEDUSA", minUsd: 10, keepUsd: 7, status: "not launched yet" }; } };

  function tokenLookup(sym) {
    const S = sym.toUpperCase();
    const eq = t => String(t.symbol || "").toUpperCase() === S;
    const chain = (file("chain")?.tokens || []).find(eq) || (liveChain()?.tokens || []).find(eq) || null;
    const verdict = (file("verdicts")?.verdicts || []).find(eq) || null;
    const daily = file("daily");
    const social = daily?.tickers?.[S] || daily?.tickers?.[sym] || null;
    const posts = (daily?.posts || []).filter(p => String(p.ticker || "").toUpperCase() === S).slice(0, 5);
    if (!chain && !verdict && !social) return null;
    return { symbol: chain?.symbol || verdict?.symbol || S, chain, verdict, social, posts };
  }

  // One ticker on demand (server/read.mjs). The X side costs money per read, so a symbol is
  // cached for ten minutes, one read at a time per symbol, and a seat gets a fixed number
  // of fresh reads an hour - the page shows the cached one instantly either way.
  const READ_TTL = 10 * 60_000, READ_PER_HOUR = 30;
  const FREE_PER_DAY = Number(process.env.AGENT_FREE_READS ?? 1);          // everyone who signs in
  const HOLDER_EXTRA = Number(process.env.AGENT_HOLDER_READS ?? 5);        // on top, for a holder
  // No ceiling on the house key across wallets (owner, 2026-09-24: the number of users is
  // unknown, five a wallet is the only limit). AGENT_HOUSE_READS=N brings one back.
  const HOUSE_PER_DAY = Number(process.env.AGENT_HOUSE_READS) > 0 ? Number(process.env.AGENT_HOUSE_READS) : Infinity;
  const reads = new Map(), inflight = new Map(), pace = new Map();

  // Five fresh reads a day on the house key, per wallet; after that the visitor's own
  // twitterapi.io key rides along in a header for that one request and is never written
  // anywhere. Cached reads and "which one?" answers are free and do not count.
  const QUOTA_FILE = join(dataDir, "quota.json");
  let quota = {};
  try { quota = JSON.parse(readFileSync(QUOTA_FILE, "utf8")); } catch { /* fresh */ }
  const today = () => new Date().toISOString().slice(0, 10);
  const usedToday = a => { const q = quota[a]; return q && q.day === today() ? q.n : 0; };
  const houseUsed = () => { const h = quota._house; return h && h.day === today() ? h.n : 0; };
  const save = () => { try { writeFileSync(QUOTA_FILE, JSON.stringify(quota)); } catch { /* memory still counts */ } };
  const bump = a => { quota[a] = { day: today(), n: usedToday(a) + 1 }; save(); };
  const freeFor = tier => FREE_PER_DAY + (tier && tier.holder ? HOLDER_EXTRA : 0);
  const quotaOf = (a, tier) => { const free = freeFor(tier); return { free, base: FREE_PER_DAY, extra: HOLDER_EXTRA, holder: !!(tier && tier.holder), via: tier ? tier.via : "none",
    used: usedToday(a), left: Math.max(0, free - usedToday(a)), resets: today() + "T23:59:59Z",
    holding: tier && tier.holding ? { usd: tier.holding.usd, balance: tier.holding.balance, need: tier.holding.need, symbol: tier.holding.symbol, buy: tier.holding.buy } : null }; };

  // Reservations are taken BEFORE the read starts, not after it lands: with the count made
  // afterwards, a burst of parallel requests all passed the check at once and every one of
  // them ran on the house key. A reservation is given back when nothing was read (a "which
  // one?" answer, a token not found, a failure before X was asked).
  const houseBump = d => { quota._house = { day: today(), n: Math.max(0, houseUsed() + d) }; save(); };
  const unbump = a => { quota[a] = { day: today(), n: Math.max(0, usedToday(a) - 1) }; save(); };

  async function readCached(q, addr, xKey) {
    const key = q.toLowerCase();
    const tier = await tierOf(addr, true);                 // the balance, fresh from the chain
    const hit = reads.get(key);
    if (hit && Date.now() - hit.at < READ_TTL) return { ...hit.result, cached: true, cachedAt: new Date(hit.at).toISOString(), quota: quotaOf(addr, tier) };
    if (inflight.has(key)) return inflight.get(key);
    // the hour's pace, reserved now
    const stamps = (pace.get(addr) || []).filter(t => Date.now() - t < 3_600_000);
    if (stamps.length >= READ_PER_HOUR) { const e = new Error("that is enough fresh reads for this hour"); e.code = 429; throw e; }
    const stamp = Date.now(); stamps.push(stamp); pace.set(addr, stamps);
    const unpace = () => { const l = pace.get(addr) || []; const i = l.indexOf(stamp); if (i >= 0) l.splice(i, 1); };
    // the day's free reads, reserved now; the house has a ceiling of its own
    const free = freeFor(tier);
    const onHouse = usedToday(addr) < free && houseUsed() < HOUSE_PER_DAY;
    if (!onHouse && !xKey) {
      unpace();
      const e = new Error(usedToday(addr) < free ? "the free reads are spent for today, everyone's" : (tier.holder ? "your " + free + " free reads for today are used" : "your free read for today is used; holders get " + (FREE_PER_DAY + HOLDER_EXTRA) + " a day"));
      e.code = 402; e.quota = quotaOf(addr, tier); throw e;
    }
    if (onHouse) { bump(addr); houseBump(1); }
    const refund = () => { unpace(); if (onHouse) { unbump(addr); houseBump(-1); } };
    const p = readTicker(q, { site: SITE, dataDir, xKey: onHouse ? null : xKey }).then(result => {
      if (result && !result.choose) { reads.set(key, { at: Date.now(), result }); return { ...result, quota: quotaOf(addr, tier) }; }
      refund();                                            // nothing was read, nothing is owed
      return result;
    }).catch(e => {
      if (!e.spent) refund();                              // X was never asked (bad key, chain lookup failed)
      if (e.code === "KEY") { e.code = 402; e.quota = quotaOf(addr, tier); }
      throw e;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // Returns true when the request was one of ours.
  return async function handle(req, res, url, readBody) {
    const p = url.pathname;
    if (!p.startsWith("/api/agent/")) return false;
    const path = p.slice("/api/agent".length);

    if (req.method === "GET" && path === "/nonce") {
      sweep();
      if (nonces.size > 5000) { const oldest = nonces.keys().next().value; nonces.delete(oldest); }   // a flood of nonces evicts the oldest, never grows memory
      const nonce = randomBytes(12).toString("hex"), issued = new Date().toISOString();
      nonces.set(nonce, Date.now());
      return send(res, 200, { nonce, issued }), true;
    }

    if (req.method === "POST" && path === "/verify") {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "bad request" }), true; }
      const addr = String(body.address || ""), { nonce, issued, signature } = body;
      if (!ADDR.test(addr) || typeof signature !== "string" || !nonces.has(nonce)) return send(res, 400, { error: "bad sign-in" }), true;
      if (Date.now() - nonces.get(nonce) > NONCE_MS) { nonces.delete(nonce); return send(res, 400, { error: "expired, try again" }), true; }
      nonces.delete(nonce);
      let ok = false;
      try {
        const { nacl, bs58 } = await libsP;
        const pk = bs58.decode(addr), sig = bs58.decode(signature);   // the page sends the signature in base58
        ok = pk.length === 32 && sig.length === 64 && nacl.sign.detached.verify(new TextEncoder().encode(messageFor(addr, nonce, issued)), sig, pk);
      }
      catch (e) { console.error("agent verify:", e.message); return send(res, 503, { error: "signature check unavailable" }), true; }
      if (!ok) return send(res, 401, { error: "signature does not match" }), true;
      const tier = await tierOf(addr, true);
      return send(res, 200, { ok: true, address: addr, days: SESSION_DAYS, via: tier.via, holder: tier.holder, holding: tier.holding, quota: quotaOf(addr, tier) }, { "set-cookie": cookie(issue(addr), SESSION_DAYS * 86_400) }), true;
    }

    if (req.method === "POST" && path === "/logout") return send(res, 200, { ok: true }, { "set-cookie": cookie("", 0) }), true;

    // everything below needs a seat
    const addr = await who(req);
    if (!addr) return send(res, 401, { error: "sign in with your wallet" }), true;

    if (req.method === "GET" && path === "/me") { const tier = await tierOf(addr); return send(res, 200, { address: addr, token: tokenInfo(), holder: tier.holder, via: tier.via, quota: quotaOf(addr, tier) }), true; }
    if (req.method === "GET" && path === "/token") return send(res, 200, tokenInfo()), true;

    const m = /^\/v1\/([a-z]+)(?:\/([A-Za-z0-9$._-]{1,44}))?$/.exec(path);
    if (req.method === "GET" && m) {
      const [, name, arg] = m;
      const cors = {};
      if (name === "read" && arg) {
        const xKey = String(req.headers["x-twitter-key"] || "").trim().slice(0, 128) || null;
        try {
          const r = await readCached(arg.replace(/^\$/, ""), addr, xKey);
          return send(res, r ? 200 : 404, r || { error: "not found on Solana", query: arg }, cors), true;
        } catch (e) { return send(res, e.code === 429 ? 429 : e.code === 402 ? 402 : 502, { error: e.message, needKey: e.code === 402, quota: e.quota }, cors), true; }
      }
      if (name === "stats") return send(res, 200, await stats(), cors), true;
      if (name === "live") { const l = liveChain(); return send(res, l ? 200 : 404, l || { error: "no live read yet" }, cors), true; }
      if (name === "token" && arg) { const t = tokenLookup(arg.replace(/^\$/, "")); return send(res, t ? 200 : 404, t || { error: "not on the board", symbol: arg }, cors), true; }
      if (["chain", "verdicts", "daily", "index"].includes(name) && !arg) {
        const j = file(name);
        if (!j) return send(res, 404, { error: "not written yet" }, cors), true;
        if (name === "index") {
          j.auth = "wallet session";
          j.docs = "https://medusa.cash/agent";
          j.endpoints = Object.fromEntries(["chain", "verdicts", "daily", "stats", "live", "token/{SYMBOL}", "read/{SYMBOL}"].map(e => [e.split("/")[0], "https://medusa.cash/api/agent/v1/" + e]));
        }
        return send(res, 200, j, cors), true;
      }
    }
    return send(res, 404, { error: "not found" }), true;
  };
}
