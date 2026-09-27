// Solana through Helius: the pieces every reader here shares.
//
//   tradesOf()      the last N minutes of wallets buying and selling one pump.fun coin
//                   against its bonding curve, netted per wallet per transaction
//   walletKinds()   which of those accounts are plain wallets (owned by the System
//                   Program) rather than programs' accounts - the EVM build asked for
//                   bytecode; here the owner of the account says the same thing
//   splBalance()    how much of a mint a wallet holds (the holder line on the seat)
//   solPriceUsd()   SOL in dollars, for turning lamports into money
//
// Costs, because Helius meters everything: one RPC call per 1000 signatures, one parse
// call per 100 transactions. Failed transactions (pump.fun has more of those than
// successful ones - bots racing) are dropped before anything is parsed. Every parsed
// transaction is kept in a cache file for a day, so the next pass only pays for what
// happened since. CHAIN.sigCap bounds what one coin may cost per pass: past it the read
// covers the last `cap` trades rather than the whole window and says so (`capped`).

import { readFileSync, writeFileSync, existsSync } from "fs";
import { CHAIN } from "./chains.mjs";

export const isAddress = s => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- transport ---------- */
export async function rpc(method, params, { tries = 3 } = {}) {
  if (!CHAIN.heliusKey()) throw new Error("no Helius key (HELIUS_KEY or .helius-key)");
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(CHAIN.rpc(), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(40_000) });
      if (r.status === 429) { last = new Error("helius 429"); await sleep(600 * (i + 1)); continue; }
      const j = await r.json();
      if (j.error) throw new Error("rpc " + method + ": " + (j.error.message || JSON.stringify(j.error)));
      return j.result;
    } catch (e) { last = e; await sleep(300 * (i + 1)); }
  }
  throw last;
}

// Helius' parsed form of up to 100 transactions per call: who moved what to whom.
export async function parseTransactions(sigs) {
  const out = [];
  for (let i = 0; i < sigs.length; i += 100) {
    const batch = sigs.slice(i, i + 100);
    let last;
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(CHAIN.parseUrl(), { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ transactions: batch }), signal: AbortSignal.timeout(60_000) });
        if (r.status === 429) { last = new Error("helius 429"); await sleep(800 * (t + 1)); continue; }
        if (!r.ok) throw new Error("helius parse " + r.status);
        const arr = await r.json();
        if (!Array.isArray(arr)) throw new Error("helius parse: " + JSON.stringify(arr).slice(0, 120));
        out.push(...arr);
        last = null; break;
      } catch (e) { last = e; await sleep(400 * (t + 1)); }
    }
    if (last) throw last;
    if (i + 100 < sigs.length) await sleep(150);        // the free tier is ten requests a second
  }
  return out;
}

/* ---------- the cache: parsed trades per curve, wallet kinds ---------- */
// { curves: { [curve]: { newest, txs: { [sig]: { ts, t: [[wallet, amount], ...] } } } }, wallets: { [addr]: bool } }
export function loadCache(file) {
  try { if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")); } catch { /* start clean */ }
  return { curves: {}, wallets: {} };
}
export function saveCache(file, cache, keepHours = 24) {
  const floor = Date.now() / 1000 - keepHours * 3600;
  for (const [curve, c] of Object.entries(cache.curves || {})) {
    for (const [sig, x] of Object.entries(c.txs || {})) if (x.ts < floor) delete c.txs[sig];
    if (!Object.keys(c.txs).length) delete cache.curves[curve];
  }
  try { writeFileSync(file, JSON.stringify(cache)); } catch { /* read-only is fine */ }
}

// One parsed transaction -> what each account ended up with, net, of this mint. Read off
// the token-balance changes, not the transfers: that is the same answer on every DEX
// (a pump.fun curve holds its own vault, Raydium's vaults belong to one shared authority,
// Orca's and Meteora's to the pool, Jupiter routes through hops) and a bot that buys and
// sells inside one transaction nets to nothing. The pool's own side is dropped here; the
// vault owners of the other DEXes are programs' accounts and walletKinds() drops those.
export function tradesInTx(tx, mint, pool) {
  const net = new Map();
  let seen = false;
  for (const a of tx.accountData || []) {
    for (const c of a.tokenBalanceChanges || []) {
      if (c.mint !== mint || !c.userAccount) continue;
      seen = true;
      if (c.userAccount === pool) continue;
      const v = Number(c.rawTokenAmount?.tokenAmount || 0) / 10 ** (c.rawTokenAmount?.decimals ?? 0);
      net.set(c.userAccount, (net.get(c.userAccount) ?? 0) + v);
    }
  }
  if (!seen) {                                           // older parse shape: fall back to the transfers
    for (const tt of tx.tokenTransfers || []) {
      if (tt.mint !== mint) continue;
      const amt = Number(tt.tokenAmount) || 0;
      if (tt.fromUserAccount === pool && tt.toUserAccount && tt.toUserAccount !== pool) net.set(tt.toUserAccount, (net.get(tt.toUserAccount) ?? 0) + amt);
      else if (tt.toUserAccount === pool && tt.fromUserAccount && tt.fromUserAccount !== pool) net.set(tt.fromUserAccount, (net.get(tt.fromUserAccount) ?? 0) - amt);
    }
  }
  return [...net].filter(([, v]) => Math.abs(v) > 1e-9);
}

// The last `minutes` of trades on one curve, from the cache plus whatever is new.
export async function tradesOf({ mint, curve, minutes = 60, cap = CHAIN.sigCap, cache }) {
  const now = Date.now() / 1000, since = now - minutes * 60;
  cache.curves ||= {};
  const c = cache.curves[curve] ||= { newest: null, txs: {} };
  let calls = 0, capped = false, before = null, done = false;
  const fresh = [];
  while (!done) {
    const params = { limit: CHAIN.sigPage };
    if (before) params.before = before;
    if (c.newest) params.until = c.newest;
    const list = await rpc("getSignaturesForAddress", [curve, params]); calls++;
    if (!list.length) break;
    for (const s of list) {
      if (s.blockTime && s.blockTime < since) { done = true; break; }
      if (s.err) continue;
      fresh.push(s);
      if (fresh.length >= cap) { capped = true; done = true; break; }
    }
    if (list.length < CHAIN.sigPage) break;
    before = list[list.length - 1].signature;
  }
  // capped: the new trades do not reach back to the cached ones, so the cached ones are
  // a different, older story - dropped rather than counted with a hole between
  if (capped) c.txs = {};
  let parsed = 0;
  if (fresh.length) {
    const txs = await parseTransactions(fresh.map(s => s.signature)); calls += Math.ceil(fresh.length / 100);
    const times = new Map(fresh.map(s => [s.signature, s.blockTime]));
    for (const tx of txs) {
      if (!tx || !tx.signature) continue;
      parsed++;
      c.txs[tx.signature] = { ts: tx.timestamp || times.get(tx.signature) || now, t: tradesInTx(tx, mint, curve) };
    }
    c.newest = fresh[0].signature;
  }
  const trades = [];
  let oldest = now;
  for (const [sig, x] of Object.entries(c.txs)) {
    if (x.ts < since) continue;
    if (x.ts < oldest) oldest = x.ts;
    for (const [wallet, amount] of x.t) trades.push({ sig, ts: x.ts, wallet, amount });
  }
  return { trades, calls, parsed, capped, covered: capped ? Math.max(1, Math.round((now - oldest) / 60)) : minutes };
}

// true = an ordinary wallet (System Program owns the account); false = a program's account
export async function walletKinds(addrs, cache) {
  cache.wallets ||= {};
  const todo = [...new Set(addrs)].filter(a => !(a in cache.wallets));
  let looked = 0;
  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    try {
      const r = await rpc("getMultipleAccounts", [batch, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
      batch.forEach((a, k) => { const v = r?.value?.[k]; cache.wallets[a] = !v || v.owner === CHAIN.systemProgram; looked++; });
    } catch { for (const a of batch) cache.wallets[a] = true; }   // unknown counts as a wallet
  }
  return { isWallet: a => cache.wallets[a] !== false, looked };
}

/* ---------- balances and prices ---------- */
export async function splBalance(mint, owner) {
  const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  let amount = 0, decimals = null;
  for (const v of r?.value || []) {
    const ta = v.account?.data?.parsed?.info?.tokenAmount;
    if (!ta) continue;
    amount += Number(ta.uiAmount || 0);
    decimals = ta.decimals ?? decimals;
  }
  return { amount, decimals };
}
export async function solBalance(owner) {
  const r = await rpc("getBalance", [owner]);
  return Number(r?.value ?? r ?? 0) / 1e9;
}

let sol = { at: 0, usd: null };
export async function solPriceUsd() {
  if (Date.now() - sol.at < 60_000 && sol.usd) return sol.usd;
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    const usd = Number((await r.json())?.data?.amount);
    if (usd > 0) { sol = { at: Date.now(), usd }; return usd; }
  } catch { /* the last one */ }
  return sol.usd;
}
