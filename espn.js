/* ESPN data layer: teams, rosters, scores and live box scores.
   Uses ESPN's free, unofficial endpoints (no key). ESPN can change these without warning;
   if something breaks, this is the only file that should need fixing.

   Everything is cached on the device so the app doesn't hammer ESPN:
     teams 7 days · rosters 24 hours · live scores 45 seconds · final scores 1 day */
const ESPN = (() => {
"use strict";
const BASE = "https://site.api.espn.com/apis/site/v2/sports/";
// Sport name you type in the slip -> ESPN's sport/league path.
const LEAGUES = {
  NBA:"basketball/nba", WNBA:"basketball/wnba", NCAAB:"basketball/mens-college-basketball", NCAAW:"basketball/womens-college-basketball",
  NFL:"football/nfl", NCAAF:"football/college-football", MLB:"baseball/mlb", NHL:"hockey/nhl"
};
// College scoreboards only return ranked/featured games unless you ask for every D1 group.
const SCOREBOARD_EXTRA = { "basketball/mens-college-basketball":"&groups=50&limit=400", "basketball/womens-college-basketball":"&groups=50&limit=400", "football/college-football":"&groups=80&limit=300" };
const CACHE_PREFIX = "espn:";
let cfg = { enabled: true, proxy: "" };

function configure(next){ cfg = { ...cfg, ...next }; }
function enabled(){ return cfg.enabled !== false; }
function leagueFor(sport){
  const s = String(sport||"").toUpperCase().replace(/[^A-Z]/g,"");
  if(LEAGUES[s]) return LEAGUES[s];
  if(/CBB|COLLEGEBASKETBALL|MCBB|NCAAM/.test(s)) return LEAGUES.NCAAB;
  if(/CFB|COLLEGEFOOTBALL/.test(s)) return LEAGUES.NCAAF;
  return null;
}
const kindOf = league => (league||"").split("/")[0]; // basketball, football, baseball, hockey

/* ---------- fetching + cache ---------- */
function cacheGet(key){ try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || "null"); } catch { return null; } }
function cacheSet(key, data){
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data })); }
  catch { pruneCache(); try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data })); } catch {} }
}
function pruneCache(){ // storage full: drop old live data first
  try { Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX + "box:") || k.startsWith(CACHE_PREFIX + "sb:")).forEach(k => localStorage.removeItem(k)); } catch {}
}
async function getJSON(path){
  const url = BASE + path;
  const target = cfg.proxy ? cfg.proxy.replace(/\/$/,"") + "/?url=" + encodeURIComponent(url) : url;
  let res;
  try { res = await fetch(target, { headers: { accept: "application/json" } }); }
  catch { throw { code: navigator.onLine === false ? "offline" : "blocked", message: navigator.onLine === false ? "You're offline." : "ESPN blocked the request from this app. Add a proxy in Settings (see the README)." }; }
  if(res.status === 429) throw { code: "throttled", message: "ESPN is rate-limiting requests. Live data will retry in a few minutes." };
  if(!res.ok) throw { code: "http", message: `ESPN returned an error (${res.status}).` };
  return res.json();
}
/* Fetch, transform, cache. On failure, fall back to whatever was cached last, even if stale. */
async function cached(key, ttlMs, path, transform){
  const hit = cacheGet(key);
  if(hit && Date.now() - hit.at < ttlMs) return hit.data;
  try { const data = transform(await getJSON(path)); cacheSet(key, data); return data; }
  catch(e){ if(hit) return { ...hit.data, stale: true }; throw e; }
}

/* ---------- teams & rosters ---------- */
async function teams(league){
  const r = await cached(`teams:${league}`, 7*864e5, `${league}/teams?limit=1000`, j => {
    const list = j?.sports?.[0]?.leagues?.[0]?.teams || [];
    return { list: list.map(t => t.team || t).filter(t => t?.id).map(t => ({ id: String(t.id), name: t.displayName || t.name, short: t.shortDisplayName || "", abbr: t.abbreviation || "", location: t.location || "", nickname: t.name || "" })) };
  });
  return r.list;
}
async function roster(league, teamId){
  const r = await cached(`roster:${league}:${teamId}`, 864e5, `${league}/teams/${teamId}/roster`, j => {
    let a = j?.athletes || [];
    if(a.length && Array.isArray(a[0]?.items)) a = a.flatMap(g => g.items || []); // football groups players by unit
    return { list: a.filter(p => p?.id).map(p => ({ id: String(p.id), name: p.fullName || p.displayName || "", pos: p.position?.abbreviation || "", jersey: p.jersey || "" })) };
  });
  return r.list;
}

/* ---------- scores ---------- */
const ymd = d => String(d||"").replace(/-/g,"");
function team(c){ const t = c?.team || {}; return { id: String(t.id||""), name: t.displayName||"", short: t.shortDisplayName||"", abbr: t.abbreviation||"", location: t.location||"", nickname: t.name||"", score: Number(c?.score ?? 0), homeAway: c?.homeAway, winner: !!c?.winner }; }
function status(s){ const t = s?.type || {}; return { state: t.state || "pre", completed: !!t.completed, detail: t.shortDetail || t.detail || "", name: t.name || "" }; }
async function scoreboard(league, date){
  const key = `sb:${league}:${ymd(date)}`, hit = cacheGet(key);
  const live = hit?.data?.events?.some(e => e.state === "in");
  const allFinal = hit?.data?.events?.length && hit.data.events.every(e => e.state === "post");
  const ttl = allFinal ? 864e5 : live ? 45e3 : 5*6e4;
  const r = await cached(key, ttl, `${league}/scoreboard?dates=${ymd(date)}${SCOREBOARD_EXTRA[league]||""}`, j => ({
    events: (j?.events || []).map(e => { const c = e.competitions?.[0] || {}, st = status(c.status || e.status), comps = (c.competitors||[]).map(team);
      return { id: String(e.id), name: e.shortName || e.name || "", date: e.date, ...st, home: comps.find(x=>x.homeAway==="home") || comps[0], away: comps.find(x=>x.homeAway==="away") || comps[1], teams: comps }; })
  }));
  return r.events;
}

/* Box score: every player's stats as a lookup like { points: 23, assists: 2, "3pt": 4, "passing.yds": 241 } */
function parseStats(group, values){
  const out = {}, keys = group.keys || group.names || [], labels = group.labels || [], gname = String(group.name || group.type || "").toLowerCase();
  values.forEach((v, i) => {
    const raw = String(v ?? "");
    const parts = raw.split(/[-/]/).map(Number);
    const num = raw.includes("-") || raw.includes("/") ? parts[0] : Number(raw.replace(/[^\d.-]/g,""));
    const put = (k, val) => { if(!k) return; k = String(k).toLowerCase(); if(Number.isFinite(val) && !(k in out)) out[k] = val; if(gname && Number.isFinite(val)) out[`${gname}.${k}`] = val; };
    const key = keys[i] || "", label = labels[i] || "";
    if(key.includes("-") || key.includes("/")) key.split(/[-/]/).forEach((k, n) => put(k, parts[n]));
    else put(key, num);
    put(label, num);
  });
  return out;
}
async function boxscore(league, eventId){
  const key = `box:${league}:${eventId}`, hit = cacheGet(key);
  const ttl = hit?.data?.state === "post" ? 864e5 : 45e3;
  return cached(key, ttl, `${league}/summary?event=${eventId}`, j => {
    const st = status(j?.header?.competitions?.[0]?.status);
    const players = [];
    for(const tm of (j?.boxscore?.players || [])){
      const teamId = String(tm.team?.id || ""), byId = new Map();
      for(const g of (tm.statistics || [])) for(const a of (g.athletes || [])){
        const id = String(a.athlete?.id || a.athlete?.displayName || "");
        const p = byId.get(id) || { id, name: a.athlete?.displayName || "", short: a.athlete?.shortName || "", teamId, dnp: !!a.didNotPlay, stats: {} };
        Object.assign(p.stats, parseStats(g, a.stats || []));
        if(a.didNotPlay === false || (a.stats||[]).length) p.dnp = !!a.didNotPlay;
        byId.set(id, p);
      }
      players.push(...byId.values());
    }
    return { ...st, players };
  });
}

/* ---------- reading picks ---------- */
// Each stat: how to spot it in your pick text, and which box score fields hold it (first match wins).
const STATS = [
  { id:"pra", re:/\bpra\b|p\s*\+\s*r\s*\+\s*a|pts\s*\+\s*rebs?\s*\+\s*asts?|points\s*\+\s*rebounds\s*\+\s*assists/, label:"PRA", sum:["pts","reb","ast"] },
  { id:"pr", re:/\bp\s*\+\s*r\b|\bpts\s*\+\s*rebs?\b|points\s*\+\s*rebounds/, label:"P+R", sum:["pts","reb"] },
  { id:"pa", re:/\bp\s*\+\s*a\b|\bpts\s*\+\s*asts?\b|points\s*\+\s*assists/, label:"P+A", sum:["pts","ast"] },
  { id:"ra", re:/\br\s*\+\s*a\b|\brebs?\s*\+\s*asts?\b|rebounds\s*\+\s*assists/, label:"R+A", sum:["reb","ast"] },
  { id:"stocks", re:/\bstocks\b|steals\s*\+\s*blocks|stl\s*\+\s*blk/, label:"STL+BLK", sum:["stl","blk"] },
  { id:"threes", re:/\bthrees\b|three[- ]pointers?|\b3s\b/, label:"3PM", keys:["threepointfieldgoalsmade","3pt","3pm"] },
  { id:"passyds", re:/pass(ing)?\s*(yds|yards)/, label:"Pass YDS", keys:["passingyards","passing.yds"] },
  { id:"passtd", re:/pass(ing)?\s*(tds?|touchdowns?)/, label:"Pass TD", keys:["passingtouchdowns","passing.td"] },
  { id:"comp", re:/\bcompletions?\b|\bcmp\b/, label:"CMP", keys:["completions","passing.c"] },
  { id:"ints", re:/\b(ints?|interceptions?)\b/, label:"INT", keys:["interceptions","passing.int"] },
  { id:"rushyds", re:/rush(ing)?\s*(yds|yards)/, label:"Rush YDS", keys:["rushingyards","rushing.yds"] },
  { id:"rushatt", re:/rush(ing)?\s*att|\bcarries\b/, label:"CAR", keys:["rushingattempts","rushing.car"] },
  { id:"recyds", re:/rec(eiving)?\s*(yds|yards)/, label:"Rec YDS", keys:["receivingyards","receiving.yds"] },
  { id:"rec", re:/\b(receptions?|catches|recs?)\b/, label:"REC", keys:["receptions","receiving.rec"] },
  { id:"anytd", re:/\b(anytime\s*)?(tds?|touchdowns?)\b/, label:"TD", sum:["rushtd","rectd"] },
  { id:"rushtd", label:"Rush TD", keys:["rushingtouchdowns","rushing.td"] },
  { id:"rectd", label:"Rec TD", keys:["receivingtouchdowns","receiving.td"] },
  { id:"hr", re:/\b(hrs?|home\s*runs?|homers?)\b/, label:"HR", keys:["batting.hr","homeruns","hr"] },
  { id:"rbi", re:/\brbis?\b/, label:"RBI", keys:["batting.rbi","rbis","rbi"] },
  { id:"hits", re:/\bhits?\b/, label:"H", keys:["batting.h","hits","h"] },
  { id:"runs", re:/\bruns?\b/, label:"R", keys:["batting.r","runs","r"] },
  { id:"ks", re:/\b(k|ks|strikeouts?)\b/, label:"K", keys:["pitching.k","pitching.so","strikeouts"] },
  { id:"goals", re:/\bgoals?\b/, label:"G", keys:["goals","g"] },
  { id:"sog", re:/\b(sog|shots)\b/, label:"SOG", keys:["shotstotal","shots","sog","s"] },
  { id:"saves", re:/\bsaves?\b/, label:"SV", keys:["saves","sv"] },
  { id:"pts", re:/\b(pts|points?)\b/, label:"PTS", keys:["points","pts"] },
  { id:"reb", re:/\b(rebs?|rebounds?|boards)\b/, label:"REB", keys:["rebounds","reb","totalrebounds"] },
  { id:"ast", re:/\b(asts?|assists?|dimes)\b/, label:"AST", keys:["assists","ast","a"] },
  { id:"stl", re:/\b(stls?|steals?)\b/, label:"STL", keys:["steals","stl"] },
  { id:"blk", re:/\b(blks?|blocks?)\b/, label:"BLK", keys:["blocks","blk"] },
  { id:"tov", re:/\bturnovers?\b/, label:"TO", keys:["turnovers","to"] },
];
const statById = id => STATS.find(s => s.id === id);
/* "2+ assists" -> over 1.5 AST · "O 24.5 pts" -> over 24.5 PTS · "U 8.5 reb" -> under 8.5 REB · "anytime TD" -> over 0.5 */
function parseProp(pick){
  let t = " " + String(pick||"").toLowerCase() + " ";
  t = t.replace(/\b3\s*-?\s*(pm|ptm|pt|pointers?)\b/g, " threes ");
  const stat = STATS.find(s => s.re && s.re.test(t));
  if(!stat) return null;
  const under = /\b(u|under)\b|\bu\s*\d/.test(t);
  const m = t.match(/(\d+(?:\.\d+)?)\s*(\+)?/);
  let line;
  if(m) line = m[2] === "+" ? Number(m[1]) - 0.5 : Number(m[1]);
  else if(stat.id === "anytd") line = 0.5;
  else return null;
  return { stat: stat.id, label: stat.label, dir: under ? "under" : "over", line };
}
function statValue(stats, id){
  const s = statById(id); if(!s) return null;
  if(s.sum){ const parts = s.sum.map(x => statValue(stats, x)); return parts.every(v => v === null) ? null : parts.reduce((a,v) => a + (v||0), 0); }
  for(const k of s.keys) if(Number.isFinite(stats[k])) return stats[k];
  return null;
}

/* ---------- matching ---------- */
const norm = s => String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
function teamMatches(t, name, id){
  if(id && t.id === String(id)) return true;
  const n = norm(name); if(n.length < 2) return false;
  const names = [t.name, t.short, t.location, t.abbr, t.nickname, `${t.location}${t.nickname}`].map(norm).filter(Boolean);
  return names.includes(n) || (n.length >= 4 && names.some(x => x.length >= 4 && (x.includes(n) || n.includes(x))));
}
function teamInText(t, text){
  const s = " " + String(text||"").toLowerCase().replace(/[^a-z0-9&.' ]/g," ") + " ";
  const has = w => w && w.length >= 2 && s.includes(" " + w.toLowerCase() + " ");
  return has(t.name) || has(t.short) || has(t.location) || (t.abbr && t.abbr.length >= 2 && has(t.abbr)) || has(t.nickname);
}
function findEventForLeg(events, leg){
  if(leg.type === "Player prop") return events.find(e => e.teams.some(t => teamMatches(t, leg.team, leg.teamId))) || null;
  return events.find(e => e.teams.some(t => teamInText(t, leg.pick))) || null;
}
function findPlayer(box, leg){
  if(leg.espnId){ const p = box.players.find(p => p.id === String(leg.espnId)); if(p) return p; }
  const n = norm(leg.player); if(!n) return null;
  const same = box.players.filter(p => norm(p.name) === n);
  if(same.length > 1 && leg.teamId) return same.find(p => p.teamId === String(leg.teamId)) || same[0];
  return same[0] || box.players.find(p => norm(p.name).includes(n) || n.includes(norm(p.name))) || null;
}

/* ---------- grading ----------
   status: "hit" | "miss" | "push" | "void" | "live" | "pre" | "unknown"; locked = decided before the game ends */
function gradeProp(parsed, value, final){
  if(value === null) return { status: final ? "unknown" : "live" };
  const { dir, line } = parsed;
  if(dir === "over"){
    if(value > line) return { status: "hit", locked: !final };
    if(!final) return { status: "live" };
    return { status: value === line ? "push" : "miss" };
  }
  if(value > line) return { status: "miss", locked: !final };
  if(!final) return { status: "live" };
  return { status: value === line ? "push" : "hit" };
}
function gradeGameLeg(leg, ev){
  const final = ev.state === "post", t = ev.teams.find(x => teamInText(x, leg.pick)), opp = ev.teams.find(x => x !== t);
  const text = String(leg.pick||"").toLowerCase();
  if(ev.state === "pre") return { status: "pre", text: "Not started" };
  if(leg.type === "Total" || /\b(o|u|over|under)\s*\d/.test(text) && leg.type !== "Spread"){
    const m = text.match(/(\d+(?:\.\d+)?)/); if(!m) return { status: "unknown", text: "Couldn't read the total line" };
    const line = Number(m[1]), under = /\b(u|under)\b|\bu\s*\d/.test(text), total = ev.teams.reduce((a,x)=>a+x.score,0);
    const g = gradeProp({ dir: under ? "under" : "over", line }, total, final);
    return { ...g, value: total, line, label: "Total", text: `Total ${total} vs ${under?"U":"O"} ${line}` };
  }
  if(!t || !opp) return { status: "unknown", text: "Couldn't tell which team you picked" };
  if(leg.type === "Moneyline" || /\bml\b|moneyline|to win/.test(text)){
    const diff = t.score - opp.score;
    if(!final) return { status: "live", text: `${t.abbr||t.short} ${diff>0?"up":diff<0?"down":"tied"}${diff?` ${Math.abs(diff)}`:""}` };
    return { status: diff > 0 ? "hit" : diff < 0 ? "miss" : "push", text: `${t.abbr||t.short} ${t.score}-${opp.score}` };
  }
  const sm = text.match(/([+-]\s*\d+(?:\.\d+)?)/); const spread = /\b(pk|pick'?em)\b/.test(text) ? 0 : sm ? Number(sm[1].replace(/\s/g,"")) : null;
  if(spread === null) return { status: "unknown", text: "Couldn't read the spread" };
  const margin = t.score + spread - opp.score;
  const txt = `${t.abbr||t.short} ${spread>0?"+":""}${spread}: ${margin>0?"covering by":margin<0?"short by":"right on"} ${Math.abs(margin)}`;
  if(!final) return { status: "live", text: txt };
  return { status: margin > 0 ? "hit" : margin < 0 ? "miss" : "push", text: txt };
}

/* Track every pick on a bet. Returns { games, legs, suggestion } for the ticket. */
async function trackBet(bet){
  const league = leagueFor(bet.sport); if(!league) return null;
  let events = await scoreboard(league, bet.date);
  const out = { games: [], legs: [], suggestion: null, at: Date.now() };
  const seen = new Set();
  for(const [i, leg] of bet.legs.entries()){
    let ev = findEventForLeg(events, leg);
    if(!ev){ // late games and logging mistakes: check the next day too
      const next = new Date(bet.date + "T12:00:00"); next.setDate(next.getDate() + 1);
      const nd = next.toISOString().slice(0,10);
      try { const more = await scoreboard(league, nd); ev = findEventForLeg(more, leg); } catch {}
    }
    const label = [leg.player, leg.pick].filter(Boolean).join(" ") || `Pick ${i+1}`;
    if(!ev){ out.legs.push({ i, label, status: "unknown", text: leg.type === "Player prop" ? (leg.team ? "Game not found on ESPN" : "Add the team to track this pick") : "No game found for this team on that date. Check the team name and the bet date." }); continue; }
    if(!seen.has(ev.id)){ seen.add(ev.id); out.games.push(ev); }
    if(leg.type !== "Player prop"){ out.legs.push({ i, label, ...gradeGameLeg(leg, ev) }); continue; }
    const parsed = parseProp(leg.pick);
    if(!parsed){ out.legs.push({ i, label, status: "unknown", text: "Couldn't read the stat. Try like \"2+ assists\" or \"O 24.5 pts\"" }); continue; }
    if(ev.state === "pre"){ out.legs.push({ i, label, status: "pre", text: `Starts ${new Date(ev.date).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })}`, parsed }); continue; }
    const box = await boxscore(league, ev.id);
    const p = findPlayer(box, leg), final = box.state === "post" || ev.state === "post";
    if(!p){ out.legs.push({ i, label, status: final ? "unknown" : "live", text: "Player not in the box score yet", parsed }); continue; }
    if(p.dnp && final){ out.legs.push({ i, label, status: "void", text: "Didn't play. Most books void this leg.", parsed }); continue; }
    const value = statValue(p.stats, parsed.stat);
    out.legs.push({ ...parsed, i, label, value, ...gradeProp(parsed, value, final), text: `${p.name}: ${value ?? 0} ${parsed.label}`, statLine: statLine(p.stats, league) });
  }
  const done = out.legs.length && out.legs.every(l => ["hit","miss","push","void"].includes(l.status) && !l.locked) && out.games.every(g => g.state === "post");
  const anyMiss = out.legs.some(l => l.status === "miss");
  if(done || anyMiss && out.legs.every(l => l.status !== "unknown")){
    const results = out.legs.map(l => l.status === "void" ? "push" : l.status === "hit" ? "won" : l.status === "miss" ? "lost" : l.status === "push" ? "push" : "pending");
    const result = results.includes("lost") ? "lost" : results.includes("pending") ? null : results.every(r => r === "push") ? "push" : "won";
    if(result) out.suggestion = { result, legResults: results, summary: summarize(out) };
  }
  return out;
}
function statLine(stats, league){
  const k = kindOf(league), pick = ids => ids.map(id => { const v = statValue(stats, id); return v === null ? null : `${v} ${statById(id).label}`; }).filter(Boolean).join(", ");
  if(k === "basketball") return pick(["pts","reb","ast","threes","stl","blk"]);
  if(k === "football") return pick(["passyds","passtd","rushyds","rushtd","rec","recyds","rectd"]);
  if(k === "baseball") return pick(["hits","hr","rbi","runs","ks"]);
  if(k === "hockey") return pick(["goals","ast","sog","saves"]);
  return "";
}
function gameLine(g){ return `${g.away?.abbr||g.away?.short} ${g.away?.score} – ${g.home?.abbr||g.home?.short} ${g.home?.score} (${g.detail})`; }
function summarize(t){
  const lines = [...new Set(t.legs.filter(l => l.statLine || l.text).map(l => l.statLine ? `${l.text.split(":")[0]}: ${l.statLine}` : l.text))];
  return [t.games.map(gameLine).join("; "), lines.join("; ")].filter(Boolean).join(" | ");
}

/* Settings > Test connection */
async function test(){
  const t0 = Date.now();
  const j = await getJSON("basketball/nba/teams");
  const n = j?.sports?.[0]?.leagues?.[0]?.teams?.length || 0;
  if(!n) throw { code: "shape", message: "Reached ESPN, but the data looked different than expected." };
  return `Connected. Got ${n} NBA teams in ${Date.now() - t0} ms.`;
}

return { configure, enabled, leagueFor, teams, roster, scoreboard, boxscore, parseProp, statValue, trackBet, gameLine, test, _parseStats: parseStats };
})();
