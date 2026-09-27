// /r?n=...&q=...&emo=...&v=...&head=...&tape=... (rewritten here by vercel.json):
// the share page for a MEDUSA read. Server-rendered og:* tags point at the PNG from
// /api/read-og with the same query, so X unfurls the card; the page shows it with the
// same stage as /w and offers Post / Download / Copy / Feed MEDUSA.
import { parseRead, EMO_LINE } from './_lib/read-render.js';

const SITE = 'https://game.medusa.cash';
const HOME = 'https://medusa.cash/';
const READ_V = '1'; // bump when the card design changes: X caches images per URL

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const r = parseRead(req.query);
  const qs = new URLSearchParams({ n: String(r.n), q: r.q, emo: r.emo, v: r.v, head: r.head, tape: r.tape, t: r.t }).toString();
  const pageUrl = `${SITE}/r?${qs}`;
  const imageUrl = `${SITE}/api/read-og?${qs}&cv=${READ_V}`;
  const money = r.v === 'with' ? 'The money agrees.' : r.v === 'against' ? 'The money disagrees.' : "The money hasn't decided.";
  const title = `MEDUSA read #${r.n.toLocaleString('en-US')}: ${r.emo}`;
  const desc = `${r.head}. ${r.tape || money} ${r.q ? `“${r.q}”` : ''}`.trim();
  const tweet = `MEDUSA read my take as ${r.emo}. ${money}\n\nshe reads what retail says against what it trades:`;
  const shareHref = `https://x.com/intent/tweet?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(pageUrl)}`;

  const words = ['GREED', 'FOMO', 'HOPIUM', 'COPE', 'FEAR', 'NOISE', 'HOPIUM', 'FOMO'];
  const drift = words.map((v, i) => {
    const pos = [[6, 4], [68, 2], [14, 70], [76, 62], [42, 84], [82, 34], [2, 44], [38, 7]][i];
    const size = [7, 6, 7, 5, 5.5, 8, 5, 5.5][i];
    const anim = ['a', 'b', 'c'][i % 3];
    const dur = [17, 21, 19, 23, 20, 15.5, 25, 22][i];
    const delay = [0, -6, -12, -20, -3, -16, -9, -25][i];
    return `<span class="fv-wrap" style="top:${pos[0]}%;left:${pos[1]}%"><span class="fv" style="font-size:${size}vw;animation:drift-${anim} ${dur}s ease-in-out ${delay}s infinite">${v}</span></span>`;
  }).join('');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(pageUrl)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="MEDUSA">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:image" content="${esc(imageUrl)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@0x_fokki">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(imageUrl)}">
<style>
:root{--bg:#060b11;--text:#edf2f3;--muted:#82909a;--lime:#86efac;--line:#344138;--surface:#0b1219}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--text);font-family:Inter,Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit}
.field{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none;background:var(--bg)}
.glow{position:absolute;border-radius:50%;will-change:transform}
.glow-a{width:60vmax;height:60vmax;top:-22%;left:-12%;background:radial-gradient(circle,rgba(134,239,172,.32) 0%,rgba(134,239,172,.12) 30%,rgba(134,239,172,0) 70%);animation:glow-a 26s ease-in-out infinite}
.glow-b{width:58vmax;height:58vmax;bottom:-22%;right:-16%;background:radial-gradient(circle,rgba(74,120,40,.36) 0%,rgba(74,120,40,.12) 32%,rgba(74,120,40,0) 70%);animation:glow-b 34s ease-in-out infinite}
.glow-c{width:54vmax;height:54vmax;top:-16%;right:-9%;background:radial-gradient(circle,rgba(40,140,150,.24) 0%,rgba(40,140,150,.08) 32%,rgba(40,140,150,0) 70%);animation:glow-c 44s ease-in-out infinite}
.fv-wrap{position:absolute;display:block;opacity:.45}
.fv{display:block;font-weight:800;line-height:1;letter-spacing:-.05em;white-space:nowrap;background-image:linear-gradient(170deg,var(--text) 0%,var(--text) 28%,var(--muted) 100%);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;opacity:0;will-change:transform,opacity}
.vignette{position:absolute;inset:0;background:radial-gradient(52% 42% at 50% 47%,rgba(6,11,17,.86) 0%,rgba(6,11,17,.55) 45%,rgba(6,11,17,0) 100%)}
@keyframes glow-a{0%,100%{transform:translate(0) scale(1)}50%{transform:translate(12%,10%) scale(1.15)}}
@keyframes glow-b{0%,100%{transform:translate(0) scale(1.1)}50%{transform:translate(-14%,-8%) scale(.95)}}
@keyframes glow-c{0%,100%{transform:translate(-20%) scale(1)}50%{transform:translate(0,12%) scale(1.1)}}
@keyframes drift-a{0%,100%{opacity:.19;transform:translate(0)}50%{opacity:.5;transform:translate(3vw,-3vh)}}
@keyframes drift-b{0%,100%{opacity:.47;transform:translate(0)}50%{opacity:.15;transform:translate(-2vw,4vh)}}
@keyframes drift-c{0%,100%{opacity:.26;transform:translateY(2vh)}50%{opacity:.55;transform:translate(2vw,-2vh)}}
main{position:relative;max-width:1180px;margin:0 auto;min-height:100vh;padding:56px 16px;display:flex;flex-direction:column;justify-content:center;gap:48px}
@media(min-width:1000px){main{flex-direction:row;align-items:center;gap:64px;padding:64px 24px}}
.left{flex:1;min-width:0}
.eyebrow{display:flex;align-items:center;gap:8px;margin:0 0 14px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted)}
.eyebrow .dot{width:6px;height:6px;border-radius:50%;background:var(--lime);box-shadow:0 0 8px var(--lime)}
h1{font-size:clamp(34px,4.2vw,46px);line-height:1.08;letter-spacing:-.03em;font-weight:800;margin:0;text-wrap:balance}
h1 em{font-style:normal;color:var(--lime)}
.lede{color:var(--muted);font-size:19px;margin:20px 0 0}
.cta{display:inline-block;margin-top:28px;font:inherit;font-weight:800;font-size:17px;padding:16px 28px;border-radius:12px;background:var(--lime);color:#122000;text-decoration:none}
.cta:hover{opacity:.88}
.pow{color:var(--muted);font-size:14px;margin-top:32px}
.pow a{text-decoration:none;border-bottom:1px solid var(--line)}
.right{width:100%;max-width:600px;flex-shrink:0;margin:0 auto}
.halo{position:absolute;inset:-70px;border-radius:50%;pointer-events:none;background:radial-gradient(ellipse at center,rgba(134,239,172,.14) 0%,rgba(134,239,172,.05) 35%,rgba(134,239,172,0) 70%);z-index:-1}
.stage{position:relative;perspective:1100px}
.tilt{position:relative;will-change:transform;transform:perspective(1100px) rotateX(3deg) rotateY(-8deg)}
.tilt img{display:block;width:100%;height:auto;border-radius:14px;border:1px solid var(--line);box-shadow:0 40px 100px -25px rgba(0,0,0,.95)}
.glare{pointer-events:none;position:absolute;inset:0;border-radius:14px;opacity:0;mix-blend-mode:plus-lighter;background:radial-gradient(circle at calc(var(--gx,50)*1%) calc(var(--gy,50)*1%),rgba(230,255,160,.26) 0%,rgba(230,255,160,.08) 26%,rgba(230,255,160,0) 58%)}
.actions{display:flex;gap:12px;margin-top:22px;flex-wrap:wrap}
.btn{flex:1 1 calc(50% - 6px);min-width:150px;text-align:center;text-decoration:none;font:inherit;font-weight:800;font-size:15px;padding:14px 18px;border-radius:12px;border:1px solid var(--lime);background:transparent;color:var(--lime);cursor:pointer;transition:background .15s,color .15s}
.btn:hover{background:var(--lime);color:#122000}
.btn.solid{background:var(--lime);color:#122000}
.btn.solid:hover{opacity:.88}
.btn.is-done{background:rgba(134,239,172,.12)}
@media(prefers-reduced-motion:reduce){.glow,.fv{animation:none!important}.fv-wrap{opacity:1}.fv{opacity:.15}}
</style></head><body>
<div class="field" aria-hidden="true"><div class="glow glow-a"></div><div class="glow glow-b"></div><div class="glow glow-c"></div>${drift}<div class="vignette"></div></div>
<main>
 <div class="left">
  <p class="eyebrow"><span class="dot"></span>MEDUSA read #${r.n.toLocaleString('en-US')} · ${esc(r.emo)}</p>
  <h1>${esc(r.head)}<em>.</em></h1>
  <p class="lede">${esc(EMO_LINE[r.emo])} MEDUSA reads what retail says against what it actually trades on Solana. Feed her your take and see if the money agrees.</p>
  <a class="cta" href="${HOME}">Feed MEDUSA →</a>
  <p class="pow">powered by <a href="https://medusa.cash">MEDUSA</a> · Solana</p>
 </div>
 <div class="right">
  <div class="stage"><div class="halo" aria-hidden="true"></div><div class="tilt" id="tilt"><img src="${esc(imageUrl.replace(SITE, ''))}" width="1200" height="630" alt="${esc(title)}"><div class="glare" id="glare"></div></div></div>
  <div class="actions"><a class="btn solid" href="${shareHref}" target="_blank" rel="noopener">Post on 𝕏</a><button type="button" class="btn" id="dl">Download image</button><button type="button" class="btn" id="cp">Copy image</button><a class="btn" href="${HOME}">Feed MEDUSA →</a></div>
 </div>
</main>
<script>
(function(){
 var dl=document.getElementById('dl'),cp=document.getElementById('cp'),img=document.querySelector('#tilt img');
 var name='medusa-read-${r.n}-${esc(r.emo.toLowerCase())}.png';
 function blob(){return fetch(img.getAttribute('src'),{cache:'force-cache'}).then(function(r){if(!r.ok)throw 0;return r.blob();});}
 function flash(btn,text){var old=btn.textContent;btn.textContent=text;btn.classList.add('is-done');setTimeout(function(){btn.textContent=old;btn.classList.remove('is-done');},1600);}
 dl.addEventListener('click',function(){blob().then(function(b){var u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u);},4000);flash(dl,'Saved');}).catch(function(){flash(dl,'Could not download');});});
 cp.addEventListener('click',function(){
  if(!navigator.clipboard||!window.ClipboardItem){flash(cp,'Not supported here');return;}
  var p;try{p=navigator.clipboard.write([new ClipboardItem({'image/png':blob()})]);}catch(e){p=blob().then(function(b){return navigator.clipboard.write([new ClipboardItem({'image/png':b})]);});}
  p.then(function(){flash(cp,'Copied');}).catch(function(){flash(cp,'Not supported here');});
 });
 var t=document.getElementById('tilt'),g=document.getElementById('glare');
 if(!t||!g||window.matchMedia('(prefers-reduced-motion: reduce)').matches||!window.matchMedia('(hover: hover)').matches)return;
 var rest={rx:3,ry:-8,s:1,gx:50,gy:50,gl:0},cur={rx:3,ry:-8,s:1,gx:50,gy:50,gl:0},tgt=Object.assign({},rest),raf=0;
 function paint(){t.style.transform='perspective(1100px) rotateX('+cur.rx.toFixed(2)+'deg) rotateY('+cur.ry.toFixed(2)+'deg) scale('+cur.s.toFixed(4)+')';g.style.opacity=cur.gl.toFixed(3);g.style.setProperty('--gx',cur.gx.toFixed(1));g.style.setProperty('--gy',cur.gy.toFixed(1));}
 function step(){var k=0.14,d=0;for(var p in tgt){var nv=cur[p]+(tgt[p]-cur[p])*k;d+=Math.abs(tgt[p]-cur[p]);cur[p]=nv;}paint();raf=d>0.01?requestAnimationFrame(step):0;}
 function kick(){if(!raf)raf=requestAnimationFrame(step);}
 t.addEventListener('pointermove',function(ev){var r=t.getBoundingClientRect(),x=(ev.clientX-r.left)/r.width,y=(ev.clientY-r.top)/r.height;tgt={rx:(0.5-y)*12,ry:(x-0.5)*16,s:1.02,gx:x*100,gy:y*100,gl:1};kick();});
 t.addEventListener('pointerleave',function(){tgt=Object.assign({},rest);kick();});
})();
</script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).end(html);
}
