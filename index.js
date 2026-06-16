import express from "express";
import cors from "cors";
import cron from "node-cron";
import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(cors());
app.use(express.json());

const rssParser = new Parser({ timeout: 30000 });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SCRAPER_KEY = process.env.SCRAPER_API_KEY || "";
const PORT = parseInt(process.env.PORT || "8080");

const SEARCH_CONFIGS = [
  { category: "🚜 Riding Mowers",  terms: ["riding mower"],    maxPrice: 500 },
  { category: "🔧 Power Tools",    terms: ["dewalt milwaukee"], maxPrice: 200 },
  { category: "🦌 Hunting Gear",   terms: ["deer stand"],       maxPrice: 150 },
  { category: "🏋️ Exercise Equip", terms: ["treadmill"],        maxPrice: 100 },
  { category: "⛳ Golf Gear",      terms: ["golf clubs"],       maxPrice: 100 },
  { category: "🛻 Truck Parts",    terms: ["tonneau cover"],    maxPrice: 200 },
  { category: "🪑 Wood Furniture", terms: ["wood dresser"],     maxPrice: 100 },
  { category: "🚲 Kids Gear",      terms: ["power wheels"],     maxPrice: 50  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function proxyUrl(target) {
  if (SCRAPER_KEY) return `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(target)}`;
  return target;
}

function buildRssUrl(term, maxPrice) {
  return proxyUrl(`https://houston.craigslist.org/search/sss?query=${encodeURIComponent(term)}&max_price=${maxPrice}&format=rss&sort=date`);
}
function buildFreeRssUrl(term) {
  return proxyUrl(`https://houston.craigslist.org/search/zip?query=${encodeURIComponent(term)}&max_price=0&format=rss&sort=date`);
}

let dealStore = [];
let seenIds   = new Set();
let lastPoll  = null;
let pollCount = 0;
let lastError = null;
let isPolling = false;

async function scoreListing(listing, categoryName) {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: "You are a flip scoring agent for a reseller in Magnolia TX near Houston. Return ONLY valid JSON, no markdown.",
      messages: [{
        role: "user",
        content: `Score this Craigslist listing for resale potential:
Category: ${categoryName}
Title: "${listing.title}"
Price: ${listing.price === 0 ? "FREE" : "$" + listing.price}

Return exactly:
{"score":<1-10>,"verdict":"<🔥 Hot Deal|✅ Good Find|⚠️ Maybe|❌ Pass>","estimatedSellPrice":<number>,"estimatedProfit":<number>,"tip":"<one sentence>","urgency":"<Grab today|Check it out|No rush>","redFlags":"<concern or None>"}`
      }]
    });
    const text = msg.content[0]?.text || "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (e) {
    return { score: 5, verdict: "⚠️ Maybe", estimatedSellPrice: 0, estimatedProfit: 0, tip: "Check manually", urgency: "No rush", redFlags: "None" };
  }
}

async function fetchFeed(url, label) {
  try {
    console.log(`  Fetching: ${label}`);
    const feed = await rssParser.parseURL(url);
    const items = feed.items || [];
    console.log(`  Got ${items.length} items for: ${label}`);
    return items;
  } catch (e) {
    console.log(`  Error fetching ${label}: ${e.message}`);
    lastError = e.message;
    return [];
  }
}

async function pollCraigslist() {
  if (isPolling) { console.log("Poll already running, skipping"); return; }
  isPolling = true;
  console.log(`\n[${new Date().toISOString()}] Starting poll (scraper: ${SCRAPER_KEY ? "ON" : "OFF"})`);
  lastPoll = new Date().toISOString();
  pollCount++;

  const newDeals = [];

  // ONE request at a time with delay — respects ScraperAPI free tier
  for (const config of SEARCH_CONFIGS) {
    for (const term of config.terms) {
      // Paid/cheap listings
      await sleep(2000); // 2s between each request
      const items = await fetchFeed(buildRssUrl(term, config.maxPrice), `${term} <$${config.maxPrice}`);
      for (const item of items.slice(0, 6)) {
        const id = item.guid || item.link;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const priceMatch = item.title?.match(/\$([0-9,]+)/);
        const price = priceMatch ? parseInt(priceMatch[1].replace(",", "")) : 0;
        if (price > config.maxPrice * 2) continue;
        newDeals.push({ listing: { id, title: item.title || "Untitled", price, isFree: price === 0, url: item.link, category: config.category, seenAt: new Date().toISOString() }, categoryName: config.category });
      }

      // Free listings
      await sleep(2000);
      const freeItems = await fetchFeed(buildFreeRssUrl(term), `${term} FREE`);
      for (const item of freeItems.slice(0, 6)) {
        const id = item.guid || item.link;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        newDeals.push({ listing: { id, title: item.title || "Untitled", price: 0, isFree: true, url: item.link, category: config.category, seenAt: new Date().toISOString() }, categoryName: config.category });
      }
    }
  }

  console.log(`\nScoring ${newDeals.length} new listings...`);
  for (const { listing, categoryName } of newDeals) {
    const analysis = await scoreListing(listing, categoryName);
    listing.score = analysis.score;
    listing.analysis = analysis;
    if (analysis.score >= 5) {
      dealStore.unshift(listing);
      console.log(`  ✅ [${analysis.score}/10] ${listing.title.slice(0, 55)}`);
    }
    await sleep(300);
  }

  dealStore = dealStore.slice(0, 200);
  isPolling = false;
  console.log(`Poll complete. Store: ${dealStore.length} deals.\n`);
}

// ── API ───────────────────────────────────────────────────────────────────────
app.get("/api/deals", (req, res) => {
  const { minScore = 0, category, limit = 100 } = req.query;
  let deals = dealStore.filter(d => d.score >= parseInt(minScore));
  if (category && category !== "All") deals = deals.filter(d => d.category === category);
  res.json({ deals: deals.slice(0, parseInt(limit)), meta: { total: deals.length, lastPoll, pollCount, lastError, isPolling } });
});

app.get("/api/stats", (req, res) => {
  const byCategory = {};
  dealStore.forEach(d => {
    if (!byCategory[d.category]) byCategory[d.category] = { count: 0, scores: [] };
    byCategory[d.category].count++;
    byCategory[d.category].scores.push(d.score);
  });
  Object.keys(byCategory).forEach(k => {
    const s = byCategory[k].scores;
    byCategory[k].avgScore = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
    delete byCategory[k].scores;
  });
  res.json({ totalDeals: dealStore.length, lastPoll, pollCount, lastError, isPolling, byCategory, scraperEnabled: !!SCRAPER_KEY });
});

app.post("/api/poll-now", (req, res) => {
  if (isPolling) return res.json({ message: "Already polling, please wait..." });
  res.json({ message: "Poll started" });
  pollCraigslist().catch(console.error);
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: Math.round(process.uptime()), lastPoll, pollCount, deals: dealStore.length, isPolling, scraperEnabled: !!SCRAPER_KEY });
});

// ── Frontend ──────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>FlipScout 🏪 Magnolia TX</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a}
.header{background:#0f172a;padding:20px 16px 0;position:sticky;top:0;z-index:10}
.inner{max-width:520px;margin:0 auto}
.eyebrow{font-size:10px;color:#6366f1;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px}
.logo{color:white;font-size:24px;font-weight:900}.logo span{color:#818cf8}
.status{color:#475569;font-size:11px;margin-top:3px}
.scan-btn{background:#6366f1;color:white;border:none;border-radius:12px;padding:10px 16px;font-weight:800;font-size:12px;cursor:pointer}
.scan-btn:disabled{background:#334155;cursor:default}
.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}
.stat-box{background:#1e293b;border-radius:10px;padding:10px 8px;text-align:center}
.stat-val{font-size:18px;font-weight:900}.stat-label{color:#475569;font-size:9px;font-weight:700;text-transform:uppercase;margin-top:2px}
.tabs{display:flex;border-top:1px solid #1e293b}
.tab{flex:1;background:none;border:none;color:#475569;padding:12px 0;font-weight:800;font-size:11px;cursor:pointer;border-bottom:2px solid transparent;text-transform:uppercase;letter-spacing:1px}
.tab.active{color:#818cf8;border-bottom:2px solid #818cf8}
.body{max-width:520px;margin:0 auto;padding:16px}
.filters{display:flex;gap:8px;margin-bottom:14px}
select{border:1px solid #e2e8f0;border-radius:8px;padding:7px 10px;font-size:12px;font-weight:600;background:white;cursor:pointer}
.card{background:white;border-radius:16px;border:1px solid #e5e7eb;margin-bottom:12px;overflow:hidden}
.card-header{background:#0f172a;padding:12px 14px;display:flex;align-items:center;gap:10px}
.card-title{color:white;font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.card-sub{color:#64748b;font-size:11px;margin-top:3px}
.score-badge{border-radius:99px;width:44px;height:44px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:17px;flex-shrink:0;color:white}
.card-body{padding:12px 14px}
.price-row{display:flex;gap:8px;margin-bottom:10px}
.price-box{flex:1;border-radius:10px;padding:8px;text-align:center}
.price-label{font-size:10px;color:#9ca3af;font-weight:600;margin-bottom:2px}
.price-val{font-size:17px;font-weight:900}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.tag{font-size:11px;font-weight:700;padding:3px 8px;border-radius:99px}
.tip-box{background:#f5f3ff;border-radius:10px;padding:8px 10px;font-size:12px;color:#6d28d9;margin-bottom:8px}
.flag-box{background:#fff7ed;border-radius:10px;padding:6px 10px;font-size:11px;color:#c2410c;margin-bottom:8px}
.view-btn{display:block;background:#4f46e5;color:white;border-radius:10px;padding:10px;text-align:center;font-weight:700;font-size:13px;text-decoration:none}
.empty{text-align:center;padding:40px 20px;color:#94a3b8}
.alert{background:#fef3c7;border:1px solid #fde047;border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#713f12}
.polling-bar{background:#1e293b;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#a5b4fc;display:flex;align-items:center;gap:8px}
.spin{width:14px;height:14px;border:2px solid #4f46e5;border-top-color:transparent;border-radius:99px;animation:spin 0.8s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.hidden{display:none}
#stats-tab{max-width:520px;margin:0 auto;padding:16px}
.stat-card{background:white;border-radius:16px;padding:16px;border:1px solid #e2e8f0;margin-bottom:10px}
.stat-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px}
.cat-card{background:white;border-radius:12px;padding:14px;border:1px solid #e2e8f0;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
</style>
</head>
<body>
<div class="header">
  <div class="inner">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
      <div>
        <div class="eyebrow">Magnolia TX · 77354 · Auto Scout</div>
        <div class="logo">Flip<span>Scout</span> 🤖</div>
        <div class="status" id="status-text">⏳ Connecting...</div>
      </div>
      <button class="scan-btn" id="scan-btn" onclick="scanNow()">⚡ Scan Now</button>
    </div>
    <div class="stats-grid">
      <div class="stat-box"><div class="stat-val" id="s-deals" style="color:#a5b4fc">—</div><div class="stat-label">Deals</div></div>
      <div class="stat-box"><div class="stat-val" id="s-hot" style="color:#34d399">—</div><div class="stat-label">🔥 Hot</div></div>
      <div class="stat-box"><div class="stat-val" id="s-free" style="color:#fbbf24">—</div><div class="stat-label">🆓 Free</div></div>
      <div class="stat-box"><div class="stat-val" id="s-profit" style="color:#f472b6">—</div><div class="stat-label">Profit Pool</div></div>
    </div>
    <div class="tabs">
      <button class="tab active" onclick="showTab('deals')">🔍 Deals</button>
      <button class="tab" onclick="showTab('stats')">📊 Stats</button>
    </div>
  </div>
</div>

<div id="deals-tab" class="body">
  <div id="polling-bar" class="polling-bar hidden"><div class="spin"></div><span>Scanning Craigslist... this takes 3–5 minutes. Deals appear when done.</span></div>
  <div class="filters">
    <select id="cat-filter" onchange="applyFilters()">
      <option>All</option>
      <option>🚜 Riding Mowers</option><option>🔧 Power Tools</option>
      <option>🦌 Hunting Gear</option><option>🏋️ Exercise Equip</option>
      <option>⛳ Golf Gear</option><option>🛻 Truck Parts</option>
      <option>🪑 Wood Furniture</option><option>🚲 Kids Gear</option>
    </select>
    <select id="score-filter" onchange="applyFilters()">
      <option value="5">Score 5+</option><option value="6">Score 6+</option>
      <option value="7">Score 7+</option><option value="8">🔥 Hot only (8+)</option>
    </select>
  </div>
  <div id="deals-list"><div class="empty"><div style="font-size:36px;margin-bottom:10px">🤖</div>Loading...</div></div>
</div>

<div id="stats-tab" class="hidden">
  <div id="stats-content" class="inner"><div class="empty">Loading...</div></div>
</div>

<script>
let allDeals=[],scanning=false,pollInterval=null;

function timeAgo(iso){
  const d=Date.now()-new Date(iso).getTime(),m=Math.floor(d/60000);
  if(m<1)return'just now';if(m<60)return m+'m ago';
  const h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago';
}
function scoreColor(s){return s>=8?'#059669':s>=6?'#d97706':'#6b7280';}

function renderDeals(deals){
  const el=document.getElementById('deals-list');
  if(!deals.length){
    el.innerHTML='<div class="empty"><div style="font-size:36px;margin-bottom:10px">📡</div><strong>No deals yet</strong><br><span style="font-size:13px;margin-top:6px;display:block">Hit Scan Now — takes 3–5 min on first run</span><br><button onclick="scanNow()" style="background:#6366f1;color:white;border:none;border-radius:12px;padding:12px 24px;font-weight:800;font-size:14px;cursor:pointer;margin-top:4px">⚡ Run First Scan</button></div>';
    return;
  }
  el.innerHTML=deals.map(d=>{
    const a=d.analysis||{};
    return \`<div class="card">
      <div class="card-header">
        <div style="flex:1;min-width:0"><div class="card-title">\${d.title}</div><div class="card-sub">\${d.category} · \${timeAgo(d.seenAt)}</div></div>
        <div class="score-badge" style="background:\${scoreColor(d.score)}">\${d.score}</div>
      </div>
      <div class="card-body">
        <div class="price-row">
          <div class="price-box" style="background:\${d.isFree?'#fef9c3':'#fff1f2'}"><div class="price-label">BUY</div><div class="price-val" style="color:\${d.isFree?'#854d0e':'#be123c'}">\${d.isFree?'FREE':'$'+d.price}</div></div>
          <div class="price-box" style="background:#f0fdf4"><div class="price-label">SELL</div><div class="price-val" style="color:#15803d">$\${a.estimatedSellPrice||'—'}</div></div>
          <div class="price-box" style="background:#eff6ff"><div class="price-label">PROFIT</div><div class="price-val" style="color:#1d4ed8">$\${a.estimatedProfit||'—'}</div></div>
        </div>
        <div class="tags">
          <span class="tag" style="background:#f1f5f9;color:#475569">\${a.verdict||''}</span>
          \${a.urgency==='Grab today'?'<span class="tag" style="background:#fef3c7;color:#92400e">⚡ Grab today</span>':''}
          \${d.isFree?'<span class="tag" style="background:#dcfce7;color:#166534">🆓 FREE</span>':''}
        </div>
        \${a.tip?'<div class="tip-box">💡 '+a.tip+'</div>':''}
        \${a.redFlags&&a.redFlags!=='None'?'<div class="flag-box">⚠️ '+a.redFlags+'</div>':''}
        <a href="\${d.url}" target="_blank" class="view-btn">View on Craigslist →</a>
      </div>
    </div>\`;
  }).join('');
}

function applyFilters(){
  const cat=document.getElementById('cat-filter').value;
  const min=parseInt(document.getElementById('score-filter').value);
  let f=allDeals.filter(d=>d.score>=min);
  if(cat!=='All')f=f.filter(d=>d.category===cat);
  renderDeals(f);
}

async function fetchDeals(){
  try{
    const r=await fetch('/api/deals?limit=200');
    const data=await r.json();
    allDeals=data.deals||[];
    const hot=allDeals.filter(d=>d.score>=8).length;
    const free=allDeals.filter(d=>d.isFree).length;
    const profit=allDeals.reduce((s,d)=>s+(d.analysis?.estimatedProfit||0),0);
    document.getElementById('s-deals').textContent=allDeals.length;
    document.getElementById('s-hot').textContent=hot;
    document.getElementById('s-free').textContent=free;
    document.getElementById('s-profit').textContent='$'+profit.toLocaleString();
    document.getElementById('status-text').textContent='🟢 Live · Updated '+new Date().toLocaleTimeString()+' · Polls every 30 min';
    // Show/hide polling bar
    const bar=document.getElementById('polling-bar');
    if(data.meta?.isPolling){bar.classList.remove('hidden');}else{bar.classList.add('hidden');}
    applyFilters();
  }catch(e){document.getElementById('status-text').textContent='🔴 Error connecting';}
}

async function scanNow(){
  if(scanning)return;
  scanning=true;
  const btn=document.getElementById('scan-btn');
  btn.textContent='Queued...';btn.disabled=true;
  document.getElementById('polling-bar').classList.remove('hidden');
  try{
    const r=await fetch('/api/poll-now',{method:'POST'});
    const d=await r.json();
    btn.textContent='Scanning...';
    // Poll every 10s until done
    if(pollInterval)clearInterval(pollInterval);
    pollInterval=setInterval(async()=>{
      await fetchDeals();
      const r2=await fetch('/api/health');
      const h=await r2.json();
      if(!h.isPolling){
        clearInterval(pollInterval);pollInterval=null;
        scanning=false;btn.textContent='⚡ Scan Now';btn.disabled=false;
        document.getElementById('polling-bar').classList.add('hidden');
      }
    },10000);
  }catch{scanning=false;btn.textContent='⚡ Scan Now';btn.disabled=false;}
}

async function fetchStats(){
  try{
    const r=await fetch('/api/stats');const s=await r.json();
    const cats=Object.entries(s.byCategory||{}).map(([cat,d])=>
      '<div class="cat-card"><div><div style="font-weight:700;font-size:14px">'+cat+'</div><div style="font-size:12px;color:#94a3b8">'+d.count+' deals</div></div><div style="text-align:center"><div style="font-size:10px;color:#94a3b8">Avg</div><div style="font-size:24px;font-weight:900;color:#6366f1">'+d.avgScore+'</div></div></div>'
    ).join('');
    document.getElementById('stats-content').innerHTML=
      '<div class="stat-card"><div style="font-size:10px;color:#94a3b8;font-weight:800;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">Server</div>'+
      '<div class="stat-row"><span style="color:#64748b">Proxy</span><span style="font-weight:700">'+(s.scraperEnabled?'🟢 ScraperAPI on':'🔴 No proxy')+'</span></div>'+
      '<div class="stat-row"><span style="color:#64748b">Polling now</span><span style="font-weight:700">'+(s.isPolling?'⏳ Yes':'✅ Idle')+'</span></div>'+
      '<div class="stat-row"><span style="color:#64748b">Total scored</span><span style="font-weight:700">'+s.totalDeals+'</span></div>'+
      '<div class="stat-row"><span style="color:#64748b">Polls run</span><span style="font-weight:700">'+s.pollCount+'</span></div>'+
      '<div class="stat-row" style="border:none"><span style="color:#64748b">Last poll</span><span style="font-weight:700">'+(s.lastPoll?timeAgo(s.lastPoll):'Never')+'</span></div></div>'+cats;
  }catch{}
}

function showTab(n){
  document.getElementById('deals-tab').classList.toggle('hidden',n!=='deals');
  document.getElementById('stats-tab').classList.toggle('hidden',n!=='stats');
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',(i===0&&n==='deals')||(i===1&&n==='stats')));
  if(n==='stats')fetchStats();
}

fetchDeals();
setInterval(fetchDeals,15000);
</script>
</body>
</html>`);
});

cron.schedule("*/30 * * * *", () => {
  if (!isPolling) pollCraigslist().catch(console.error);
});

app.listen(PORT, () => {
  console.log(`FlipScout on port ${PORT} | Scraper: ${SCRAPER_KEY ? "ON" : "OFF"}`);
  setTimeout(() => pollCraigslist().catch(console.error), 4000);
});
