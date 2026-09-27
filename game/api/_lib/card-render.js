// Renders the 1200x630 wallet card to PNG with satori (HTML-ish tree -> SVG)
// and resvg (SVG -> PNG). No JSX: the tree is plain objects, and every box with
// more than one child says display:flex explicitly, which is what satori's
// layout engine requires.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { fmtUsd, fmtNative, shortAddress, fmtDuration } from './worth.js';
import { INTER } from './fonts.js';

export const CARD_W = 1200;
export const CARD_H = 630;

const C = {
  bg: '#060b11',
  text: '#edf2f3',
  muted: '#82909a',
  lime: '#86efac',
  line: '#344138',
};

// Creature art per tier lives in game/creatures/<tier>.png. The function reads it from
// disk when the bundle carries it, otherwise from the public site (static files are not
// reliably traced into the function, and the per-deployment URL can sit behind Vercel
// auth, so the public alias comes first). A failed fetch is never cached: the next
// render tries again.
const CREATURE_HOSTS = ['https://game.medusa.cash', process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null].filter(Boolean);
const creatureCache = new Map();
export async function fetchCreatureDataUrl(tier) {
  const key = String(tier || '').toLowerCase();
  if (!key) return null;
  if (creatureCache.has(key)) return creatureCache.get(key);
  try {
    const buf = readFileSync(path.join(process.cwd(), 'creatures', `${key}.png`));
    if (buf.length) {
      const url = `data:image/png;base64,${buf.toString('base64')}`;
      creatureCache.set(key, url);
      return url;
    }
  } catch {}
  for (const host of CREATURE_HOSTS) {
    try {
      const r = await fetch(`${host}/creatures/${key}.png`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) continue;
      const url = `data:image/png;base64,${buf.toString('base64')}`;
      creatureCache.set(key, url);
      return url;
    } catch {}
  }
  return null;
}

let fonts = null;
function loadFonts() {
  if (fonts) return fonts;
  fonts = [400, 500, 800].map((weight) => ({ name: 'Inter', weight, style: 'normal', data: Buffer.from(INTER[weight], 'base64') }));
  return fonts;
}

function h(type, style, ...children) {
  const kids = children.flat().filter((k) => k !== null && k !== undefined && k !== false);
  return { type, props: { style, children: kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids } };
}

async function fetchAvatarDataUrl(twitter) {
  if (!twitter) return null;
  try {
    const r = await fetch(`https://unavatar.io/x/${encodeURIComponent(twitter)}?fallback=false`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'user-agent': 'Mozilla/5.0 medusa-card' },
    });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// X avatar when the wallet has a handle; otherwise the wallet's own creature, small;
// the "0x" monogram only when neither exists.
function avatarNode(dataUrl, fallbackText, creatureUrl) {
  const ring = { width: 100, height: 100, borderRadius: 50, border: `2px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: '#0c141c' };
  if (dataUrl) {
    return h('div', ring, { type: 'img', props: { src: dataUrl, width: 100, height: 100, style: { width: 100, height: 100, objectFit: 'cover' } } });
  }
  if (creatureUrl) {
    return h('div', { ...ring, backgroundImage: 'radial-gradient(circle, rgba(134,239,172,0.16) 0%, rgba(134,239,172,0) 70%)', backgroundColor: '#0a1310' },
      { type: 'img', props: { src: creatureUrl, width: 96, height: 96, style: { width: 96, height: 96, objectFit: 'contain' } } });
  }
  return h('div', ring, h('span', { color: C.lime, fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em' }, fallbackText));
}

function metric(label, value, { accent = false, first = false, sub = null } = {}) {
  return h('div', {
    display: 'flex', flexDirection: 'column', flex: 1,
    paddingLeft: first ? 0 : 20,
    borderLeft: first ? 'none' : `1px solid ${C.line}`,
  },
    h('span', { color: C.muted, fontSize: 20, fontWeight: 500, letterSpacing: '0.16em', textTransform: 'uppercase' }, label),
    h('span', { color: accent ? C.lime : C.text, fontSize: 42, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 10 }, value),
    sub && h('span', { color: C.muted, fontSize: 18, marginTop: 4 }, sub),
  );
}

function tierFontSize(tier) {
  const n = String(tier || '').length;
  return n <= 5 ? 150 : n <= 7 ? 122 : 100;
}

function standingLine(data) {
  // size only: the behaviour badge in the header already says how the wallet trades
  return data.topPct ? `Top ${data.topPct}% on MEDUSA` : 'Ranked on MEDUSA';
}

function nextLine(data) {
  if (!data.nextTier) return 'apex of the food chain';
  return `${fmtUsd(data.nextNeedUsd)} to ${data.nextTier}`;
}

// 300x300 art with a lime glow behind it; a quiet dashed ring until the art exists.
function creatureNode(tier, dataUrl) {
  const glow = { position: 'absolute', top: -40, left: -40, width: 380, height: 380, borderRadius: 190, backgroundImage: 'radial-gradient(circle, rgba(134,239,172,0.22) 0%, rgba(134,239,172,0.06) 40%, rgba(134,239,172,0) 70%)' };
  const box = { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 300, height: 300, flexShrink: 0 };
  if (dataUrl) {
    return h('div', box, h('div', glow), { type: 'img', props: { src: dataUrl, width: 300, height: 300, style: { position: 'relative', width: 300, height: 300, objectFit: 'contain' } } });
  }
  return h('div', box, h('div', glow), h('div', { position: 'relative', width: 220, height: 220, borderRadius: 110, border: '2px dashed rgba(134,239,172,0.35)' }));
}

function factsColumn(data) {
  const e = data.extra || {};
  const facts = [];
  if (e.x5 > 0) facts.push(['5x bags', `${e.x5}`]);
  if (data.trades > 0 && fmtDuration(e.holdSec)) facts.push(['avg hold', fmtDuration(e.holdSec)]);
  if (data.ageDays !== null && data.ageDays !== undefined) facts.push(['wallet age', data.ageDays >= 1 ? `${data.ageDays}d` : 'new']);
  if (e.tokens > 0) facts.push(['tokens traded', `${e.tokens}`]);
  const rows = facts.slice(0, 3);
  if (!rows.length) return null;
  return h('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', paddingBottom: 14 },
    rows.map(([label, value], i) => h('div', { display: 'flex', alignItems: 'baseline', marginTop: i ? 10 : 0 },
      h('span', { color: C.muted, fontSize: 18, fontWeight: 500, letterSpacing: '0.14em', textTransform: 'uppercase', marginRight: 14 }, label),
      h('span', { color: C.text, fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em' }, value),
    )),
  );
}

export function cardTree(data, avatarDataUrl, creatureDataUrl) {
  const name = data.twitter ? `@${data.twitter}` : shortAddress(data.address);
  const sub = data.twitter ? shortAddress(data.address) : 'Solana';
  const fallbackInitial = data.twitter ? data.twitter[0].toUpperCase() : '0x';

  return h('div', { width: CARD_W, height: CARD_H, display: 'flex', flexDirection: 'column', backgroundColor: C.bg, fontFamily: 'Inter', color: C.text, position: 'relative' },
    // top stripe: a hairline with a soft glow falling from it, so it floats instead of cutting
    h('div', { position: 'absolute', top: 0, left: 0, width: CARD_W, height: 2, backgroundImage: `linear-gradient(90deg, ${C.lime} 0%, #7fa300 55%, rgba(134,239,172,0) 100%)` }),
    // the glow under it: thin bands stepping down in alpha (satori has no mask), each
    // fading to nothing along the width, so there is no edge in either direction
    ...[[2, 5, 0.16], [7, 6, 0.10], [13, 7, 0.06], [20, 9, 0.03]].map(([top, height, a]) =>
      h('div', { position: 'absolute', top, left: 0, width: CARD_W, height, backgroundImage: `linear-gradient(90deg, rgba(134,239,172,${a}) 0%, rgba(134,239,172,${(a * 0.55).toFixed(3)}) 45%, rgba(134,239,172,0) 85%)` })),
    h('div', { display: 'flex', flexDirection: 'column', flex: 1, padding: '44px 64px 0 64px' },
      // header row
      h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
        h('div', { display: 'flex', alignItems: 'center' },
          avatarNode(avatarDataUrl, fallbackInitial, creatureDataUrl),
          h('div', { display: 'flex', flexDirection: 'column', marginLeft: 26 },
            h('span', { fontSize: 38, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1 }, name),
            h('span', { fontSize: 26, color: C.muted, marginTop: 6 }, sub),
          ),
        ),
        data.character && h('div', { display: 'flex', backgroundColor: C.lime, borderRadius: 999, padding: '14px 26px' },
          h('span', { color: '#122000', fontSize: 22, fontWeight: 800, letterSpacing: '0.08em' }, data.character),
        ),
      ),
      // headline: the creature's name on the left, its picture on the right
      h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 236, marginTop: 8 },
        h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'center' },
          h('span', { color: C.muted, fontSize: 22, fontWeight: 500, letterSpacing: '0.18em' }, 'YOUR WALLET IS A'),
          h('span', { fontSize: tierFontSize(data.tier), fontWeight: 800, letterSpacing: '-0.05em', lineHeight: 1, marginTop: 6, marginLeft: -4 }, data.tier),
          h('span', { color: C.muted, fontSize: 26, marginTop: 12 }, standingLine(data)),
        ),
        creatureNode(data.tier, creatureDataUrl),
      ),
      // divider
      h('div', { height: 1, width: '100%', backgroundColor: C.line, marginTop: 8 }),
      // metrics
      h('div', { display: 'flex', marginTop: 24 },
        metric('Balance', fmtNative(data.balanceNative), { accent: true, first: true }),
        metric('Realized PnL', fmtUsd(data.pnlUsd, { sign: true })),
        metric('Win rate', `${Math.round(data.winRatePct)}%`),
        metric('Rank', `Top ${data.topPct || 100}%`, { sub: nextLine(data) }),
      ),
      // footer
      h('div', { display: 'flex', flexDirection: 'column', marginTop: 'auto', paddingBottom: 40 },
        h('span', { color: C.muted, fontSize: 22 }, 'powered by MEDUSA · Solana'),
        h('span', { color: C.muted, fontSize: 20, marginTop: 4 }, 'game.medusa.cash · @0x_fokki'),
      ),
    ),
  );
}

export async function renderCardPng(data) {
  const [avatar, creature] = await Promise.all([fetchAvatarDataUrl(data.twitter), fetchCreatureDataUrl(data.tier)]);
  const svg = await satori(cardTree(data, avatar, creature), { width: CARD_W, height: CARD_H, fonts: loadFonts() });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: CARD_W } }).render().asPng();
  return Buffer.from(png);
}
