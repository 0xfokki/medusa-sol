// The agent seat as its own service: wallet sign-in and the gated reads (server/agent.mjs)
// behind /api/agent/*, next to the thought intake rather than inside it. It only reads the
// intake's database (for the counters) and never writes to it.
//
//   PORT=4666 DATA_DIR=/var/lib/brain-agent CHAIN_FILE=/var/www/brain/chain-data.js THOUGHTS_DB=/var/lib/brain/thoughts.db

import { createServer } from "http";
import { mkdirSync } from "fs";
import { agentRoutes } from "./agent.mjs";

const PORT = Number(process.env.PORT ?? 4666);
const DIR = process.env.DATA_DIR ?? "/var/lib/brain-agent";
const CHAIN_FILE = process.env.CHAIN_FILE ?? "/var/www/brain/chain-data.js";
const THOUGHTS_DB = process.env.THOUGHTS_DB ?? "/var/lib/brain/thoughts.db";
mkdirSync(DIR, { recursive: true });

// The intake's counters, read straight from its file. If it cannot be opened (permissions,
// an older node), the seat still works and the counters say so.
async function stats() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(THOUGHTS_DB, { readOnly: true });
    try {
      const midnight = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
      return {
        neurons: db.prepare("SELECT COUNT(*) n FROM thoughts").get().n,
        today: db.prepare("SELECT COUNT(*) n FROM thoughts WHERE ts > ?").get(midnight).n
      };
    } finally { db.close(); }
  } catch (e) { return { neurons: null, today: null, note: "counters unavailable: " + e.message }; }
}

const readBody = req => new Promise((resolve, reject) => {
  let n = 0, chunks = "";
  req.on("data", c => { n += c.length; if (n > 4096) { reject(new Error("too big")); req.destroy(); } chunks += c; });
  req.on("end", () => resolve(chunks));
  req.on("error", reject);
});
const agent = agentRoutes({ dataDir: DIR, chainFile: CHAIN_FILE, stats: () => stats() });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (await agent(req, res, url, readBody)) return;
  } catch (e) {
    console.error("agent:", e);
    res.writeHead(500, { "content-type": "application/json" }); return res.end('{"error":"agent route failed"}');
  }
  res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not found"}');
}).listen(PORT, "127.0.0.1", () => console.log(`agent seat on 127.0.0.1:${PORT}, data in ${DIR}`));
