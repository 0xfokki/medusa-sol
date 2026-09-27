# MEDUSA game (Solana)

Six jellyfish, six Solana memecoins. Pick one, call UP or DOWN before its
hour-long round ends, earn points. Live at https://game.medusa.cash.

```
score = lifetime_points   (resolved prediction wins)
      + wallet grade      (one-off bonus from the wallet's Solana history, via GMGN)
      + referral_points   (100 per referral + 20% of what they earn)
```

- `index.html` is the whole client, no build step.
- `admin.html` is a password-gated page for adding mints to the round pool.
- `api/*.js` are Vercel serverless functions. Prices come from DexScreener's
  keyless API, SOL in dollars from Coinbase spot.
- `api/card.js`, `api/og.js` render the shareable wallet card at `/w/<wallet>`.
- Supabase (Postgres) holds players, predictions, rounds, referrals and the token
  pool. Tables and functions carry a `sol_` prefix so they can share a project
  with another build. Schema: `supabase/SOL-ALL-IN-ONE.sql` (idempotent, run in
  the SQL editor).

Deploy: `vercel --prod` from this folder (project `medusa-sol`). Environment
variables are listed in `.env.example`.

Solana addresses are base58 and case-sensitive: never lowercase a wallet or a mint.
