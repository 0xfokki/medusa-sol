-- Wallet card: the rest of what GMGN wallet_stats returns (holding period, PnL
-- buckets, tags, first-funding time, created tokens...) kept as one jsonb blob
-- so the card's behaviour badges never need a second GMGN call.
-- Applied to production 2026-09-23 via the Supabase management API.
alter table public.sol_medusa_players add column if not exists wallet_extra jsonb;
