// Which chain this MEDUSA reads. This folder (brain-sol) is the Solana build: one chain,
// pump.fun's bonding curves, read through Helius. The Robinhood/Arc build lives in ../brain
// and is not touched by anything here.
//
//   node scripts/read-chain.mjs            (CHAIN defaults to solana here)
//
// On pump.fun every coin that has not "graduated" yet trades against ONE account, its
// bonding curve (DexScreener calls that account the pair address, dexId "pumpfun"). A
// trade is the coin moving between a wallet and that curve. Once the curve completes the
// coin moves to PumpSwap and this reader stops seeing it - by design for now.

import { readFileSync, existsSync } from "fs";

// The Helius key: HELIUS_KEY in the environment, else the .helius-key file next to
// package.json (not in git; on the server it is owned by www-data like .x-key).
function heliusKey() {
  if (process.env.HELIUS_KEY) return process.env.HELIUS_KEY.trim();
  const f = new URL("../.helius-key", import.meta.url);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

export const CHAINS = {
  solana: {
    key: "solana",
    kind: "solana",
    name: "Solana",
    short: "SOL",
    // Helius: RPC for balances and signatures, the enhanced API for parsed transactions
    heliusKey,
    rpc: () => "https://mainnet.helius-rpc.com/?api-key=" + heliusKey(),
    parseUrl: () => "https://api.helius.xyz/v0/transactions?api-key=" + heliusKey(),
    // the public node answers balance and account questions too; the walk never uses it
    rpcPublic: "https://api.mainnet-beta.solana.com",
    dexscreener: "solana",
    // every DEX on the chain, like the Robinhood board reads every pool (owner, 2026-09-26:
    // "давай читать монеты по аналогии с робингудом"); null = no dexId filter. A pump.fun
    // curve is one pool among them and is the only kind with no liquidity figure.
    dexIds: null,
    bonding: ["pumpfun"],
    explorer: "https://solscan.io",
    pumpProgram: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    pumpSite: "https://pump.fun",
    systemProgram: "11111111111111111111111111111111",
    wsol: "So11111111111111111111111111111111111111112",
    // The other half of every trade.
    quote: ["SOL", "WSOL", "USDC", "USDT"],
    // Stables, wrappers, bridged majors and liquid-staking tokens: the other half of trades,
    // not coins the chain made. Solana-born coins (BONK, WIF, JUP...) stay in.
    notOurs: /^(SOL|WSOL|USDC|USDT|USD1|PYUSD|USDS|USDe|DAI|WBTC|WETH|ETH|BTC|cbBTC|tBTC|mSOL|jitoSOL|bSOL|stSOL|jupSOL|INF|bnSOL)$/i,
    // in a post that already carries a cashtag, these words say it is the Solana one
    chainWord: /\b(solana|sol|pump\.?fun|pumpfun)\b/i,
    // a news headline has to say Solana itself
    newsWord: /\bsolana\b/i,
    homeTicker: "SOL",
    // the walk: how many signatures one token may cost per pass (Helius credits), and
    // how many are asked per RPC page
    sigCap: Number(process.env.SOL_SIG_CAP || 300),
    sigPage: 1000,
  },
};

const key = (process.env.CHAIN || "solana").toLowerCase();
if (!CHAINS[key]) throw new Error(`unknown CHAIN "${key}" — expected one of: ${Object.keys(CHAINS).join(", ")}`);
export const CHAIN = CHAINS[key];
