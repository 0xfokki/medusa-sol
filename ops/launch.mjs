// Launch day for MEDUSA on Solana: one command once the $MEDUSA mint exists.
//
//   cd /var/www/brain-sol && node ops/launch.mjs <MINT>          # check, then go live
//   cd /var/www/brain-sol && node ops/launch.mjs <MINT> --dry    # checks only, changes nothing
//   cd /var/www/brain-sol && node ops/launch.mjs --undo          # back to "no token yet"
//
// What it does, in order:
//   1. checks the mint on chain (Helius): it exists, it is an SPL / Token-2022 mint, its decimals
//   2. asks DexScreener and pump.fun whether the coin is listed yet (a warning, never a stop)
//   3. launch.js: writes the mint into `ca` - the CA strip with the pump.fun and DexScreener
//      buttons appears for everyone on medusa.cash and on game.medusa.cash (the game loads
//      medusa.cash/launch.js)
//   4. /var/lib/brain-agent-sol/agent-token.json: the holder line - $10 of $MEDUSA gets
//      6 reads a day instead of 1; the agent re-reads it within a minute, no restart
//   5. agent.html: the quota line names the token ("hold $10 of $MEDUSA for 6 a day")
//   6. prints what a stranger now sees
//
// Backups of every file it touches go to /root/launch-backup-<time>/ first.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, chownSync } from "fs";
import { execSync } from "child_process";

const SITE = "/var/www/brain-sol";
const TOKEN_FILE = "/var/lib/brain-agent-sol/agent-token.json";
const MIN_USD = 10, KEEP_USD = 10, SYMBOL = "MEDUSA";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_PROGRAMS = { TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token", TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022" };

const args = process.argv.slice(2);
const dry = args.includes("--dry"), undo = args.includes("--undo");
const mint = args.find(a => !a.startsWith("--"));
const say = (ok, msg) => console.log((ok === true ? "  ok   " : ok === false ? "  FAIL " : "  warn ") + msg);

const uid = 33, gid = 33;                               // www-data
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const BACKUP = `/root/launch-backup-${stamp}`;
function backup(file) {
  if (!existsSync(file)) return;
  mkdirSync(BACKUP, { recursive: true });
  copyFileSync(file, `${BACKUP}/${file.split("/").pop()}`);
}
function write(file, text, mode) {
  writeFileSync(file, text, mode ? { mode } : undefined);
  try { chownSync(file, uid, gid); } catch { /* not root: leave as is */ }
}

const LAUNCH = `${SITE}/launch.js`, AGENT = `${SITE}/agent.html`;
const QUOTA_OLD = "holders get <b>6 a day</b>";
const QUOTA_NEW = `hold $${MIN_USD} of $${SYMBOL} for <b>6 a day</b>`;

if (undo) {
  console.log("undo: back to no token");
  for (const f of [LAUNCH, AGENT, TOKEN_FILE]) backup(f);
  write(LAUNCH, readFileSync(LAUNCH, "utf8").replace(/ca: "[^"]*",/, 'ca: "",'));
  write(AGENT, readFileSync(AGENT, "utf8").split(QUOTA_NEW).join(QUOTA_OLD));
  execSync(`rm -f ${TOKEN_FILE}`);
  say(true, `launch.js ca emptied, agent-token.json removed, quota line reset (backups in ${BACKUP})`);
  process.exit(0);
}

if (!mint || !B58.test(mint)) { console.error("usage: node ops/launch.mjs <MINT> [--dry] | --undo"); process.exit(1); }
console.log(`${dry ? "DRY RUN - nothing is written\n" : ""}mint ${mint}\n\n1. on chain`);

// 1. the mint itself
const key = (process.env.HELIUS_KEY || readFileSync(`${SITE}/.helius-key`, "utf8")).trim();
const rpc = async (method, params) => {
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
};
let decimals = null;
try {
  const acc = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  if (!acc?.value) { say(false, "no account at this address - wrong CA?"); process.exit(1); }
  const prog = TOKEN_PROGRAMS[acc.value.owner];
  if (!prog || acc.value.data?.parsed?.type !== "mint") { say(false, `not a token mint (owner ${acc.value.owner})`); process.exit(1); }
  decimals = acc.value.data.parsed.info.decimals;
  say(true, `${prog} mint, ${decimals} decimals, supply ${Number(acc.value.data.parsed.info.supply) / 10 ** decimals}`);
} catch (e) { say(false, "Helius did not answer: " + e.message); process.exit(1); }

// 2. listings
console.log("\n2. listings");
try {
  const pairs = await (await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`)).json();
  const best = (Array.isArray(pairs) ? pairs : []).sort((a, b) => ((b.liquidity?.usd || 0) || (b.marketCap || 0) / 1e6) - ((a.liquidity?.usd || 0) || (a.marketCap || 0) / 1e6))[0];
  if (best) say(true, `DexScreener: $${best.baseToken.symbol} on ${best.dexId}, price $${best.priceUsd}, mcap $${Math.round(best.marketCap || 0).toLocaleString("en-US")}`);
  else say(null, "DexScreener has no pool yet - the holder line cannot price $MEDUSA until it does (everyone still gets 1 read); buttons still work");
} catch { say(null, "DexScreener did not answer"); }
try {
  const body = execSync(`curl -s -m 15 -A "Mozilla/5.0" "https://frontend-api-v3.pump.fun/coins/${mint}"`, { encoding: "utf8" });
  const c = JSON.parse(body);
  if (c && c.mint === mint) say(true, `pump.fun: $${c.symbol} "${c.name}"${c.complete ? ", graduated" : ", on the bonding curve"}`);
  else say(null, "pump.fun does not know this mint (fine if it launched elsewhere)");
} catch { say(null, "pump.fun did not answer (their API is flaky; not a blocker)"); }

if (dry) { console.log("\ndry run over - run again without --dry to go live"); process.exit(0); }

// 3-5. the switch
console.log("\n3. going live");
for (const f of [LAUNCH, AGENT, TOKEN_FILE]) backup(f);
const launch = readFileSync(LAUNCH, "utf8");
if (!/ca: "[^"]*",/.test(launch)) { say(false, "launch.js has no ca line to fill"); process.exit(1); }
write(LAUNCH, launch.replace(/ca: "[^"]*",/, `ca: "${mint}",`));
say(true, "launch.js: CA strip on for everyone (site and game)");
write(TOKEN_FILE, JSON.stringify({ address: mint, symbol: SYMBOL, minUsd: MIN_USD, keepUsd: KEEP_USD }, null, 1) + "\n", 0o600);
say(true, `agent-token.json: $${MIN_USD} of $${SYMBOL} = holder, 6 reads a day`);
const agent = readFileSync(AGENT, "utf8");
write(AGENT, agent.split(QUOTA_OLD).join(QUOTA_NEW));
say(true, `agent.html: quota line reads "${QUOTA_NEW.replace(/<\/?b>/g, "")}"`);
console.log(`   backups: ${BACKUP}`);

// 6. what a stranger sees
console.log("\n4. from outside");
const get = u => execSync(`curl -s -m 20 "${u}"`, { encoding: "utf8" });
say(get("https://medusa.cash/launch.js").includes(mint), "medusa.cash/launch.js carries the mint");
say(get("https://medusa.cash/agent").includes(`$${SYMBOL} for`), "agent page names the token in the quota line");
try { say(JSON.parse(readFileSync(TOKEN_FILE, "utf8")).address === mint, "agent-token.json holds the mint (the agent picks it up within a minute, no restart)"); }
catch { say(false, "agent-token.json unreadable"); }
console.log("\nlive. undo with: node ops/launch.mjs --undo");
