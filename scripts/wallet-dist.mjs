// Where does a wallet sit among the wallets that actually trade on this chain?
//
// read-chain.mjs keeps every counterparty it has ever seen in .eoa-cache.json
// (true = a wallet, false = a contract). This script asks the public RPC for the
// native balance of every one of those wallets, keeps the answers in
// .wallet-balances.json (so a wallet only needs a fresh look once a day), and
// writes wallet-dist.json for the card renderer: quantiles of the balance
// distribution, tier thresholds derived from them, and the counts behind it.
//
//   CHAIN=robinhood node scripts/wallet-dist.mjs
//
// Reference set = wallets holding at least DUST (drained one-shot wallets are not
// competitors). Runs daily from cron; ~70k balances in batches of 100 take a couple
// of minutes against the public node.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CHAIN } from "./chains.mjs";

const RPC = CHAIN.rpc;
const EOA_CACHE = new URL(CHAIN.key === "robinhood" ? "../.eoa-cache.json" : `../.eoa-cache-${CHAIN.key}.json`, import.meta.url);
const BAL_CACHE = new URL(CHAIN.key === "robinhood" ? "../.wallet-balances.json" : `../.wallet-balances-${CHAIN.key}.json`, import.meta.url);
const OUT = new URL(CHAIN.key === "robinhood" ? "../wallet-dist.json" : `../wallet-dist-${CHAIN.key}.json`, import.meta.url);

const DUST = 0.001;                 // ETH; below this a wallet is treated as empty
const BATCH = 100;                  // JSON-RPC calls per HTTP request
const CONCURRENCY = 4;
const REFRESH_MS = 20 * 60 * 60 * 1000; // a balance older than this is looked up again

// tier = the smallest share of the reference set a wallet has to be in
const TIER_SHARE = [
  ["MEGALODON", 0.001],
  ["WHALE", 0.01],
  ["SHARK", 0.05],
  ["DOLPHIN", 0.15],
  ["FISH", 0.40],
  ["SHRIMP", 0.70],
  ["PLANKTON", 1.0],
];

const eoa = JSON.parse(readFileSync(EOA_CACHE, "utf8"));
const wallets = Object.keys(eoa).filter((a) => eoa[a] === true);
const cache = existsSync(BAL_CACHE) ? JSON.parse(readFileSync(BAL_CACHE, "utf8")) : {};
const now = Date.now();
const stale = wallets.filter((w) => !cache[w] || now - cache[w].t > REFRESH_MS);
console.log(`${wallets.length} wallets in the counterparty cache · ${stale.length} to (re)check`);

async function rpcBatch(addresses) {
  const body = addresses.map((a, i) => ({ jsonrpc: "2.0", id: i, method: "eth_getBalance", params: [a, "latest"] }));
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(40_000) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const out = await r.json();
      const byId = new Map((Array.isArray(out) ? out : [out]).map((x) => [x.id, x]));
      return addresses.map((a, i) => {
        const x = byId.get(i);
        if (!x || x.error || typeof x.result !== "string") return null;
        return Number(BigInt(x.result)) / 1e18;
      });
    } catch (e) {
      if (attempt === 4) { console.log(`  batch failed: ${e.message}`); return addresses.map(() => null); }
      await new Promise((res) => setTimeout(res, 1500 * attempt));
    }
  }
}

let done = 0, failed = 0;
const batches = [];
for (let i = 0; i < stale.length; i += BATCH) batches.push(stale.slice(i, i + BATCH));
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (batches.length) {
    const b = batches.shift();
    const res = await rpcBatch(b);
    b.forEach((a, i) => { if (res[i] === null) failed++; else cache[a] = { b: res[i], t: now }; });
    done += b.length;
    if (done % 5000 < BATCH) console.log(`  ${done}/${stale.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}));
writeFileSync(BAL_CACHE, JSON.stringify(cache));
console.log(`balances: ${Object.keys(cache).length} known · ${failed} lookups failed · ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ---- the distribution ----
const all = wallets.map((w) => cache[w]?.b).filter((b) => typeof b === "number");
const ref = all.filter((b) => b >= DUST).sort((a, b) => a - b);
const q = (p) => ref.length ? ref[Math.min(ref.length - 1, Math.floor(p * (ref.length - 1)))] : 0;
// 401 points, percentile 0 .. 100 in steps of .25, ascending: the renderer interpolates a
// wallet's percentile from these without needing the raw list
const curve = Array.from({ length: 401 }, (_, i) => +q(i / 400).toPrecision(5));
const tiers = {};
for (const [name, share] of TIER_SHARE) tiers[name] = name === "PLANKTON" ? DUST : +q(1 - share).toPrecision(5);
const dist = {
  chain: CHAIN.key,
  updatedAt: new Date().toISOString(),
  unit: "ETH",
  dust: DUST,
  wallets: all.length,
  reference: ref.length,
  quantiles: { p50: q(.5), p75: q(.75), p90: q(.9), p95: q(.95), p99: q(.99), p999: q(.999), max: ref.at(-1) || 0 },
  tiers,
  curve,
};
writeFileSync(OUT, JSON.stringify(dist));
console.log(`reference ${ref.length} wallets ≥ ${DUST} ETH of ${all.length} · p50 ${q(.5).toFixed(4)} · p90 ${q(.9).toFixed(3)} · p99 ${q(.99).toFixed(2)} · max ${(ref.at(-1) || 0).toFixed(1)} ETH`);
console.log("tiers (ETH):", Object.entries(tiers).map(([k, v]) => `${k} ≥ ${v}`).join(" · "));
