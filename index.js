import express from "express";
import cors from "cors";
import cron from "node-cron";
import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(cors());
app.use(express.json());

const rssParser = new Parser({ timeout: 10000 });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PORT = parseInt(process.env.PORT || "3001");

const SEARCH_CONFIGS = [
  { category: "🚜 Riding Mowers",  terms: ["riding mower", "zero turn mower"],   maxPrice: 500 },
  { category: "🔧 Power Tools",    terms: ["dewalt tools", "milwaukee tools"],    maxPrice: 200 },
  { category: "🦌 Hunting Gear",   terms: ["deer stand", "trail camera"],         maxPrice: 150 },
  { category: "🏋️ Exercise Equip", terms: ["treadmill", "weight bench"],          maxPrice: 100 },
  { category: "⛳ Golf Gear",      terms: ["golf clubs", "callaway titleist"],    maxPrice: 100 },
  { category: "🛻 Truck Parts",    terms: ["tonneau cover", "truck toolbox"],     maxPrice: 200 },
  { category: "🪑 Wood Furniture", terms: ["solid wood dresser", "dining table"], maxPrice: 100 },
  { category: "🚲 Kids Gear",      terms: ["power wheels", "kids bike"],          maxPrice: 50  },
];

function buildRssUrl(term, maxPrice) {
  return `https://houston.craigslist.org/search/sss?query=${encodeURIComponent(term)}&max_price=${maxPrice}&format=rss&sort=date`;
}
function buildFreeRssUrl(term) {
  return `https://houston.craigslist.org/search/zip?query=${encodeURIComponent(term)}&max_price=0&format=rss&sort=date`;
}

let dealStore = [];
let seenIds   = new Set();
let lastPoll  = null;
let pollCount = 0;

async function scoreListing(listing, categoryName) {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: "You are a flip scoring agent for a reseller in Magnolia TX near Houston. Return ONLY valid JSON, no markdown.",
      messages: [{
        role: "user",
        content: `Score this listing:
Category: ${categoryName}
Title: "${listing.title}"
Price: ${listing.price === 0 ? "FREE" : "$" + listing.price}

Return:
{"score":<1-10>,"verdict":"<🔥 Hot Deal|✅ Good Find|⚠️ Maybe|❌ Pass>","estimatedSellPrice":<number>,"estimatedProfit":<number>,"tip":"<one sentence>","urgency":"<Grab today|Check it out|No rush>","redFlags":"<concern or None>"}`
      }]
    });
    return JSON.parse(msg.content[0]?.text.replace(/```json|```/g, "").trim());
  } catch {
    return { score: 5, verdict: "⚠️ Maybe", estimatedSellPrice: 0, estimatedProfit: 0, tip: "Check manually", urgency: "No rush", redFlags: "None" };
  }
}

async function pollCraigslist() {
  console.log(`[${new Date().toISOString()}] Polling...`);
  lastPoll = new Date().toISOString();
  pollCount++;
  const newDeals = [];

  for (const config of SEARCH_CONFIGS) {
    for (const term of config.terms) {
      for (const url of [buildRssUrl(term, config.maxPrice), buildFreeRssUrl(term)]) {
        try {
          const feed = await rssParser.parseURL(url);
          for (const item of (feed.items || []).slice(0, 5)) {
            const id = item.guid || item.link;
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            const priceMatch = item.title?.match(/\$([0-9,]+)/);
            const price = priceMatch ? parseInt(priceMatch[1].replace(",", "")) : 0;
            const isFree = url.includes("max_price=0") || price === 0 || item.title?.toLowerCase().includes("free");
            if (!isFree && price > config.maxPrice * 2) continue;
            newDeals.push({
              listing: { id, title: item.title || "Untitled", price, isFree, url: item.link, category: config.category, seenAt: new Date().toISOString(), score: null, analysis: null },
              categoryName: config.category
            });
          }
        } catch (err) { console.log(`RSS error: ${err.message}`); }
      }
    }
  }

  console.log(`${newDeals.length} new listings — scoring...`);
  for (const { listing, categoryName } of newDeals) {
    try {
      const analysis = await scoreListing(listing, categoryName);
      listing.score = analysis.score;
      listing.analysis = analysis;
      if (analysis.score >= 5) {
        dealStore.unshift(listing);
        console.log(`[${analysis.score}/10] ${listing.title.slice(0, 60)}`);
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (err) { console.log(`Score error: ${err.message}`); }
  }

  dealStore = dealStore.slice(0, 200);
  console.log(`Done. Store: ${dealStore.length} deals.`);
}

app.get("/api/deals", (req, res) => {
  const { minScore = 0, category, limit = 50 } = req.query;
  let deals = dealStore.filter(d => d.score >= parseInt(minScore));
  if (category && category !== "All") deals = deals.filter(d => d.category === category);
  res.json({ deals: deals.slice(0, parseInt(limit)), meta: { total: deals.length, lastPoll, pollCount } });
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
  res.json({ totalDeals: dealStore.length, lastPoll, pollCount, byCategory });
});

app.post("/api/poll-now", (req, res) => {
  res.json({ message: "Poll started" });
  pollCraigslist().catch(console.error);
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: Math.round(process.uptime()), lastPoll, pollCount, deals: dealStore.length });
});

cron.schedule("*/30 * * * *", () => pollCraigslist().catch(console.error));

app.listen(PORT, () => {
  console.log(`FlipScout running on port ${PORT}`);
  setTimeout(() => pollCraigslist().catch(console.error), 3000);
});
