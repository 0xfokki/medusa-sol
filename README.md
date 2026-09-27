# MEDUSA (Solana)

A lie detector for the crowd. MEDUSA reads what retail says about Solana
memecoins on X against what wallets actually do on-chain, and scores where
words and money agree or split.

- **Site:** https://medusa.cash
- **Agent:** https://medusa.cash/agent (sign in with a Solana wallet, read any coin)
- **Game:** https://game.medusa.cash (folder `game/`)

## How it reads

| Piece | What it does |
|---|---|
| `scripts/pull-chain.mjs` | Picks the trending ten and a small universe from DexScreener and pump.fun feeds |
| `scripts/read-chain.mjs` | Walks the last hour of every coin's pool through Helius: net token-balance change per wallet per transaction, programs dropped |
| `scripts/solana.mjs` | Shared Helius helpers: signatures, parsed transactions, wallet-vs-program, SPL balances, cache |
| `scripts/pull-daily.mjs` | X posts about the trending ten (twitterapi.io), plus crypto news headlines |
| `scripts/sample-read.mjs` | One full read of a single coin for the front page (Backpack by default) |
| `server/agent-server.mjs` | The agent seat: Solana wallet sign-in (ed25519), daily read quota, reads on demand |

The verdict: `((buyers − sellers) / wallets + (bull − bear) / posts) / 2 × 100`.

## Run

```
npm install
HELIUS_KEY=... node scripts/pull-chain.mjs     # NO_BROWSER=1 on a server
HELIUS_KEY=... node scripts/read-chain.mjs 60
```

Keys live outside git: `.helius-key` (Helius) and `.x-key` (twitterapi.io), or the
`HELIUS_KEY` / `TWITTERAPI_KEY` environment variables. Solana addresses are
case-sensitive and up to 44 characters.

MIT license.
