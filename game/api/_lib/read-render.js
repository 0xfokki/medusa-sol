// The MEDUSA read card: what medusa.cash shows after you feed it a thought, as a
// 1200x630 PNG for X unfurls, downloads and copies. Stateless: everything the card
// says arrives in the query string (see parseRead), so no read has to be stored.
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { INTER } from './fonts.js';

export const CARD_W = 1200;
export const CARD_H = 630;

const C = { bg: '#060b11', text: '#edf2f3', muted: '#82909a', lime: '#86efac', line: '#344138' };

// medusa.cash's emotion ramp (index.html EMO), NOISE for a thought she could not read
export const EMO_COLOR = {
  GREED: 'rgb(134,239,172)', FOMO: 'rgb(163,188,74)', FEAR: 'rgb(223,230,200)',
  HOPIUM: 'rgb(245,247,238)', COPE: 'rgb(172,180,143)', NOISE: '#82909a',
};
export const EMO_LINE = {
  GREED: "Full send. You're pricing in the moon.",
  FOMO: 'More scared of missing it than losing it.',
  HOPIUM: 'Betting on the bounce.',
  COPE: 'Holding the bag and calling it conviction.',
  FEAR: 'One eye on the exit.',
  NOISE: "She couldn't find a side in that.",
};
const VERDICTS = { with: "You're with the money", against: "You're against the money", flat: 'No side taken' };

// Strip what the embedded font cannot draw (emoji and other astral characters) and cap lengths.
function clean(s, max) {
  return String(s || '').replace(/[\u{10000}-\u{10FFFF}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function parseRead(query) {
  const emo = String(query.emo || 'NOISE').toUpperCase();
  const v = ['with', 'against', 'flat'].includes(query.v) ? query.v : 'flat';
  const n = Math.max(0, Math.min(9_999_999, parseInt(query.n, 10) || 0));
  return {
    n,
    q: clean(query.q, 160),
    emo: EMO_COLOR[emo] ? emo : 'NOISE',
    v,
    head: clean(query.head, 60) || VERDICTS[v],
    tape: clean(query.tape, 140),
    t: clean(query.t, 12),
  };
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

function emoFontSize(word) {
  const n = word.length;
  return n <= 4 ? 150 : n <= 5 ? 140 : 120;
}

export function readTree(r) {
  const color = EMO_COLOR[r.emo];
  const headColor = r.v === 'with' ? C.lime : C.text;
  const quote = r.q ? `“${r.q}”` : '';
  return h('div', { width: CARD_W, height: CARD_H, display: 'flex', flexDirection: 'column', backgroundColor: C.bg, fontFamily: 'Inter', color: C.text, position: 'relative' },
    h('div', { position: 'absolute', top: 0, left: 0, width: CARD_W, height: 2, backgroundImage: `linear-gradient(90deg, ${C.lime} 0%, #7fa300 55%, rgba(134,239,172,0) 100%)` }),
    ...[[2, 5, 0.16], [7, 6, 0.10], [13, 7, 0.06], [20, 9, 0.03]].map(([top, height, a]) =>
      h('div', { position: 'absolute', top, left: 0, width: CARD_W, height, backgroundImage: `linear-gradient(90deg, rgba(134,239,172,${a}) 0%, rgba(134,239,172,${(a * 0.55).toFixed(3)}) 45%, rgba(134,239,172,0) 85%)` })),
    h('div', { display: 'flex', flexDirection: 'column', flex: 1, padding: '52px 64px 0 64px' },
      // header: read number left, emotion pill right
      h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
        h('div', { display: 'flex', alignItems: 'center' },
          h('div', { width: 10, height: 10, borderRadius: 5, backgroundColor: C.lime, marginRight: 14 }),
          h('span', { color: C.muted, fontSize: 22, fontWeight: 500, letterSpacing: '0.18em' }, 'MEDUSA READ'),
          h('span', { color: C.text, fontSize: 24, fontWeight: 800, letterSpacing: '0.04em', marginLeft: 14 }, `#${r.n.toLocaleString('en-US')}`),
          r.t && h('span', { color: C.muted, fontSize: 20, marginLeft: 16 }, r.t),
        ),
        h('div', { display: 'flex', backgroundColor: color, borderRadius: 999, padding: '12px 26px' },
          h('span', { color: '#0a1006', fontSize: 22, fontWeight: 800, letterSpacing: '0.1em' }, r.emo),
        ),
      ),
      // the thought
      quote && h('span', { color: C.text, fontSize: r.q.length > 70 ? 32 : 38, fontWeight: 500, lineHeight: 1.25, marginTop: 30, lineClamp: 2, maxHeight: 100, overflow: 'hidden' }, quote),
      // the read: the emotion, huge, in its own colour
      h('div', { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: quote ? 8 : 40 },
        h('span', { fontSize: emoFontSize(r.emo), fontWeight: 800, letterSpacing: '-0.05em', lineHeight: 1, color, marginLeft: -4 }, r.emo),
        h('span', { color: C.muted, fontSize: 22, maxWidth: 480, textAlign: 'right', paddingBottom: 18 }, EMO_LINE[r.emo]),
      ),
      h('div', { height: 1, width: '100%', backgroundColor: C.line, marginTop: 22 }),
      // the verdict against the tape
      h('div', { display: 'flex', flexDirection: 'column', marginTop: 20 },
        h('span', { color: headColor, fontSize: 40, fontWeight: 800, letterSpacing: '-0.02em' }, r.head),
        r.tape && h('span', { color: C.muted, fontSize: 24, marginTop: 8 }, r.tape),
      ),
      h('div', { display: 'flex', justifyContent: 'space-between', marginTop: 'auto', paddingBottom: 40 },
        h('span', { color: C.muted, fontSize: 22 }, 'powered by MEDUSA · medusa.cash'),
        h('span', { color: C.muted, fontSize: 20 }, 'Solana · what retail says vs what it trades'),
      ),
    ),
  );
}

export async function renderReadPng(r) {
  const svg = await satori(readTree(r), { width: CARD_W, height: CARD_H, fonts: loadFonts() });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: CARD_W } }).render().asPng());
}
