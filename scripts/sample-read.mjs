// One read, written down for the front page: the agent's full read of one coin ($BONK by
// default), as agent-sample.js next to chain-live.js, so block 04 shows a real, recent
// card instead of a promise. Meant for cron, once an hour, on the house key (~$0.003):
//
//   cd /var/www/brain && node scripts/sample-read.mjs DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
//
// SAMPLE_OUT overrides the file, SAMPLE_DATA the folder for the wallet cache.

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { readTicker, social } from "../server/read.mjs";

const symbol = process.argv[2] || process.env.SAMPLE_SYMBOL || "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy";   // $BP (Backpack) by mint (owner, 2026-09-27: always Backpack on the front page)
const site = fileURLToPath(new URL("..", import.meta.url));
const out = process.env.SAMPLE_OUT || fileURLToPath(new URL("../agent-sample.js", import.meta.url));
const dataDir = process.env.SAMPLE_DATA || site;

const r = await readTicker(symbol, { site, dataDir, maxPosts: 14 });
if (!r || r.choose) { console.error("sample-read: no single read for " + symbol); process.exit(1); }
// The front page shows five or six posts and both sides of the argument when X has them:
// the most liked bullish ones, the most liked bearish ones, then whatever else was said.
let all = r.social.posts || [];
// X's Top page is mostly cheerleading; when it has under two bearish posts, one more page
// of the latest two days is read for the other side (another third of a cent)
if (all.filter(p => p.sentiment === "Bearish").length < 2) {
  try {
    const more = await social({ symbol: r.symbol, address: r.address, hours: 48, max: 14, queryType: "Latest" });
    const seen = new Set(all.map(p => p.url));
    for (const p of more.posts || []) if (p.sentiment === "Bearish" && !seen.has(p.url)) { all.push(p); seen.add(p.url); }
  } catch (e) { console.error("sample-read: second page failed: " + e.message); }
}
const bull = all.filter(p => p.sentiment === "Bullish"), bear = all.filter(p => p.sentiment === "Bearish"), rest = all.filter(p => !p.sentiment);
const pick = [...bull.slice(0, 3), ...bear.slice(0, 2)];
for (const p of [...bull.slice(3), ...bear.slice(2), ...rest]) { if (pick.length >= 6) break; pick.push(p); }
pick.sort((a, b) => (b.likes || 0) - (a.likes || 0));
const sample = { ...r, social: { ...r.social, posts: pick }, notes: undefined, ms: undefined };
writeFileSync(out, "// Written by scripts/sample-read.mjs - the agent's read of one coin, for the front page.\nwindow.AGENT_SAMPLE = " + JSON.stringify(sample, null, 1) + ";\n");
console.log(`sample-read: $${r.symbol} ${r.verdict.score} ${r.verdict.tag} ${r.verdict.grade.label} · chain ${r.onchain?.source} ${r.onchain?.buyers}/${r.onchain?.sellers} · x ${r.social.bull}/${r.social.bear} · posts ${pick.length} (${pick.filter(p => p.sentiment === "Bullish").length} bull, ${pick.filter(p => p.sentiment === "Bearish").length} bear) · ${r.ms} ms -> ${out}`);
