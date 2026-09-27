-- MEDUSA Solana game: run in the Supabase SQL editor of the same project (tables and functions carry the sol_ prefix)
-- MEDUSA — full database schema, exported directly from the live production
-- project on 2026-09-22. This is the exact current state (not a replay of
-- incremental history), safe to run once, top-to-bottom, on a brand-new empty
-- Supabase project.
--
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste all → Run.
-- (Or via the Supabase CLI / MCP `apply_migration` if your agent has it.)

-- ============================================================================
-- 1. sol_medusa_tokens — the admin-curated pool of memecoin contract addresses
-- ============================================================================
create table if not exists public.sol_medusa_tokens (
  id uuid primary key default gen_random_uuid(),
  address text not null unique,
  symbol text not null,
  name text not null,
  coin_glyph text not null default '●',
  created_at timestamptz not null default now()
);

alter table public.sol_medusa_tokens enable row level security;

drop policy if exists "Public read access" on public.sol_medusa_tokens;
create policy "Public read access"
on public.sol_medusa_tokens
for select
to anon, authenticated
using (true);

-- ============================================================================
-- 2. sol_medusa_players — one row per wallet: score, tier, on-chain grade, referrals
-- ============================================================================
create table if not exists public.sol_medusa_players (
  id uuid primary key default gen_random_uuid(),
  wallet text not null unique,
  twitter text,
  lifetime_points bigint not null default 0,
  total_calls integer not null default 0,
  correct_calls integer not null default 0,
  wallet_balance_native numeric,
  wallet_pnl_usd numeric,
  wallet_roi_pct numeric,
  wallet_winrate_pct numeric,
  wallet_trades integer,
  wallet_buys integer,
  wallet_sells integer,
  wallet_tokens_traded integer,
  wallet_analyzed_at timestamptz,
  wallet_grade text,
  tier text not null default 'BACTERIA',
  score bigint not null default 0,
  referral_code text unique,
  referral_points bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sol_medusa_players enable row level security;

drop policy if exists "Public read access" on public.sol_medusa_players;
create policy "Public read access"
on public.sol_medusa_players
for select
to anon, authenticated
using (true);

create index if not exists sol_medusa_players_score_idx on public.sol_medusa_players (score desc);

-- A twitter handle can only ever belong to one wallet (case-insensitive).
-- Multiple NULLs are allowed (twitter is optional) — a unique index on a
-- WHERE-filtered expression skips NULL rows automatically.
create unique index if not exists sol_medusa_players_twitter_unique_idx
on public.sol_medusa_players (lower(twitter))
where twitter is not null;

-- ============================================================================
-- 3. sol_medusa_predictions — one row per prediction a wallet makes on a round
-- ============================================================================
create table if not exists public.sol_medusa_predictions (
  id uuid primary key default gen_random_uuid(),
  wallet text not null,
  symbol text not null,
  direction text not null check (direction in ('up','down')),
  points bigint not null,
  start_price numeric not null,
  final_price numeric,
  status text not null default 'pending' check (status in ('pending','won','lost')),
  points_awarded bigint not null default 0,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  round_id uuid
);

alter table public.sol_medusa_predictions enable row level security;

drop policy if exists "Public read access" on public.sol_medusa_predictions;
create policy "Public read access"
on public.sol_medusa_predictions
for select
to anon, authenticated
using (true);

create index if not exists sol_medusa_predictions_wallet_idx on public.sol_medusa_predictions (wallet, created_at desc);
create index if not exists sol_medusa_predictions_round_idx on public.sol_medusa_predictions (round_id);

-- CRITICAL anti-exploit constraint: one prediction per wallet per round. Without
-- this, a wallet could bet BOTH directions on the same round (e.g. by reloading
-- the page, which resets local client state while the server round is still
-- live) — a guaranteed win regardless of outcome. Multiple NULLs allowed.
create unique index if not exists sol_medusa_predictions_wallet_round_unique_idx
on public.sol_medusa_predictions (wallet, round_id)
where round_id is not null;

-- ============================================================================
-- 4. sol_medusa_rounds — server-authoritative state for the 6 on-screen jellyfish
-- ============================================================================
create table if not exists public.sol_medusa_rounds (
  slot integer primary key check (slot >= 0 and slot < 6),
  round_id uuid not null default gen_random_uuid(),
  symbol text not null,
  name text not null,
  coin_glyph text not null default '●',
  address text,
  start_price numeric not null,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null
);

alter table public.sol_medusa_rounds enable row level security;

drop policy if exists "Public read access" on public.sol_medusa_rounds;
create policy "Public read access"
on public.sol_medusa_rounds
for select
to anon, authenticated
using (true);

-- ============================================================================
-- 5. sol_medusa_referrals — one row per (referred wallet), tracking who referred
--    them and how much royalty has already been paid out (see function below)
-- ============================================================================
create table if not exists public.sol_medusa_referrals (
  referred text primary key references public.sol_medusa_players(wallet),
  referrer text not null references public.sol_medusa_players(wallet),
  royalty_paid_out bigint not null default 0,
  created_at timestamptz not null default now()
);

alter table public.sol_medusa_referrals enable row level security;

drop policy if exists "Public read access" on public.sol_medusa_referrals;
create policy "Public read access"
on public.sol_medusa_referrals
for select
to anon, authenticated
using (true);

create index if not exists sol_medusa_referrals_referrer_idx on public.sol_medusa_referrals (referrer);

-- ============================================================================
-- 6. Security-definer functions — the ONLY way points/referrals get written.
--    All three are locked down to service_role only (never anon/authenticated),
--    so they can't be called directly from the browser — only from our own
--    /api/*.js serverless functions, which hold the service_role key server-side.
-- ============================================================================

-- Atomic, once-only: registers the referral edge and grants the one-time
-- 100pt signup bonus in a single transaction. The primary key on `referred`
-- makes double registration physically impossible (a second INSERT raises
-- unique_violation, caught below and turned into a clean `false` return).
create or replace function public.sol_register_referral(p_referred text, p_referrer text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_score bigint;
begin
  if p_referred = p_referrer or p_referred is null or p_referrer is null then
    return false;
  end if;
  if not exists (select 1 from sol_medusa_players where wallet = p_referrer) then
    return false;
  end if;
  begin
    insert into sol_medusa_referrals (referred, referrer) values (p_referred, p_referrer);
  exception when unique_violation then
    return false;
  end;
  update sol_medusa_players
    set referral_points = referral_points + 100,
        score = score + 100,
        updated_at = now()
    where wallet = p_referrer
    returning score into v_new_score;
  update sol_medusa_players set tier = case
    when v_new_score >= 30000 then 'MEGALODON'
    when v_new_score >= 15000 then 'WHALE'
    when v_new_score >= 8000 then 'SHARK'
    when v_new_score >= 4000 then 'DOLPHIN'
    when v_new_score >= 1500 then 'FISH'
    when v_new_score >= 600 then 'SHRIMP'
    when v_new_score >= 200 then 'PLANKTON'
    else 'BACTERIA' end
  where wallet = p_referrer;
  return true;
end;
$$;

revoke all on function public.sol_register_referral(text, text) from public, anon, authenticated;
grant execute on function public.sol_register_referral(text, text) to service_role;

-- Atomic royalty top-up: pays the referrer 20% of the referred wallet's
-- CURRENT lifetime (prediction) points, minus whatever has already been paid
-- out for this pair. `for update` row-locks the ledger row so concurrent
-- calls for the same referred wallet serialize — the second call always sees
-- the first's committed payout and correctly computes zero owed, making
-- double-crediting impossible even under concurrent traffic.
create or replace function public.sol_accrue_referral_royalty(p_referred text, p_rate numeric default 0.20)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer text;
  v_total bigint;
  v_paid bigint;
  v_owed bigint;
  v_new_score bigint;
begin
  select r.referrer, r.royalty_paid_out, p.lifetime_points
    into v_referrer, v_paid, v_total
  from sol_medusa_referrals r
  join sol_medusa_players p on p.wallet = r.referred
  where r.referred = p_referred
  for update of r;

  if v_referrer is null then
    return 0;
  end if;

  v_owed := floor(v_total * p_rate) - v_paid;
  if v_owed <= 0 then
    return 0;
  end if;

  update sol_medusa_referrals set royalty_paid_out = royalty_paid_out + v_owed where referred = p_referred;
  update sol_medusa_players
    set referral_points = referral_points + v_owed,
        score = score + v_owed,
        updated_at = now()
    where wallet = v_referrer
    returning score into v_new_score;
  update sol_medusa_players set tier = case
    when v_new_score >= 30000 then 'MEGALODON'
    when v_new_score >= 15000 then 'WHALE'
    when v_new_score >= 8000 then 'SHARK'
    when v_new_score >= 4000 then 'DOLPHIN'
    when v_new_score >= 1500 then 'FISH'
    when v_new_score >= 600 then 'SHRIMP'
    when v_new_score >= 200 then 'PLANKTON'
    else 'BACTERIA' end
  where wallet = v_referrer;

  return v_owed;
end;
$$;

revoke all on function public.sol_accrue_referral_royalty(text, numeric) from public, anon, authenticated;
grant execute on function public.sol_accrue_referral_royalty(text, numeric) to service_role;

-- Concurrency guard for round rollover: under load, many simultaneous
-- /api/rounds requests can notice the same expired slot at once. Without
-- this, every one of them would fire an Alchemy price lookup before only one
-- wins the final write — wasteful and rate-limit risky. This atomically
-- "claims" the slot (pushes ends_at 15s into the future) so only the caller
-- who wins the claim proceeds to do the expensive work; everyone else sees
-- the slot as still alive and moves on. If the claimant's price fetch fails,
-- the claim naturally expires in 15s and the next poller retries.
create or replace function public.sol_claim_round_rollover(p_slot integer, p_expected_ends_at timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_ends_at timestamptz;
begin
  update sol_medusa_rounds
  set ends_at = now() + interval '15 seconds'
  where slot = p_slot and ends_at = p_expected_ends_at
  returning ends_at into v_new_ends_at;
  return v_new_ends_at;
end;
$$;

revoke all on function public.sol_claim_round_rollover(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.sol_claim_round_rollover(integer, timestamptz) to service_role;

-- ============================================================================
-- Done. Verify with: select tablename from pg_tables where schemaname='public';
-- should list all 5 tables above. Then run the Supabase security advisor
-- (Dashboard → Advisors → Security) and confirm zero lints before moving on.
-- ============================================================================

-- Wallet card: the rest of what GMGN wallet_stats returns (holding period, PnL
-- buckets, tags, first-funding time, created tokens...) kept as one jsonb blob
-- so the card's behaviour badges never need a second GMGN call.
-- Applied to production 2026-09-23 via the Supabase management API.
alter table public.sol_medusa_players add column if not exists wallet_extra jsonb;
