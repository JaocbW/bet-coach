(() => {
"use strict";
const $ = s => document.querySelector(s);
const MARKETS = ["Parlay","Spread","Moneyline","Total","Player prop","Future","Other"];
const LEG_TYPES = MARKETS.filter(m => m !== "Parlay");
const PLURAL = {Parlay:"Parlays",Spread:"Spreads",Moneyline:"Moneylines",Total:"Totals","Player prop":"Player props",Future:"Futures",Other:"Other"};
const FILTERS = [["all","All"],["pending","In progress"],["won","Won"],["lost","Lost"],["cashed","Cashed"]];
const WHEN = {before:"Before I bet", during:"During", after:"After"};

/* ---------- team lists live in teams.js ---------- */
function teamPool(sport){
  const s = (sport||"").toUpperCase(), seen = new Set(), out = [];
  const own = state.bets.flatMap(b=>b.legs).map(l=>l.team).filter(Boolean);
  const key = /NBA/.test(s)?"NBA" : /NFL/.test(s)?"NFL" : /MLB/.test(s)?"MLB" : /NHL/.test(s)?"NHL" : /NCAA|CFB|CBB|COLLEGE/.test(s)?"COLLEGE" : null;
  const list = key ? TEAMS[key] : [...TEAMS.NBA, ...TEAMS.NFL, ...TEAMS.COLLEGE, ...TEAMS.MLB, ...TEAMS.NHL];
  for(const t of [...own, ...list]) if(!seen.has(t.toLowerCase())){ seen.add(t.toLowerCase()); out.push(t); }
  return out;
}

/* ---------- state ---------- */
const newLeg = type => ({ type, player:"", team:"", teamId:"", espnId:"", pick:"", odds:null, result:"pending" });
const state = { bets: [], unit: 10, review: null, filter: "all", editing: null, market: "Spread", conf: 3, live: false,
  legs: [newLeg("Spread")], oddsTouched: false, priceSrc: null, noteOpen: null, noteDraft: null, manual: {} };
let coll = null, sample = null, delArm = null;
const running = new Set();

/* ---------- odds math ---------- */
const parseOdds = v => { const n = Number(String(v||"").replace(/[^\d+-.]/g,"")); return Number.isFinite(n) && Math.abs(n) >= 100 ? Math.round(n) : null; };
const dec = o => o > 0 ? 1 + o/100 : 1 + 100/(-o);
const imp = o => o > 0 ? 100/(o+100) : (-o)/(-o+100);
const fmtOdds = o => o > 0 ? "+"+o : String(o);
const toAmerican = d => d >= 2 ? Math.round((d-1)*100) : Math.round(-100/(d-1));
const money = n => (n < 0 ? "−$" : "$") + Math.abs(n).toFixed(2).replace(/\.00$/,"");
const signMoney = n => (n > 0 ? "+" : "") + money(n);
const pct = n => (n*100).toFixed(1) + "%";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const norm = s => String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset()*6e4).toISOString().slice(0,10); };
const median = a => { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y), m=s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
const byTime = (a,b) => (a.date+(a.createdAt||"")).localeCompare(b.date+(b.createdAt||""));
/* Odds are optional: a bet's price comes from its odds, or from cost + payout. */
const effOdds = b => b.odds ?? ((b.payout > b.stake && b.stake > 0) ? toAmerican(b.payout/b.stake) : null);
const payoutOf = b => b.payout ?? (effOdds(b) ? b.stake*dec(effOdds(b)) : null);
const pl = b => b.result === "won" ? (payoutOf(b) !== null ? payoutOf(b) - b.stake : 0) : b.result === "lost" ? -b.stake : b.result === "cashed" ? (Number(b.cashout)||0) - b.stake : 0;
const clv = b => b.close && effOdds(b) ? imp(b.close) - imp(effOdds(b)) : null;

function normalize(v){
  const b = {...v};
  if(!Array.isArray(b.legs)){
    const n = Number(b.legs)||0;
    b.legs = [{ type: b.market==="Parlay" ? "Other" : b.market, pick: b.pick||"", odds:null, result: b.result }];
    if(b.market==="Parlay" && n>1) b.legCount = n;
  }
  b.legs = b.legs.map(l => ({ player:"", team:"", teamId:"", espnId:"", pick:"", odds:null, result:"pending", ...l }));
  b.odds = b.odds ?? null; b.payout = b.payout ?? null; b.log = Array.isArray(b.log) ? b.log : [];
  return b;
}
const legN = b => b.legCount || b.legs.length;
const isMulti = b => legN(b) > 1;
const legLabel = l => [l.player, l.pick].filter(Boolean).join(" ");
const titleOf = b => !isMulti(b) ? (legLabel(b.legs[0]||{}) || b.pick || "") : b.market==="Parlay" ? `${legN(b)}-leg parlay` : `${legN(b)}-leg ${b.market.toLowerCase()} parlay`;
function rideReturn(b){
  const r = b.legs.map(l => l.result);
  if(r.includes("lost")) return 0;
  if(r.includes("pending") || !r.length) return null;
  if(r.every(x => x==="push")) return b.stake;
  const pushes = r.filter(x=>x==="push").length;
  if(!pushes) return payoutOf(b);
  const live = b.legs.filter(l=>l.result==="won");
  return live.every(l=>l.odds) ? b.stake*live.reduce((d,l)=>d*dec(l.odds),1) : null;
}
const cashDiff = b => { const r = rideReturn(b); return r===null ? null : (Number(b.cashout)||0) - r; };

/* ---------- watch-outs (notes saved to warn on future bets) ---------- */
const STAT_ALIASES = [["assist","ast"],["point","pts"],["rebound","reb"],["three","3pm","3pt","3-pointer"],["steal","stl"],["block","blk"],["passing","pass yds","pass"],["rushing","rush yds","rush"],["receiving","rec yds","receptions","rec"],["touchdown","td"],["strikeout","k "],["hit"],["goal"],["shot","sog"],["save"]];
function statMatch(stat, pick){
  if(!stat) return false;
  const s = stat.toLowerCase(), p = " " + (pick||"").toLowerCase() + " ";
  if(p.includes(s.replace(/s$/,""))) return true;
  const g = STAT_ALIASES.find(a => a.some(x => s.includes(x.trim())));
  return !!g && g.some(x => p.includes(x));
}
function allWatch(){
  const out = [];
  for(const b of state.bets) b.log.forEach((n,i) => { if(n.remind?.player) out.push({ ...n.remind, text:n.text, at:n.at, betId:b.id, idx:i, from:titleOf(b) }); });
  return out.sort((a,b)=>(b.at||"").localeCompare(a.at||""));
}
function warningsFor(leg, excludeId){
  if(!leg.player || norm(leg.player).length < 3) return [];
  const same = w => (w.espnId && leg.espnId) ? w.espnId === leg.espnId : norm(w.player) === norm(leg.player) && (!w.team || !leg.team || norm(w.team) === norm(leg.team));
  return allWatch().filter(w => w.betId !== excludeId && same(w))
    .map(w => ({ ...w, sameStat: statMatch(w.stat, leg.pick) }));
}
const warnHTML = ws => ws.length ? `<div class="warnbox" role="note">${ws.map(w => `<div><b>Heads up${w.sameStat?` — same stat (${esc(w.stat)})`:w.stat?` on ${esc(w.stat)}`:""}:</b> ${esc(w.text)}<div class="src">${esc(w.player)}${w.team?` · ${esc(w.team)}`:""} · from your ${esc(w.from)} note, ${esc((w.at||"").slice(0,10))}</div></div>`).join("")}</div>` : "";

/* ---------- stats ---------- */
function compute(bets){
  const settled = bets.filter(b => b.result !== "pending");
  const w = settled.filter(b=>b.result==="won").length, l = settled.filter(b=>b.result==="lost").length, p = settled.filter(b=>b.result==="push").length, c = settled.filter(b=>b.result==="cashed").length;
  const staked = settled.reduce((s,b)=>s+b.stake,0);
  const profit = settled.reduce((s,b)=>s+pl(b),0);
  const priced = settled.filter(b=>(b.result==="won"||b.result==="lost") && effOdds(b));
  const be = priced.length ? priced.reduce((s,b)=>s+imp(effOdds(b)),0)/priced.length : null;
  const clvs = bets.map(clv).filter(x=>x!==null);
  return { n:bets.length, settled:settled.length, w,l,p,c, staked, profit, roi: staked? profit/staked : null,
    winPct: (w+l)? w/(w+l) : null, be, avgClv: clvs.length? clvs.reduce((a,b)=>a+b,0)/clvs.length : null, clvN: clvs.length,
    pending: bets.filter(b=>b.result==="pending").length, pendingStake: bets.filter(b=>b.result==="pending").reduce((s,b)=>s+b.stake,0) };
}
function group(bets, key){
  const m = new Map();
  for(const b of bets){ if(b.result==="pending") continue; const k = key(b); if(!m.has(k)) m.set(k,[]); m.get(k).push(b); }
  return [...m.entries()].map(([k,arr]) => ({ k, ...compute(arr) })).sort((a,b)=>b.settled-a.settled);
}
function flags(bets){
  const out = [], settled = bets.filter(b=>b.result!=="pending"), s = compute(bets);
  if(settled.length < 1) return [{t:"warn",h:"Not enough data yet",d:"Log at least 10 settled bets before reading anything into the numbers. 30+ before trusting a trend."}];
  if(s.winPct!==null && s.be!==null){
    const gap = s.winPct - s.be;
    out.push({t: gap>=0?"good":"bad", h:`Winning ${pct(s.winPct)} vs ${pct(s.be)} needed`, d: gap>=0 ? `You're ${(gap*100).toFixed(1)} points above break-even at your average price. Over ${s.w+s.l} bets that can still be luck.` : `You're ${(-gap*100).toFixed(1)} points short of break-even at the prices you take. That's the vig eating you.`});
  }
  const noPrice = settled.filter(b=>b.result==="won" && payoutOf(b)===null).length;
  if(noPrice) out.push({t:"warn",h:`${noPrice} win${noPrice>1?"s":""} with no payout or odds`,d:"Those wins count as $0 profit until you add the payout, so your profit is understated."});
  const par = settled.filter(isMulti);
  if(par.length){ const pp = par.reduce((a,b)=>a+pl(b),0), share = par.reduce((a,b)=>a+b.stake,0)/s.staked;
    out.push({t: pp<0||share>.25?"bad":"warn", h:`Multi-pick slips: ${par.length} bets, ${signMoney(pp)}`, d:`${pct(share)} of your money goes to parlays (mixed or same-type). Every leg stacks the book's edge, so a 4-leg parlay carries roughly 4× the house edge of a straight bet.`});
    const legs = par.flatMap(b=>b.legs).filter(l=>l.result==="won"||l.result==="lost");
    if(legs.length>=4){ const lw = legs.filter(l=>l.result==="won").length/legs.length, oneOff = par.filter(b=>b.result==="lost" && b.legs.filter(l=>l.result==="lost").length===1).length;
      out.push({t:"warn", h:`Parlay legs hit ${pct(lw)} (${legs.length} graded legs)`, d: oneOff ? `${oneOff} of your losing parlays missed by a single leg. That feels close, but it's exactly how parlays are priced to beat you. If these legs are good, bet them straight.` : "If your legs hit often but the slips still lose, the math of stacking is the problem, not your picks."}); }
    for(const r of group(par.filter(b=>b.market!=="Parlay"), b=>b.market)) if(r.settled>=3) out.push({t: r.profit<0?"bad":"good", h:`${r.k} parlays: ${r.w}-${r.l}, ${signMoney(r.profit)}`, d: r.k==="Player prop" ? "Same-game prop parlays carry the biggest markups at most books. Check whether single props would have done better." : "Same-type parlays still stack the vig on every leg."}); }
  const chalk = settled.filter(b=>effOdds(b)!==null && effOdds(b)<=-200);
  if(chalk.length){ const cp = chalk.reduce((a,b)=>a+pl(b),0); out.push({t: cp<0?"bad":"warn", h:`Heavy favorites (−200 or worse): ${chalk.length} bets, ${signMoney(cp)}`, d:"At −200 you need to win 66.7% just to break even. One upset wipes out two wins."}); }
  const sorted = [...bets].sort(byTime), med = median(bets.map(b=>b.stake)); let chase = 0;
  for(let i=1;i<sorted.length;i++){ if(sorted[i-1].result==="lost" && sorted[i].stake > med*1.5) chase++; }
  if(chase) out.push({t:"bad",h:`Possible chasing: ${chase} time${chase>1?"s":""}`,d:`Bet over 1.5× your normal stake (${money(med)}) right after a loss. Raising stakes to win it back is the fastest way to blow a bankroll.`});
  const maxS = Math.max(...bets.map(b=>b.stake));
  if(med && maxS/med >= 3) out.push({t:"warn",h:`Stake swings: biggest bet is ${(maxS/med).toFixed(1)}× your median`,d:"Flat staking (same size every bet) keeps one bad call from wrecking you."});
  const cashed = settled.filter(b=>b.result==="cashed");
  if(cashed.length){
    const known = cashed.filter(b=>cashDiff(b)!==null), net = known.reduce((a,b)=>a+cashDiff(b),0), cp = cashed.reduce((a,b)=>a+pl(b),0);
    out.push({t: !known.length ? "warn" : net>=0 ? "good" : "bad", h:`Cash-outs: ${cashed.length}, ${signMoney(cp)} profit`, d: known.length
      ? `Compared to letting them ride, selling ${net>=0?"saved":"cost"} you ${money(Math.abs(net))} across ${known.length} with known outcomes. Books price cash-outs with extra juice, so selling winners early usually costs you over time.`
      : "Log what would have happened after you sold so we can see if your cash-outs help or hurt."});
  }
  const hi = settled.filter(b=>b.conf>=4 && (b.result==="won"||b.result==="lost")), lo = settled.filter(b=>b.conf<=2 && (b.result==="won"||b.result==="lost"));
  if(hi.length>=3){ const hw = hi.filter(b=>b.result==="won").length/hi.length;
    out.push({t: hw > (lo.length? lo.filter(b=>b.result==="won").length/lo.length : 0) ? "good":"warn", h:`Confident bets (4–5): ${pct(hw)} win rate over ${hi.length}`, d: lo.length>=3 ? `Low-confidence bets (1–2) win ${pct(lo.filter(b=>b.result==="won").length/lo.length)}. If confidence doesn't predict wins, your gut isn't an edge yet.` : "Keep rating confidence honestly so we can check whether your gut is calibrated."}); }
  if(s.avgClv!==null) out.push({t: s.avgClv>0?"good":"bad", h:`Closing line value: ${s.avgClv>0?"+":""}${(s.avgClv*100).toFixed(1)} pts avg (${s.clvN} bets)`, d: s.avgClv>0 ? "You're getting better numbers than the market closes at. That's the strongest sign of real skill, even through losing streaks." : "The line usually moves against you after you bet. Try betting earlier, or shopping more books for the best number."});
  else out.push({t:"warn",h:"No closing lines logged",d:"Record the closing odds after each game when you can. Beating the close is the best long-run predictor of whether you're actually good."});
  const noWhy = bets.filter(b=>!(b.reason||"").trim()).length;
  if(noWhy) out.push({t:"warn",h:`${noWhy} bet${noWhy>1?"s":""} with no reasoning`,d:"If you can't write down why, it's probably a feel bet. The coach can't grade a process it can't see."});
  return out;
}

/* ---------- render: board, flags, watch-outs, chart ---------- */
function renderStats(){
  const s = compute(state.bets), u = state.unit || 0;
  const units = n => u ? (n>0?"+":"")+(n/u).toFixed(2)+"u" : "";
  const cells = [
    ["Record", s.settled ? `${s.w}-${s.l}${s.p?"-"+s.p:""}` : "0-0", (s.winPct!==null ? pct(s.winPct)+" wins" : "no results yet") + (s.c ? ` · ${s.c} cashed` : ""), ""],
    ["Profit", signMoney(s.profit), units(s.profit), s.profit>0?"pos":s.profit<0?"neg":""],
    ["ROI", s.roi===null ? "—" : (s.roi>0?"+":"")+pct(s.roi), "on "+money(s.staked)+" risked", s.roi>0?"pos":s.roi<0?"neg":""],
    ["Break-even", s.be===null ? "—" : pct(s.be), "win % you need", ""],
    ["Avg CLV", s.avgClv===null ? "—" : (s.avgClv>0?"+":"")+(s.avgClv*100).toFixed(1), s.clvN ? `pts · ${s.clvN} bets` : "log closing odds", s.avgClv>0?"pos":s.avgClv<0?"neg":""],
    ["In progress", String(s.pending), money(s.pendingStake)+" at risk", ""],
  ];
  $("#stats").innerHTML = cells.map(([l,v,sub,c]) => `<div class="stat"><div class="label">${l}</div><div class="v ${c}">${esc(v)}</div><div class="s">${esc(sub)}</div></div>`).join("");
}
function renderFlags(){
  $("#flags").innerHTML = flags(state.bets).map(f => `<div class="flag ${f.t}"><span class="dot" aria-hidden="true"></span><div><b>${esc(f.h)}</b><br>${esc(f.d)}</div></div>`).join("");
}
function renderWatch(){
  const ws = allWatch();
  $("#watch").innerHTML = ws.length ? ws.map(w => `<div class="watch-item"><div><div class="who">${esc(w.player)}${w.team?` <span>· ${esc(w.team)}</span>`:""}${w.stat?` <span>· ${esc(w.stat)}</span>`:""}</div>${esc(w.text)}</div><button class="btn small ghost" type="button" data-unwatch="${esc(w.betId)}:${w.idx}">Stop warning</button></div>`).join("")
    : `<p class="hint">Add a note to any bet and tick "Warn me on future bets". Next time you log a pick on that player, the slip shows your note.</p>`;
}
function renderChart(){
  const settled = state.bets.filter(b=>b.result!=="pending").sort(byTime);
  const el = $("#chart");
  $("#unitLabel").textContent = state.unit ? `1u = ${money(state.unit)}` : "";
  if(settled.length < 2){ el.innerHTML = `<p class="hint">Your running profit line shows up after two settled bets.</p>`; }
  else {
    let run = 0; const pts = [0, ...settled.map(b => run += pl(b))];
    const W=640,H=180,pl_=46,pr=14,pt=14,pb=24, min=Math.min(0,...pts), max=Math.max(0,...pts), span=(max-min)||1;
    const x = i => pl_ + i*(W-pl_-pr)/(pts.length-1), y = v => pt + (max-v)*(H-pt-pb)/span;
    const line = pts.map((v,i)=>`${i?"L":"M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const area = line + `L${x(pts.length-1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
    const last = pts[pts.length-1], col = last>=0 ? "var(--win)" : "var(--loss)";
    const ticks = [max, 0, min].filter((v,i,a)=>a.indexOf(v)===i);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative profit across ${settled.length} settled bets, now ${signMoney(last)}">
      ${ticks.map(v=>`<line x1="${pl_}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1" ${v===0?"":'stroke-dasharray="3 4"'}/><text x="${pl_-6}" y="${y(v)+4}" text-anchor="end" font-size="11" font-family="IBM Plex Mono, monospace" fill="var(--muted)">${esc(signMoney(Math.round(v)))}</text>`).join("")}
      <path d="${area}" fill="${col}" fill-opacity=".12"/>
      <path d="${line}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round"/>
      <circle cx="${x(pts.length-1)}" cy="${y(last)}" r="4.5" fill="${col}"/>
      <text x="${pl_}" y="${H-6}" font-size="11" fill="var(--muted)" font-family="IBM Plex Sans, sans-serif">first bet</text>
      <text x="${W-pr}" y="${H-6}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="IBM Plex Sans, sans-serif">bet ${settled.length}</text>
    </svg>`;
  }
  const rows = [["By bet type", group(state.bets, b=>b.market)], ["By sport", group(state.bets, b=>b.sport.toUpperCase())]];
  $("#breakdown").innerHTML = state.bets.some(b=>b.result!=="pending") ? `<table><thead><tr><th>Split</th><th>Bets</th><th>Record</th><th>Win %</th><th>Profit</th><th>ROI</th></tr></thead><tbody>${
    rows.map(([title,g]) => `<tr><th colspan="6" style="text-align:left;padding-top:12px">${title}</th></tr>` + g.map(r => `<tr><td>${esc(r.k)}</td><td class="num">${r.settled}</td><td class="num">${r.w}-${r.l}${r.p?"-"+r.p:""}</td><td class="num">${r.winPct===null?"—":pct(r.winPct)}</td><td class="num ${r.profit>0?"pos":r.profit<0?"neg":""}">${signMoney(r.profit)}</td><td class="num ${r.roi>0?"pos":r.roi<0?"neg":""}">${r.roi===null?"—":(r.roi>0?"+":"")+pct(r.roi)}</td></tr>`).join("")).join("")
  }</tbody></table>` : "";
}
function md(text){
  const lines = esc(text).split("\n"); let html = "", inList = false, first = true;
  const inline = s => s.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>");
  for(let raw of lines){
    const line = raw.trim();
    if(first && line){ first = false;
      const m = line.match(/^(?:verdict:\s*)?((good|bad|toss-up|solid|risky)[^.]{0,30}?,\s*(won|lost|pushed?|pending|cashed out|cashed))\.?$/i);
      if(m){ const g=m[2].toLowerCase(), r=m[3].toLowerCase(); const cls = g==="good"||g==="solid" ? (r==="lost"?"mix":"gw") : g==="bad"||g==="risky" ? (r==="won"?"mix":"bl") : "mix";
        html += `<div class="verdict ${cls}">${m[1]}</div>`; continue; }
    }
    if(/^#{1,4}\s/.test(line)){ if(inList){html+="</ul>";inList=false;} html += `<h4>${inline(line.replace(/^#+\s*/,""))}</h4>`; }
    else if(/^[-*•]\s/.test(line)){ if(!inList){html+="<ul>";inList=true;} html += `<li>${inline(line.replace(/^[-*•]\s*/,""))}</li>`; }
    else if(line){ if(inList){html+="</ul>";inList=false;} html += `<p>${inline(line)}</p>`; }
  }
  if(inList) html += "</ul>";
  return `<div class="coach">${html}</div>`;
}

/* ---------- render: tickets ---------- */
function composerHTML(b){
  const d = state.noteDraft;
  const players = [...new Set(b.legs.map(l=>l.player).filter(Boolean))];
  return `<div class="composer">
    <span class="label">When is this note from?</span>
    <div class="seg" data-note="when">${Object.entries(WHEN).map(([k,l])=>`<button type="button" data-when="${k}" aria-pressed="${d.when===k}">${l}</button>`).join("")}</div>
    <textarea id="note-text" aria-label="Note" placeholder="${d.when==="before"?"What you're thinking before placing it":d.when==="during"?"What you're seeing live":"What you learned"}">${esc(d.text)}</textarea>
    <label class="check"><input type="checkbox" id="note-remind" ${d.remind?"checked":""}> Warn me on future bets about this</label>
    ${d.remind ? `<div class="row3">
      <div class="field"><label for="note-player">Player</label><input id="note-player" list="note-players" value="${esc(d.player)}" placeholder="Caleb Wilson"><datalist id="note-players">${players.map(p=>`<option>${esc(p)}</option>`).join("")}</datalist></div>
      <div class="field"><label for="note-team">Team</label><input id="note-team" value="${esc(d.team)}" placeholder="Team"></div>
      <div class="field"><label for="note-stat">Stat <i>(optional)</i></label><input id="note-stat" value="${esc(d.stat)}" placeholder="assists"></div>
    </div>` : ""}
    <div class="err" id="note-err" hidden></div>
    <div class="actions"><button class="btn small primary" type="button" data-act="saveNote">Save note</button><button class="btn small ghost" type="button" data-act="closeNote">Cancel</button></div>
  </div>`;
}
function ticketHTML(b){
  const p = pl(b), c = clv(b), busy = running.has(b.id), o = effOdds(b), pay = payoutOf(b);
  const askLabel = b.result==="pending" ? "Check this bet" : b.result==="won" ? "Why did it hit?" : b.result==="lost" ? "Why did it miss?" : b.result==="cashed" ? "Was cashing out smart?" : "Break it down";
  const single = !isMulti(b) ? b.legs[0] : null;
  const warns = b.result==="pending" ? b.legs.flatMap(l => warningsFor(l, b.id)) : [];
  return `<article class="ticket ${b.result}" data-id="${esc(b.id)}"><div class="stripe"></div><div class="t-body">
    <div class="t-top"><span>${esc(b.date)} · ${esc(b.sport)}${isMulti(b)?` · ${b.legs.filter(l=>l.result==="won").length}/${legN(b)} legs hit`:""}</span>
      <span style="display:flex;gap:6px;align-items:center">${b.example?'<span class="chip">Example</span>':""}<span class="pill ${b.result}">${b.result==="pending"?"In progress":b.result==="cashed"?`Cashed ${money(Number(b.cashout)||0)}`:b.result}</span></span></div>
    <div class="t-main"><div class="t-pick">${esc(titleOf(b))}${single?.team?`<small>${esc(single.team)}</small>`:""}</div><div class="t-odds">${o!==null?(b.odds===null?"≈":"")+fmtOdds(o):""}</div></div>
    ${isMulti(b) && b.legs.some(l=>l.pick||l.player) ? `<ol class="t-legs">${b.legs.map(l=>`<li>${b.market==="Parlay"?`<span class="lt">${esc(l.type)}</span>`:"<span></span>"}<span class="lp">${esc(legLabel(l))}${l.team?` <small>· ${esc(l.team)}</small>`:""}</span><span class="lo">${l.odds?fmtOdds(l.odds):""}</span><span class="lr ${l.result}">${{won:"Hit",lost:"Miss",push:"Push",pending:"—"}[l.result]||"—"}</span></li>`).join("")}</ol>` : ""}
    <div class="t-meta"><span>Cost <b>${money(b.stake)}</b></span>${pay!==null?`<span>Pays <b>${money(pay)}</b></span>`:""}${b.result!=="pending"?`<span>P/L <b class="${p>0?"pos":p<0?"neg":""}">${b.result==="won"&&pay===null?"add payout":signMoney(p)}</b></span>`:""}${o!==null?`<span>Needs <b>${pct(imp(o))}</b></span>`:""}${b.conf?`<span>Conf <b>${b.conf}/5</b></span>`:""}${c!==null?`<span>CLV <b class="${c>0?"pos":c<0?"neg":""}">${c>0?"+":""}${(c*100).toFixed(1)}</b> (close ${fmtOdds(b.close)})</span>`:""}</div>
    ${warnHTML(warns)}
    ${liveHTML(b)}
    ${b.result==="cashed" ? (() => { const r = rideReturn(b);
      return `<div class="cashnote">Sold for <b>${money(Number(b.cashout)||0)}</b>${pay!==null?` of a possible ${money(pay)} payout`:""}. ${r===null ? "Log how it finished to see if selling was right." : cashDiff(b)>=0 ? `Letting it ride would have returned ${money(r)}, so cashing out <b>saved ${money(cashDiff(b))}</b>.` : `It would have paid ${money(r)}, so cashing out <b>left ${money(-cashDiff(b))} on the table</b>.`}</div>`; })() : ""}
    ${b.reason?`<div class="t-text"><span class="label">Why I took it</span>${esc(b.reason)}</div>`:""}
    ${b.notes?`<div class="t-text"><span class="label">What happened</span>${esc(b.notes)}</div>`:""}
    ${b.log.length?`<div class="t-text"><span class="label">Notes</span><ul class="log">${b.log.map(n=>`<li><span class="when ${n.when}">${WHEN[n.when]||n.when}</span><div>${esc(n.text)}${n.remind?.player?`<div class="rem">Watch-out saved for ${esc(n.remind.player)}${n.remind.stat?` · ${esc(n.remind.stat)}`:""}</div>`:""}<div class="meta">${esc(new Date(n.at).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}))}</div></div></li>`).join("")}</ul></div>`:""}
    ${state.noteOpen===b.id ? composerHTML(b) : ""}
    <div class="t-actions">
      ${b.result==="pending"?`<button class="btn small" data-act="won">Won</button><button class="btn small" data-act="lost">Lost</button><button class="btn small" data-act="push">Push</button><button class="btn small" data-act="cash">Cash out</button>`:""}
      ${state.noteOpen!==b.id?`<button class="btn small" data-act="note">Add note</button>`:""}
      ${sample?`<button class="btn small primary" data-act="ask" ${busy?"disabled":""}>${busy?"Coach is reading…":(b.analysis?"Re-run coach":askLabel)}</button>`:""}
      <button class="btn small ghost" data-act="edit">Edit</button>
      <button class="btn small ghost" data-act="del">${delArm===b.id?"Tap again to delete":"Delete"}</button>
    </div>
    ${state.manual[b.id] ? `<div class="t-analysis">${manualHTML(b.id)}</div>` : b.analysis||busy?`<div class="t-analysis" id="an-${esc(b.id)}">${b.analysis?md(b.analysis):'<p class="thinking">Coach is reading the ticket…</p>'}</div>`:""}
  </div></article>`;
}
function renderTickets(){
  $("#filters").innerHTML = FILTERS.map(([k,l]) => `<button type="button" data-f="${k}" aria-pressed="${state.filter===k}">${l}</button>`).join("");
  const list = [...state.bets].sort(byTime).reverse().filter(b => state.filter==="all" || b.result===state.filter);
  const el = $("#tickets");
  if(!state.bets.length){
    el.innerHTML = `<div class="empty"><h3>Your book is empty</h3><p>Log your first bet on the left, win or lose. Write down why you took it — that's what the coach grades.</p><button class="btn" id="loadEx" type="button">Load 4 example bets</button><span class="hint">Examples are marked and easy to clear.</span></div>`;
    return;
  }
  const ex = state.bets.some(b=>b.example);
  el.innerHTML = (ex?`<div class="banner" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><span>These include example bets so you can see how the coach works.</span><button class="btn small" id="clearEx" type="button">Clear examples</button></div>`:"")
    + (list.length ? MARKETS.map(m => { const items = list.filter(b=>b.market===m); if(!items.length) return "";
        const p = items.reduce((a,b)=>a+pl(b),0);
        return `<section class="sec" aria-label="${PLURAL[m]}"><div class="sec-head"><h3>${PLURAL[m]}</h3><span>${items.length} bet${items.length>1?"s":""} · <span class="${p>0?"pos":p<0?"neg":""}">${signMoney(p)}</span></span></div>${items.map(ticketHTML).join("")}</section>`; }).join("")
      : `<p class="hint">No ${FILTERS.find(f=>f[0]===state.filter)[1].toLowerCase()} bets.</p>`);
}
function renderReview(){
  const out = $("#reviewOut");
  if(running.has("_review") || state.manual._review) return;
  out.innerHTML = state.review?.text ? md(state.review.text) + `<p class="hint">Reviewed ${esc(new Date(state.review.at).toLocaleDateString())} · ${state.review.n} settled bets</p>`
    : `<p class="hint">Once you have 5+ settled bets, the coach reads your whole history, including your notes, and finds your biggest leaks, what's working, and rules for your next 20 bets.</p>`;
}
function renderAll(){ renderStats(); renderFlags(); renderWatch(); renderChart(); renderTickets(); renderReview(); $("#f-unit").value = state.unit || ""; }

/* ---------- slip: sections & picks ---------- */
$("#f-market").innerHTML = MARKETS.map(m => `<button type="button" data-m="${m}">${m}</button>`).join("");
$("#f-conf").innerHTML = [1,2,3,4,5].map(n => `<button type="button" data-c="${n}" aria-label="Confidence ${n} of 5">${n}</button>`).join("");
function placeholderFor(t){ return ({Spread:"Alabama -6.5",Moneyline:"Ole Miss ML",Total:"Over 47.5","Player prop":"2+ assists",Future:"To win the SEC",Other:"Pick"})[t] || "Pick"; }
function legTypeOf(l){ return state.market === "Parlay" ? l.type : state.market; }
function renderLegs(){
  const multi = state.legs.length > 1, typed = state.market === "Parlay";
  $("#legs").innerHTML = state.legs.map((l,i) => { const prop = legTypeOf(l) === "Player prop";
    return `<div class="leg" data-i="${i}">
    <span class="n">${i+1}</span>
    ${typed?`<select class="ty" id="leg-type-${i}" aria-label="Pick ${i+1} type">${LEG_TYPES.map(t=>`<option ${t===l.type?"selected":""}>${t}</option>`).join("")}</select>`:""}
    ${prop?`<input class="tm" id="leg-team-${i}" value="${esc(l.team)}" aria-label="Pick ${i+1} team" placeholder="Team (type to search)">
    <input class="pl" id="leg-player-${i}" value="${esc(l.player)}" aria-label="Pick ${i+1} player" placeholder="${l.teamId?"Player (type to search roster)":"Player"}">`:""}
    <input class="pk" id="leg-pick-${i}" value="${esc(l.pick)}" aria-label="Pick ${i+1}" placeholder="${esc(placeholderFor(legTypeOf(l)))}">
    ${multi?`<input class="od num" id="leg-odds-${i}" inputmode="numeric" value="${l.odds?fmtOdds(l.odds):""}" aria-label="Pick ${i+1} odds" placeholder="odds">
    <select class="rs" id="leg-res-${i}" aria-label="Pick ${i+1} result">${[["pending","Live"],["won","Hit"],["lost","Miss"],["push","Push"]].map(([v,t])=>`<option value="${v}" ${v===l.result?"selected":""}>${t}</option>`).join("")}</select>
    <button type="button" class="x" data-rm="${i}" aria-label="Remove pick ${i+1}">×</button>`:""}
    <div class="sugg full" id="leg-sugg-${i}" hidden></div>
    <div class="full" id="leg-warn-${i}">${warnHTML(warningsFor(l, state.editing))}</div>
  </div>`; }).join("");
  $("#mk-hint").textContent = typed ? "Mixed bet types on one slip. Choose a type for each pick." : `One pick is a straight bet. Add more ${PLURAL[state.market].toLowerCase()} to make a ${state.market.toLowerCase()} parlay.`;
  $("#oddsLabel").innerHTML = multi ? "Total odds <i>(optional)</i>" : "Odds <i>(optional)</i>";
}
function updateWarn(i){ const el = document.getElementById("leg-warn-"+i); if(el) el.innerHTML = warnHTML(warningsFor(state.legs[i], state.editing)); }
let suggSeq = 0;
async function showSugg(i, kind){
  const box = document.getElementById("leg-sugg-"+i); if(!box) return;
  const l = state.legs[i], q = (kind==="team" ? l.team : l.player).trim().toLowerCase(), seq = ++suggSeq;
  const league = ESPN.enabled() ? ESPN.leagueFor($("#f-sport").value) : null;
  let items = [];
  if(kind==="team" && q.length>=2){
    let espnTeams = null;
    if(league){ try { espnTeams = await ESPN.teams(league); } catch {} }
    if(espnTeams?.length) items = espnTeams.filter(t => [t.name,t.short,t.abbr,t.location].some(x => x && x.toLowerCase().includes(q))).slice(0,8).map(t => ({label:esc(t.name), team:t.name, teamId:t.id}));
    else items = teamPool($("#f-sport").value).filter(t => t.toLowerCase().includes(q)).slice(0,8).map(t => ({label:esc(t), team:t}));
  }
  if(kind==="player" && q.length>=1){
    if(league && l.teamId){
      try { const r = await ESPN.roster(league, l.teamId);
        items = r.filter(p => p.name.toLowerCase().includes(q)).slice(0,8).map(p => ({label:`${esc(p.name)} <small>${esc([p.pos, p.jersey?"#"+p.jersey:""].filter(Boolean).join(" "))}</small>`, player:p.name, espnId:p.id, team:l.team, teamId:l.teamId})); } catch {}
    }
    if(!items.length && q.length>=2){
      const seen = new Map();
      for(const b of state.bets) for(const x of b.legs) if(x.player && x.player.toLowerCase().includes(q)){ const k = norm(x.player)+"|"+norm(x.team); if(!seen.has(k)) seen.set(k, x); }
      for(const w of allWatch()) if(w.player.toLowerCase().includes(q)){ const k = norm(w.player)+"|"+norm(w.team); if(!seen.has(k)) seen.set(k, {player:w.player, team:w.team, espnId:w.espnId, teamId:w.teamId}); }
      items = [...seen.values()].slice(0,6).map(x => ({label:`${esc(x.player)}${x.team?` <small>· ${esc(x.team)}</small>`:""}`, player:x.player, team:x.team, espnId:x.espnId||"", teamId:x.teamId||""}));
    }
  }
  if(seq !== suggSeq) return; // a newer keystroke already updated the list
  if(items.length===1 && kind==="team" && items[0].team.toLowerCase()===q) items = [];
  box.hidden = !items.length;
  box.innerHTML = items.map((it,k) => `<button type="button" data-sg="${i}" data-k="${k}">${it.label}</button>`).join("");
  box._items = items;
}
function hideSugg(i){ setTimeout(() => { const box = document.getElementById("leg-sugg-"+i); if(box && !box.contains(document.activeElement)) box.hidden = true; }, 150); }
function autoOdds(){
  if(state.legs.length < 2 || state.oddsTouched) return;
  if(state.legs.every(l=>l.odds)){ $("#f-odds").value = fmtOdds(toAmerican(state.legs.reduce((d,l)=>d*dec(l.odds),1))); state.priceSrc = "odds"; syncPrice(); }
}
function autoResult(){
  if(state.legs.length < 2 || $("#f-result").value === "cashed") return;
  const r = state.legs.map(l=>l.result);
  $("#f-result").value = r.includes("lost") ? "lost" : r.includes("pending") ? "pending" : r.every(x=>x==="push") ? "push" : "won";
}
function setMarket(m){
  if(m === state.market) return;
  const wasParlay = state.market === "Parlay";
  state.market = m;
  if(m === "Parlay"){ if(state.legs.length < 2) state.legs.push(newLeg("Moneyline")); }
  else state.legs.forEach(l => l.type = m);
  if(wasParlay && m !== "Parlay") state.legs = state.legs.filter((l,i)=>l.pick.trim() || l.player.trim() || i===0);
  renderLegs(); syncForm();
}
$("#legs").addEventListener("input", e => {
  const row = e.target.closest(".leg"); if(!row) return; const i = Number(row.dataset.i), l = state.legs[i], c = e.target.classList;
  if(c.contains("pk")){ l.pick = e.target.value; updateWarn(i); }
  if(c.contains("pl")){ l.player = e.target.value; l.espnId = ""; updateWarn(i); showSugg(i,"player"); }
  if(c.contains("tm")){ l.team = e.target.value; l.teamId = ""; updateWarn(i); showSugg(i,"team"); }
  if(c.contains("od")){ l.odds = parseOdds(e.target.value); autoOdds(); syncForm(); }
});
$("#legs").addEventListener("focusout", e => { const row = e.target.closest(".leg"); if(row) hideSugg(Number(row.dataset.i)); });
$("#legs").addEventListener("mousedown", e => { if(e.target.closest("[data-sg]")) e.preventDefault(); });
$("#legs").addEventListener("change", e => {
  const row = e.target.closest(".leg"); if(!row) return; const l = state.legs[Number(row.dataset.i)];
  if(e.target.classList.contains("ty")){ l.type = e.target.value; renderLegs(); }
  if(e.target.classList.contains("rs")){ l.result = e.target.value; autoResult(); syncCash(); }
});
$("#legs").addEventListener("click", e => {
  const sg = e.target.closest("[data-sg]");
  if(sg){ const i = Number(sg.dataset.sg), it = sg.parentElement._items[Number(sg.dataset.k)], l = state.legs[i];
    if(it.player !== undefined){ l.player = it.player; l.espnId = it.espnId || ""; if(it.team){ l.team = it.team; l.teamId = it.teamId || l.teamId; } }
    else { l.team = it.team; l.teamId = it.teamId || "";
      const league = ESPN.leagueFor($("#f-sport").value);
      if(l.teamId && league && ESPN.enabled()){ ESPN.roster(league, l.teamId).catch(()=>{}); const pl = document.getElementById("leg-player-"+i); if(pl) pl.placeholder = "Player (type to search roster)"; } }
    const pl = document.getElementById("leg-player-"+i), tm = document.getElementById("leg-team-"+i);
    if(pl) pl.value = l.player; if(tm) tm.value = l.team;
    sg.parentElement.hidden = true; updateWarn(i);
    (it.player !== undefined && !l.team ? tm : document.getElementById("leg-pick-"+i))?.focus();
    return; }
  const rm = e.target.closest("[data-rm]"); if(!rm) return;
  state.legs.splice(Number(rm.dataset.rm),1);
  if(!state.legs.length) state.legs.push(newLeg(state.market==="Parlay"?"Spread":state.market));
  renderLegs(); autoOdds(); syncForm();
});
$("#addLeg").addEventListener("click", () => {
  const last = state.legs[state.legs.length-1];
  if(state.legs.length===1) state.legs[0].odds = state.legs[0].odds || parseOdds($("#f-odds").value);
  const nl = newLeg(state.market==="Parlay" ? (last?.type || "Spread") : state.market);
  if(legTypeOf(nl)==="Player prop" && last){ nl.team = last.team; nl.teamId = last.teamId || ""; }
  state.legs.push(nl);
  if(state.legs.length===2){ state.oddsTouched = false; $("#f-odds").value = ""; }
  renderLegs(); autoOdds(); syncForm();
  const i = state.legs.length-1; (document.getElementById("leg-player-"+i) || document.getElementById("leg-pick-"+i))?.focus();
});
$("#f-market").addEventListener("click", e => { const m = e.target.closest("button")?.dataset.m; if(m) setMarket(m); });
$("#f-conf").addEventListener("click", e => { const c = e.target.closest("button")?.dataset.c; if(c){ state.conf = Number(c); syncForm(); } });
$("#f-sport").addEventListener("input", () => state.legs.forEach((l,i) => { if(document.activeElement?.id==="leg-team-"+i) showSugg(i,"team"); }));

/* Price: fill in odds from cost + payout, or payout from odds. Whichever you typed last wins. */
function syncPrice(){
  const st = Number($("#f-stake").value), o = parseOdds($("#f-odds").value), pay = Number($("#f-payout").value);
  if(!(st>0)) return;
  if(state.priceSrc === "odds" && o) $("#f-payout").value = (st*dec(o)).toFixed(2);
  else if(state.priceSrc === "payout" && pay > st) $("#f-odds").value = fmtOdds(toAmerican(pay/st));
}
$("#f-odds").addEventListener("input", () => { state.priceSrc = $("#f-odds").value.trim() ? "odds" : null; if(state.legs.length>1) state.oddsTouched = !!$("#f-odds").value.trim(); syncPrice(); syncForm(); });
$("#f-payout").addEventListener("input", () => { state.priceSrc = $("#f-payout").value.trim() ? "payout" : null; if($("#f-payout").value.trim()) state.oddsTouched = true; syncPrice(); syncForm(); });
$("#f-stake").addEventListener("input", () => { syncPrice(); syncForm(); });

function syncCash(){
  $("#cashRow").hidden = $("#f-result").value !== "cashed"; $("#afterField").hidden = state.legs.length > 1;
}
$("#f-result").addEventListener("change", syncCash);
function syncForm(){
  syncCash();
  document.querySelectorAll("#f-market button").forEach(b => b.setAttribute("aria-pressed", b.dataset.m===state.market));
  document.querySelectorAll("#f-conf button").forEach(b => b.setAttribute("aria-pressed", Number(b.dataset.c)===state.conf));
  const o = parseOdds($("#f-odds").value), st = Number($("#f-stake").value), pay = Number($("#f-payout").value);
  const odds = o || (st>0 && pay>st ? toAmerican(pay/st) : null), payout = pay>0 ? pay : (o && st>0 ? st*dec(o) : null);
  $("#calc").innerHTML = odds ? `<span>Odds ${fmtOdds(odds)}</span><span>Needs to hit ${pct(imp(odds))} to break even</span>${payout&&st>0?`<span>Profit if it hits ${money(payout-st)}</span>`:""}${state.unit&&st>0?`<span>${(st/state.unit).toFixed(1)}u</span>`:""}`
    : `<span>Enter odds or the payout and the other fills in. Both are optional.</span>`;
}
function resetForm(){
  $("#slip").reset(); $("#f-date").value = today(); state.market="Spread"; state.conf=3; state.editing=null;
  state.legs = [newLeg("Spread")]; state.oddsTouched = false; state.priceSrc = null;
  $("#saveBtn").textContent = "Add to my book"; $("#cancelEdit").hidden = true; $("#formErr").hidden = true; renderLegs(); syncForm();
}
$("#cancelEdit").addEventListener("click", resetForm);
$("#slip").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#formErr"), stake = Number($("#f-stake").value);
  const oddsRaw = $("#f-odds").value.trim(), payRaw = $("#f-payout").value.trim(), closeRaw = $("#f-close").value.trim();
  const odds = oddsRaw ? parseOdds(oddsRaw) : null, payout = payRaw ? Number(payRaw) : null, close = closeRaw ? parseOdds(closeRaw) : null;
  const legs = state.legs.filter(l => l.pick.trim() || l.player.trim()).map(l => { const type = legTypeOf(l);
    const prop = type==="Player prop";
    return { type, player: prop ? l.player.trim() : "", team: prop ? l.team.trim() : "", teamId: prop ? (l.teamId||"") : "", espnId: prop ? (l.espnId||"") : "", pick: l.pick.trim(), odds: l.odds || null, result: l.result }; });
  const result = $("#f-result").value, cashout = result==="cashed" ? Number($("#f-cash").value) : null;
  const bad = !legs.length ? "Add at least one pick." : (state.market==="Parlay" && legs.length<2) ? "A parlay needs at least 2 picks. For one pick, use its own section."
    : !(stake>0) ? "Enter what it cost you." : (oddsRaw && !odds) ? "Odds need to be American format, like -110 or +150, or leave them blank."
    : (payout!==null && !(payout>0)) ? "Payout should be the total you'd get back if it hits." : (closeRaw && !close) ? "Closing odds need to be American format, like -120."
    : (result==="cashed" && !($("#f-cash").value!=="" && cashout>=0)) ? "Enter how much you cashed out for." : "";
  if(bad){ err.textContent = bad; err.hidden = false; return; }
  err.hidden = true;
  const prev = state.editing ? state.bets.find(b=>b.id===state.editing) : null;
  if(legs.length===1){ legs[0].result = result==="cashed" ? $("#f-after").value : result; legs[0].odds = odds; }
  const draft = { market: state.market, legs, legCount: (prev?.legCount && legs.length===1) ? prev.legCount : null };
  const bet = { kind:"bet", date: $("#f-date").value || today(), sport: $("#f-sport").value.trim(), ...draft,
    pick: titleOf(draft), odds, payout, stake, conf: state.conf, reason: $("#f-reason").value.trim(), result, cashout, close, notes: $("#f-notes").value.trim(),
    log: prev?.log || [], espn: prev?.espn || null, createdAt: prev?.createdAt || new Date().toISOString(), example: prev?.example || false, analysis: prev?.analysis || null };
  const id = prev?.id || ("b" + Date.now().toString(36) + Math.random().toString(36).slice(2,6));
  try { await put(id, bet); resetForm(); } catch(x){ err.textContent = "Couldn't save that bet. " + (x?.message||"Try again."); err.hidden = false; }
});
function loadIntoForm(b){
  state.editing = b.id; state.market = b.market; state.conf = b.conf || 3;
  state.legs = b.legs.map(l => ({...l})); state.oddsTouched = true; state.priceSrc = null;
  $("#f-date").value=b.date; $("#f-sport").value=b.sport; $("#f-odds").value=b.odds?fmtOdds(b.odds):""; $("#f-payout").value=b.payout??""; $("#f-stake").value=b.stake;
  $("#f-reason").value=b.reason||""; $("#f-cash").value = b.cashout ?? ""; $("#f-after").value = b.legs.length===1 && b.result==="cashed" ? (b.legs[0].result||"pending") : "pending";
  $("#f-result").value=b.result; $("#f-close").value=b.close?fmtOdds(b.close):""; $("#f-notes").value=b.notes||"";
  renderLegs();
  $("#saveBtn").textContent = "Save changes"; $("#cancelEdit").hidden = false; syncForm();
  $("#slip-h").scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block:"start"});
}
$("#f-unit").addEventListener("change", async () => { const u = Number($("#f-unit").value); if(u>0){ state.unit = u; await putMeta("_settings",{unit:u}).catch(()=>{}); renderAll(); syncForm(); } });

/* ---------- storage ---------- */
/* Everything is saved in this browser (localStorage). Use Export backup in Settings to keep a copy. */
const LS = "betcoach.v1";
function localLoad(){ try { const d = JSON.parse(localStorage.getItem(LS)||"null"); if(d){ state.bets=(d.bets||[]).map(normalize); state.unit=d.unit||10; state.review=d.review||null; } } catch {} }
function localSave(){ try { localStorage.setItem(LS, JSON.stringify({bets:state.bets, unit:state.unit, review:state.review})); } catch {} }
async function put(id, data){
  if(coll) return coll.doc(id).set(data);
  const i = state.bets.findIndex(b=>b.id===id); const rec = normalize({...data, id});
  if(i>=0) state.bets[i]=rec; else state.bets.push(rec); localSave(); renderAll(); kickLive();
}
async function patch(id, data){
  if(coll) return coll.doc(id).update(data);
  const b = state.bets.find(b=>b.id===id); if(b) Object.assign(b,data); localSave(); renderAll();
}
async function remove(id){
  if(coll) return coll.doc(id).delete();
  state.bets = state.bets.filter(b=>b.id!==id); localSave(); renderAll();
}
async function putMeta(id, data){
  if(coll) return coll.doc(id).set(data);
  if(id==="_settings") state.unit = data.unit; if(id==="_review") state.review = data; localSave();
}

/* ---------- examples ---------- */
const EXAMPLES = [
  {date:"2026-10-18",sport:"NFL",market:"Spread",legs:[{pick:"Chiefs -3.5"}],odds:-110,stake:20,conf:3,reason:"Coming off a bye and they're the better team.",result:"won",close:-130,notes:"Example: line closed at -4.5. Won by 10, pulled away in the 4th."},
  {date:"2026-10-18",sport:"NCAAF",market:"Parlay",legs:[
    {type:"Spread",pick:"Home favorite -14.5",odds:-110,result:"won"},{type:"Moneyline",pick:"Road favorite ML",odds:-400,result:"won"},
    {type:"Total",pick:"Over 52.5",odds:-110,result:"won"},{type:"Moneyline",pick:"Ranked favorite ML",odds:-350,result:"lost"}],
    odds:486,stake:10,conf:4,reason:"All favorites, felt safe.",result:"lost",close:null,notes:"Example: 3 of 4 hit. Last leg lost on a late TD."},
  {date:"2026-10-19",sport:"NBA",market:"Player prop",legs:[
    {player:"Example Guard",team:"Example Team",pick:"O 24.5 pts",odds:-125,result:"lost"},{player:"Example Guard",team:"Example Team",pick:"O 5.5 ast",odds:-140,result:"won"}],
    odds:null,payout:115,stake:40,conf:5,reason:"He dropped 35 last game, he's hot.",result:"lost",close:null,notes:"Example: 19 pts and 8 ast in 31 minutes. Team won by 22 so he sat the 4th.",
    log:[{when:"after",text:"Example: blowouts kill his scoring props. He sits the 4th when they're up big.",at:"2026-10-19T23:30:00Z",remind:{player:"Example Guard",team:"Example Team",stat:"points"}}]},
  {date:"2026-10-24",sport:"NCAAF",market:"Moneyline",legs:[{pick:"Home underdog ML"}],odds:165,stake:15,conf:2,reason:"Line opened +200 and I grabbed +165 before more movement. Their QB is back from injury and the number hasn't fully adjusted.",result:"pending",close:null,notes:"",
    log:[{when:"during",text:"Example: up 7 at the half, their QB looks healthy.",at:"2026-10-24T20:15:00Z"}]},
];
document.addEventListener("click", async e => {
  if(e.target.id==="loadEx"){ e.target.disabled = true; let t = Date.now();
    for(const [i,x] of EXAMPLES.entries()){
      const legs = x.legs.map(l => ({ type: l.type || x.market, player: l.player||"", team: l.team||"", pick: l.pick, odds: l.odds ?? (x.legs.length===1 ? x.odds : null), result: l.result || x.result }));
      const draft = { market: x.market, legs, legCount: null };
      await put("ex"+i, {kind:"bet", payout:null, log:[], ...x, ...draft, pick:titleOf(draft), example:true, analysis:null, createdAt:new Date(t+i).toISOString()}).catch(()=>{}); } }
  if(e.target.id==="clearEx"){ e.target.disabled = true; for(const b of state.bets.filter(b=>b.example)) await remove(b.id).catch(()=>{}); }
  const f = e.target.closest("[data-f]"); if(f){ state.filter = f.dataset.f; renderTickets(); }
  const uw = e.target.closest("[data-unwatch]");
  if(uw){ const [id, idx] = uw.dataset.unwatch.split(":"), b = state.bets.find(x=>x.id===id); if(!b) return;
    const log = b.log.map((n,i) => i===Number(idx) ? {...n, remind:null} : n); uw.disabled = true; await patch(id, {log}).catch(()=>{ uw.disabled = false; }); }
});

/* ---------- ticket actions & notes ---------- */
$("#tickets").addEventListener("input", e => {
  const d = state.noteDraft; if(!d) return;
  if(e.target.id==="note-text") d.text = e.target.value;
  if(e.target.id==="note-player") d.player = e.target.value;
  if(e.target.id==="note-team") d.team = e.target.value;
  if(e.target.id==="note-stat") d.stat = e.target.value;
});
$("#tickets").addEventListener("change", e => {
  if(e.target.id==="note-remind" && state.noteDraft){ state.noteDraft.remind = e.target.checked; renderTickets(); document.getElementById(e.target.checked?"note-player":"note-text")?.focus(); }
});
$("#tickets").addEventListener("click", async e => {
  const wb = e.target.closest("[data-when]");
  if(wb && state.noteDraft){ state.noteDraft.when = wb.dataset.when; renderTickets(); document.getElementById("note-text")?.focus(); return; }
  const btn = e.target.closest("[data-act]"); if(!btn) return;
  const id = btn.closest(".ticket").dataset.id, b = state.bets.find(x=>x.id===id), act = btn.dataset.act; if(!b) return;
  if(["won","lost","push"].includes(act)){ await patch(id,{result:act}).catch(()=>{}); return; }
  if(act==="edit"){ loadIntoForm(b); return; }
  if(act==="cash"){ loadIntoForm(b); $("#f-result").value = "cashed"; syncCash(); setTimeout(()=>$("#f-cash").focus({preventScroll:true}), 300); return; }
  if(act==="note"){
    const pl = b.legs.find(l=>l.player);
    state.noteOpen = id; state.noteDraft = { when: b.result==="pending" ? "during" : "after", text:"", remind:false, player: pl?.player||"", team: pl?.team||"", stat:"" };
    renderTickets(); document.getElementById("note-text")?.focus(); return; }
  if(act==="closeNote"){ state.noteOpen = null; state.noteDraft = null; renderTickets(); return; }
  if(act==="saveNote"){
    const d = state.noteDraft, er = document.getElementById("note-err");
    const fail = !d.text.trim() ? "Write the note first." : (d.remind && !d.player.trim()) ? "Add the player this warning is about." : "";
    if(fail){ er.textContent = fail; er.hidden = false; return; }
    const note = { when: d.when, text: d.text.trim(), at: new Date().toISOString() };
    if(d.remind){ const leg = b.legs.find(l => norm(l.player) === norm(d.player));
      note.remind = { player: d.player.trim(), team: d.team.trim(), stat: d.stat.trim(), espnId: leg?.espnId || "", teamId: leg?.teamId || "" }; }
    btn.disabled = true;
    try { await patch(id, { log: [...b.log, note] }); state.noteOpen = null; state.noteDraft = null; renderAll(); }
    catch(x){ btn.disabled = false; er.textContent = "Couldn't save the note. Try again."; er.hidden = false; }
    return; }
  if(act==="del"){ if(delArm===id){ delArm=null; await remove(id).catch(()=>{}); } else { delArm=id; renderTickets(); setTimeout(()=>{ if(delArm===id){ delArm=null; renderTickets(); } },3500); } return; }
  if(act==="applyLive"){ applyLive(b); return; }
  if(act==="refreshLive"){ btn.disabled = true; await refreshLive(true); return; }
  if(act==="ask") analyzeBet(b);
});

/* ---------- coach (Claude) ---------- */
const COACH = `You're a sharp, honest sports betting coach talking to a newer bettor who wants to learn. Be direct and casual, no fluff, no lecturing, and use concrete numbers.
Core rules:
- Separate PROCESS from RESULT. A bet can be good and lose, or bad and win. Say which this was.
- Use the price math when a price is known: implied probability, the vig, break-even win rate, and closing line value when a closing price is given (if his odds imply a lower probability than the closing odds, he beat the close). If no odds or payout were logged, say the math can't be checked and ask him to log the payout next time.
- Only use game facts the bettor wrote (reasoning, what happened, and his time-stamped notes from before, during and after the bet) and the ESPN box score line when one is attached; that box score is official and outranks his memory. Never invent scores, stats, injuries or news. If something important is missing, say what he should record next time.
- Judge his stated reasoning: is it a real edge (information or a number the market hasn't caught up to, shopping for a better line, a specific matchup the line underrates) or a narrative, recency bias, fandom, or gut feel?
- Use his saved watch-outs: if a pick goes against a warning he wrote himself, call it out.
- For cash-outs, a sale can be right even if the bet would have hit, and wrong even if it would have missed; judge the price he took against the odds of the remaining legs at the time he sold.
- For any multi-pick slip (a mixed parlay or a same-type parlay like several player props), explain how stacking legs multiplies the house edge, say which leg sank it if one did, and whether the legs would have been better as straight bets.`;
function betLine(b){
  const lg = l => `${l.player?`${l.player}${l.team?` (${l.team})`:""} `:""}${l.pick}`;
  const picks = isMulti(b) ? `${titleOf(b)}: ` + b.legs.map((l,i)=>`leg ${i+1} [${l.type}] ${lg(l)}${l.odds?` (${fmtOdds(l.odds)})`:""} → ${l.result==="won"?"hit":l.result==="lost"?"missed":l.result}`).join("; ") : lg(b.legs[0]||{pick:b.pick});
  const o = effOdds(b), pay = payoutOf(b);
  const cash = b.result==="cashed" ? ` | CASHED OUT for ${money(Number(b.cashout)||0)}${pay!==null?` (full payout would be ${money(pay)})`:""}${rideReturn(b)===null?", final outcome not logged":`, holding would have returned ${money(rideReturn(b))}`}` : "";
  const notes = (b.log.length ? ` | notes: ` + b.log.map(n=>`[${WHEN[n.when]||n.when}] ${n.text}`).join(" / ") : "") + (b.espn ? ` | ESPN box score: ${b.espn}` : "");
  return `${b.date} | ${b.sport} | section: ${b.market}${isMulti(b)&&b.market!=="Parlay"?" (same-type parlay)":""} | ${picks} | ${o!==null?`odds ${fmtOdds(o)}`:"odds not logged"}${pay!==null?` | payout ${money(pay)}`:""} | cost ${money(b.stake)} | conf ${b.conf||"?"}/5 | status ${b.result==="pending"?"in progress":b.result}${cash}${b.close?` | close ${fmtOdds(b.close)}`:""}${b.reason?` | why: ${b.reason}`:""}${b.notes?` | what happened: ${b.notes}`:""}${notes}`;
}
function summaryText(){ const s = compute(state.bets);
  return `Overall: ${s.w}-${s.l}-${s.p}${s.c?` with ${s.c} cash-outs`:""}, profit ${signMoney(s.profit)} on ${money(s.staked)} risked (ROI ${s.roi===null?"n/a":pct(s.roi)}), win rate ${s.winPct===null?"n/a":pct(s.winPct)} vs break-even ${s.be===null?"n/a":pct(s.be)}, median stake ${money(median(state.bets.map(b=>b.stake)))}, unit ${money(state.unit||0)}.`; }
const watchText = ws => ws.length ? ws.map(w=>`- ${w.player}${w.team?` (${w.team})`:""}${w.stat?` [${w.stat}]`:""}: ${w.text}`).join("\n") : "none";
async function analyzeBet(b){
  if(running.has(b.id)) return; running.add(b.id); renderTickets();
  const v = b.result==="push" ? "pushed" : b.result==="cashed" ? "cashed out" : b.result;
  const fmt = b.result==="cashed"
    ? `He cashed this bet out early. Judge BOTH the original bet and the decision to sell. Compare the cash-out amount to the full payout and to the fair value of the position (rough probability the remaining legs hit × full payout) using only the facts he logged. Books build extra margin into cash-out offers, so say so if that applies.
Format exactly:
Line 1: one of "Good bet, cashed out" / "Toss-up, cashed out" / "Bad bet, cashed out"
Then sections with "## " headings: "## The cash-out" (was selling smart, with the numbers), "## The original bet", "## Your read", "## Next time" (2-3 bullets starting with "- "). Under 240 words.`
    : b.result==="pending"
    ? `This bet is still in progress or not placed yet. Use any during-the-bet notes he logged. Format exactly:
Line 1: one of "Good bet, pending" / "Toss-up, pending" / "Bad bet, pending"
Then sections with "## " headings: "## The math", "## Your read", "## What would make this better" (2-3 bullets starting with "- "). Under 180 words.`
    : `Format exactly:
Line 1: one of "Good bet, ${v}" / "Toss-up, ${v}" / "Bad bet, ${v}"
Then sections with "## " headings: "## ${b.result==="won"?"Why it hit":b.result==="lost"?"Why it missed":"Why it pushed"}", "## The math", "## Your read", "## Next time" (2-3 bullets starting with "- "). Under 230 words.`;
  const o = effOdds(b);
  const ws = b.legs.flatMap(l => warningsFor(l, b.id));
  const prompt = `${COACH}\n\n${fmt}\n\nThe bet:\n${betLine(b)}\n${o!==null?`Implied probability at his price: ${pct(imp(o))}.`:"No price logged."}${b.close&&o!==null?` Implied at close: ${pct(imp(b.close))}.`:""}\n\nHis saved watch-outs that match players on this bet:\n${watchText(ws)}\n\nHis history for context: ${summaryText()}`;
  let text = "";
  try {
    const r = await sample(prompt, { modelTier:"default", cache:false, onText: ({text:t}) => { text = t; const el = document.getElementById("an-"+b.id); if(el) el.innerHTML = md(t); } });
    text = r.text || text;
    running.delete(b.id);
    await patch(b.id, { analysis: text, analyzedAt: new Date().toISOString() });
  } catch(x){
    running.delete(b.id);
    if(x?.code==="manual"){ state.manual[b.id] = x.prompt; renderTickets(); return; }
    const msg = x?.code==="api" ? `The coach couldn't run: ${x.message}` : x?.code==="not_granted" ? "The coach needs permission to run. Allow it from this page's permissions to use it." : x?.code==="rate_limited" ? "The coach is busy. Wait a minute and try again." : "The coach couldn't finish that read. Try again.";
    if(x?.text) await patch(b.id,{analysis:x.text}).catch(()=>{});
    renderTickets(); const el = document.getElementById("an-"+b.id);
    if(el) el.insertAdjacentHTML("beforeend", `<p class="err">${msg}</p>`); else { $("#banner").hidden = false; $("#banner").textContent = msg; }
  }
  renderTickets();
}
$("#reviewBtn").addEventListener("click", async () => {
  const settled = state.bets.filter(b=>b.result!=="pending"), out = $("#reviewOut"), btn = $("#reviewBtn");
  if(settled.length < 5){ out.innerHTML = `<p class="hint">Log at least 5 settled bets first (you have ${settled.length}). Fewer than that and any "pattern" is just noise.</p>`; return; }
  running.add("_review"); btn.disabled = true; btn.textContent = "Reviewing…"; out.innerHTML = `<p class="thinking">Coach is going through your book…</p>`;
  const recent = [...state.bets].sort(byTime).slice(-80);
  const fl = flags(state.bets).map(f => `- ${f.h}: ${f.d}`).join("\n");
  const splits = [...group(state.bets,b=>b.market), ...group(state.bets,b=>b.sport.toUpperCase())].map(r=>`${r.k}: ${r.w}-${r.l}-${r.p}, ${signMoney(r.profit)}, ROI ${r.roi===null?"n/a":pct(r.roi)}`).join("\n");
  const prompt = `${COACH}

Review his whole betting history and teach him what he's doing wrong. Format exactly, with "## " headings:
"## The verdict" (2 sentences: is he winning or losing, and is that skill or variance given the sample size)
"## Where you're leaking money" (top 3 leaks, each a bullet with the specific numbers from his data)
"## What's working" (1-2 bullets, or say honestly if nothing is yet)
"## Your rules for the next 20 bets" (3-5 short, concrete, checkable rules as bullets; turn any repeated lessons from his notes into rules)
Under 380 words. Bullets start with "- ".

${summaryText()}

Splits:
${splits}

Automatic flags:
${fl}

His saved watch-outs:
${watchText(allWatch())}

Bets (oldest to newest):
${recent.map(betLine).join("\n")}`;
  try {
    const r = await sample(prompt, { modelTier:"complex", cache:false, onText: ({text}) => { out.innerHTML = md(text); } });
    state.review = { text: r.text, at: new Date().toISOString(), n: settled.length };
    running.delete("_review");
    await putMeta("_review", state.review).catch(()=>{});
  } catch(x){
    running.delete("_review");
    btn.disabled = false; btn.textContent = "Review my betting";
    if(x?.code==="manual"){ state.manual._review = x.prompt; out.innerHTML = manualHTML("_review"); return; }
    if(x?.code==="api"){ out.innerHTML = `<p class="err">The coach couldn't run: ${esc(x.message)}</p>`; return; }
    out.innerHTML = (x?.text ? md(x.text) : "") + `<p class="err">${x?.code==="rate_limited" ? "The coach is busy. Wait a minute and try again." : x?.code==="not_granted" ? "The coach needs permission to run. Allow it from this page's permissions." : "The review didn't finish. Try again."}</p>`;
  }
  btn.disabled = false; btn.textContent = "Review my betting"; if(!running.has("_review") && state.review) renderReview();
});

/* ---------- coach engine ----------
   With an API key in Settings, the coach calls Claude directly and streams the answer.
   Without one, it throws {code:"manual"} and the page shows a copy-to-Claude panel instead. */
const SETTINGS_KEY = "betcoach.settings";
const DEFAULT_MODEL = "claude-sonnet-5-5";
let settings = { apiKey: "", model: "" };
function loadSettings(){ try { settings = { ...settings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; } catch {} }
function saveSettings(){ try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} }

async function askCoach(prompt, opts = {}){
  if(!settings.apiKey) throw { code: "manual", prompt };
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: settings.model || DEFAULT_MODEL, max_tokens: 1500, stream: true, messages: [{ role: "user", content: prompt }] })
    });
  } catch { throw { code: "api", message: "No connection. Check your internet and try again." }; }
  if(!res.ok){
    let msg = `error ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
    if(res.status === 401) msg = "Your API key was rejected. Check it in Settings.";
    throw { code: "api", message: msg };
  }
  const reader = res.body.getReader(), td = new TextDecoder();
  let buf = "", text = "";
  for(;;){
    const { done, value } = await reader.read(); if(done) break;
    buf += td.decode(value, { stream: true });
    let nl;
    while((nl = buf.indexOf("\n")) >= 0){
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if(!line.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(line.slice(5));
        if(ev.type === "content_block_delta" && ev.delta?.type === "text_delta"){ text += ev.delta.text; opts.onText?.({ text, delta: ev.delta.text }); }
        if(ev.type === "error") throw { code: "api", message: ev.error?.message || "The coach stopped early." };
      } catch(e){ if(e?.code) throw e; }
    }
  }
  return { text };
}

/* Copy-to-Claude panel, used when there's no API key. key = a bet id, or "_review" for the full review. */
state.manualDraft = {};
function manualHTML(key){
  return `<div class="manual">
    <b>Get the coach's read from Claude</b>
    <ol>
      <li><button class="btn small primary" type="button" data-mcopy="${esc(key)}">Copy coach prompt</button> <span class="hint" id="mc-${esc(key)}"></span></li>
      <li>Open <a href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai</a>, paste it and send.</li>
      <li>Paste Claude's answer below and save it.</li>
    </ol>
    <textarea id="mprompt-${esc(key)}" readonly hidden aria-label="Coach prompt to copy">${esc(state.manual[key])}</textarea>
    <textarea id="mans-${esc(key)}" aria-label="Claude's answer" placeholder="Paste Claude's answer here">${esc(state.manualDraft[key] || "")}</textarea>
    <div class="actions"><button class="btn small primary" type="button" data-msave="${esc(key)}">Save answer</button><button class="btn small ghost" type="button" data-mcancel="${esc(key)}">Cancel</button></div>
    <span class="hint">Add an API key in Settings to get answers right here instead.</span>
  </div>`;
}
document.addEventListener("input", e => { if(e.target.id?.startsWith("mans-")) state.manualDraft[e.target.id.slice(5)] = e.target.value; });
document.addEventListener("click", async e => {
  const cp = e.target.closest("[data-mcopy]");
  if(cp){ const key = cp.dataset.mcopy, msg = document.getElementById("mc-" + key);
    try { await navigator.clipboard.writeText(state.manual[key]); msg.textContent = "Copied."; }
    catch { const ta = document.getElementById("mprompt-" + key); ta.hidden = false; ta.focus(); ta.select(); msg.textContent = "Copy the selected text."; }
    return; }
  const sv = e.target.closest("[data-msave]");
  if(sv){ const key = sv.dataset.msave, text = (document.getElementById("mans-" + key)?.value || "").trim();
    if(!text) return;
    delete state.manual[key]; delete state.manualDraft[key];
    if(key === "_review"){ state.review = { text, at: new Date().toISOString(), n: state.bets.filter(b=>b.result!=="pending").length }; await putMeta("_review", state.review); renderReview(); }
    else await patch(key, { analysis: text, analyzedAt: new Date().toISOString() });
    return; }
  const cc = e.target.closest("[data-mcancel]");
  if(cc){ const key = cc.dataset.mcancel; delete state.manual[key]; delete state.manualDraft[key]; if(key === "_review") renderReview(); else renderTickets(); }
});

/* ---------- settings, backup ---------- */
$("#s-save").addEventListener("click", () => {
  settings.apiKey = $("#s-key").value.trim(); settings.model = $("#s-model").value.trim(); saveSettings();
  $("#s-msg").textContent = settings.apiKey ? "Saved. The coach will answer here." : "Saved. The coach will give you a prompt for Claude.";
});
function backupData(){ return { app: "bet-coach", version: 1, exportedAt: new Date().toISOString(), unit: state.unit, review: state.review, bets: state.bets }; }
$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(backupData(), null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `bet-coach-backup-${today()}.json`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $("#io-msg").textContent = `Exported ${state.bets.length} bets.`;
});
$("#importFile").addEventListener("change", async e => {
  const file = e.target.files?.[0]; if(!file) return;
  try {
    const data = JSON.parse(await file.text());
    if(!Array.isArray(data?.bets)) throw new Error("not a backup");
    const byId = new Map(state.bets.map(b => [b.id, b]));
    for(const b of data.bets) if(b && b.id && b.kind === "bet") byId.set(b.id, normalize(b));
    state.bets = [...byId.values()];
    if(data.unit) state.unit = data.unit;
    if(data.review && !state.review) state.review = data.review;
    localSave(); renderAll(); syncForm();
    $("#io-msg").textContent = `Imported ${data.bets.length} bets. You now have ${state.bets.length}.`;
  } catch { $("#io-msg").textContent = "That file isn't a Bet Coach backup. Pick the .json file you exported."; }
  e.target.value = "";
});

/* ---------- live tracking (ESPN) ----------
   For in-progress bets from the last couple of days, pull the score and box score,
   show progress on each pick, and suggest a result once it's decided. */
state.espn = {};          // bet id -> latest tracking result
let liveTimer = null, liveBusy = false;
const STATUS_TEXT = { hit:"Hit", miss:"Miss", push:"Push", void:"Void", live:"Live", pre:"Not started", unknown:"—" };
function trackable(b){
  if(b.result !== "pending" || !ESPN.enabled() || !ESPN.leagueFor(b.sport)) return false;
  const days = (new Date(today()+"T12:00:00") - new Date(b.date+"T12:00:00")) / 864e5;
  return days <= 2 && days >= -1;
}
function liveHTML(b){
  const t = state.espn[b.id];
  if(!t) return trackable(b) ? `<div class="live"><span class="live-src">Checking ESPN…</span></div>` : "";
  if(t.err) return `<div class="live"><span class="live-src">Live tracking unavailable: ${esc(t.err)}</span></div>`;
  const games = t.games.map(g => `<span class="game ${g.state}"><b>${esc(g.away?.abbr||g.away?.short)} ${g.away?.score ?? ""} · ${esc(g.home?.abbr||g.home?.short)} ${g.home?.score ?? ""}</b> ${esc(g.state==="pre" ? new Date(g.date).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}) : g.detail)}</span>`).join("");
  const legs = t.legs.map(l => {
    const pct = l.value != null && l.line != null && l.dir === "over" ? Math.min(1, l.value / (Math.floor(l.line) + 1)) : null;
    const target = l.line != null && l.dir ? `${l.dir==="over"?"need":"under"} ${l.dir==="over" ? Math.floor(l.line)+1 : l.line}` : "";
    return `<div class="live-leg ${l.status}${l.locked?" locked":""}">
      <span class="ll">${esc(l.label)}</span>
      <span class="lst">${STATUS_TEXT[l.status]||""}${l.locked?" ✓":""}</span>
      <span class="lv">${esc(l.text||"")}${target && l.value != null ? ` <small>(${esc(target)})</small>` : ""}</span>
      ${pct !== null ? `<span class="bar" aria-hidden="true"><i style="width:${(pct*100).toFixed(0)}%"></i></span>` : ""}
    </div>`; }).join("");
  const sug = t.suggestion ? `<div class="suggest"><span>${t.games.every(g=>g.state==="post") ? "Final." : "Already decided."} This bet ${t.suggestion.result==="won"?"<b class=\"pos\">won</b>":t.suggestion.result==="lost"?"<b class=\"neg\">lost</b>":"<b>pushed</b>"}.</span><button class="btn small primary" type="button" data-act="applyLive">Mark as ${t.suggestion.result==="won"?"won":t.suggestion.result==="lost"?"lost":"push"}</button></div>` : "";
  return `<div class="live">${games ? `<div class="games">${games}</div>` : ""}${legs}${sug}
    <div class="live-src">ESPN · updated ${new Date(t.at).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})} <button class="linkbtn" type="button" data-act="refreshLive">Refresh</button></div></div>`;
}
async function refreshLive(force){
  clearTimeout(liveTimer);
  if(liveBusy || !ESPN.enabled()) return;
  liveBusy = true;
  const bets = state.bets.filter(trackable);
  for(const b of bets){
    try { const t = await ESPN.trackBet(b); if(t) state.espn[b.id] = t; else delete state.espn[b.id]; }
    catch(e){ state.espn[b.id] = { err: e?.message || "couldn't reach ESPN", at: Date.now() }; }
  }
  for(const id of Object.keys(state.espn)) if(!bets.some(b => b.id === id)) delete state.espn[id];
  liveBusy = false;
  const typing = document.activeElement && document.getElementById("tickets").contains(document.activeElement) && /TEXTAREA|INPUT/.test(document.activeElement.tagName);
  if(!typing) renderTickets();
  // Poll every minute while a game is live, every 10 minutes before tip-off, and not at all once everything's final.
  const ts = Object.values(state.espn);
  const live = ts.some(t => t.games?.some(g => g.state === "in")), pre = ts.some(t => t.games?.some(g => g.state === "pre") || t.legs?.some(l => l.status === "unknown"));
  const wait = live ? 60e3 : pre ? 10*60e3 : 0;
  if(wait && document.visibilityState === "visible") liveTimer = setTimeout(refreshLive, wait);
}
async function applyLive(b){
  const t = state.espn[b.id]; if(!t?.suggestion) return;
  const legs = b.legs.map((l, i) => ({ ...l, result: t.suggestion.legResults[i] ?? l.result }));
  await patch(b.id, { result: t.suggestion.result, legs, espn: t.suggestion.summary }).catch(()=>{});
  delete state.espn[b.id]; renderAll();
}
document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") refreshLive(); });
let liveKick = null;
const kickLive = () => { clearTimeout(liveKick); liveKick = setTimeout(refreshLive, 1500); };

/* ESPN settings */
const ESPN_KEY = "betcoach.espn";
let espnSettings = { enabled: true, proxy: "" };
try { espnSettings = { ...espnSettings, ...JSON.parse(localStorage.getItem(ESPN_KEY) || "{}") }; } catch {}
ESPN.configure(espnSettings);
$("#e-on").checked = espnSettings.enabled; $("#e-proxy").value = espnSettings.proxy;
$("#e-save").addEventListener("click", () => {
  espnSettings = { enabled: $("#e-on").checked, proxy: $("#e-proxy").value.trim() };
  try { localStorage.setItem(ESPN_KEY, JSON.stringify(espnSettings)); } catch {}
  ESPN.configure(espnSettings); state.espn = {}; renderTickets(); refreshLive(true);
  $("#e-msg").textContent = espnSettings.enabled ? "Saved." : "Saved. Live data is off.";
});
$("#e-test").addEventListener("click", async () => {
  const m = $("#e-msg"); m.textContent = "Testing…";
  ESPN.configure({ proxy: $("#e-proxy").value.trim() });
  try { m.textContent = await ESPN.test(); } catch(e){ m.textContent = e?.message || "Couldn't reach ESPN."; }
  ESPN.configure(espnSettings);
});

/* ---------- install button (Chrome/Edge/Android show it; iPhone uses Share > Add to Home Screen) ---------- */
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#installBtn").hidden = false; });
$("#installBtn").addEventListener("click", async () => { if(!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(()=>{}); installEvt = null; $("#installBtn").hidden = true; });

/* ---------- boot ---------- */
sample = askCoach;
loadSettings();
$("#s-key").value = settings.apiKey; $("#s-model").value = settings.model;
const baseRender = renderAll;
renderAll = function(){ baseRender(); $("#status").textContent = `${state.bets.length} bet${state.bets.length===1?"":"s"} · saved on this device`; };
localLoad(); resetForm(); renderAll(); syncForm();
refreshLive();
if("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
