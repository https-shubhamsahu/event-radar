// Mumbai Event Radar: pulls free, in-person Mumbai tech events from Luma's
// public Discover feed and writes docs/index.html, docs/events.json,
// docs/digest.txt (the WhatsApp message), docs/events.ics (a calendar people
// can subscribe to) and docs/feed.xml (RSS). Run: node build.mjs
import { writeFile, mkdir, readFile } from "node:fs/promises";

const API = "https://api.lu.ma";
const MUMBAI = { place: "discplace-Q5hkYsjZs1ZDJcU", lat: 19.076, lon: 72.8777 };
const CATEGORIES = ["cat-tech", "cat-ai", "cat-crypto"];
const RADIUS_KM = 45;
const DAYS_AHEAD = 30;
const DIGEST_DAYS = 7;
const SITE_URL = process.env.SITE_URL || "https://shubham-sahu.me/event-radar/";
const ICS_URL = `${SITE_URL}events.ics`;
const WEBCAL_URL = ICS_URL.replace(/^https?:/, "webcal:");
const CONTACT = "shubhamsahu@nosus.foo";
// Set once the WhatsApp Channel exists; the Follow button stays hidden until then.
const WA_CHANNEL_URL = process.env.WA_CHANNEL_URL || "";
const TZ = "Asia/Kolkata";

const NOT_EVENT_RE = /\b(accommodation|hostel|pg|room booking|stay)\b/i;
const TECH_RE = /\b(ai|a\.i\.|ml|llm|agents?|web3|crypto|blockchain|ethereum|solana|bitcoin|devcon|defi|developers?|devs?|hackathon|startups?|founders?|tech|product|data|cloud|gdg|google|meta|builders?|engineering|saas|vc|investors?)\b/i;
const FOOD_RE = /\b(food|snacks?|lunch|dinner|breakfast|brunch|drinks?|refreshments?|pizza|beer|cocktails?|mocktails?|meals?|chai|coffee|bites|nibbles|catering|buffet|high tea|f&b)\b/gi;
const TALK_RE = /\b(panel(s|ists?)?|speakers?|keynotes?|fireside|talks?|workshops?|masterclass|demo day)\b/gi;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    throw new Error(`${res.status} ${url.pathname}`);
  }
  throw new Error(`gave up on ${url.pathname}`);
}

async function discover(params) {
  const out = [];
  let cursor;
  for (let page = 0; page < 15; page++) {
    const d = await getJSON("/discover/get-paginated-events", {
      ...params, pagination_limit: 50, ...(cursor ? { pagination_cursor: cursor } : {}),
    });
    out.push(...(d.entries || []));
    if (!d.has_more) break;
    cursor = d.next_cursor;
  }
  return out;
}

function distanceKm(c) {
  if (!c) return Infinity;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(c.latitude - MUMBAI.lat), dLon = rad(c.longitude - MUMBAI.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(MUMBAI.lat)) * Math.cos(rad(c.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// Luma descriptions are ProseMirror JSON; flatten to plain text.
const flatten = (n) => !n ? "" : (n.text || "") + (n.content || []).map(flatten).join(" ") + (n.type === "paragraph" ? "\n" : "");
const uniq = (arr) => [...new Set(arr.map((s) => s.toLowerCase()))];

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]); }
  }));
  return results;
}

const fmt = (iso, opts) => new Intl.DateTimeFormat("en-IN", { timeZone: TZ, ...opts }).format(new Date(iso));
const dayKey = (iso) => fmt(iso, { year: "numeric", month: "2-digit", day: "2-digit" });

async function main() {
  // 1. Collect candidates from the Mumbai feed and the tech/AI/crypto categories near Mumbai.
  const pool = new Map();
  const add = (entries, source) => {
    for (const e of entries) {
      const prev = pool.get(e.event.api_id);
      pool.set(e.event.api_id, { ...e, sources: [...(prev?.sources || []), source] });
    }
  };
  add(await discover({ discover_place_api_id: MUMBAI.place }), "mumbai");
  for (const cat of CATEGORIES) {
    add(await discover({ discover_category_api_id: cat, latitude: MUMBAI.lat, longitude: MUMBAI.lon }), cat);
  }

  const now = Date.now(), horizon = now + DAYS_AHEAD * 864e5;
  const candidates = [...pool.values()].filter(({ event: ev, ticket_info: t }) => {
    const geo = ev.geo_address_info || {};
    const inMumbai = /mumbai|thane|navi mumbai/i.test(`${geo.city || ""} ${geo.city_state || ""}`) ||
      distanceKm(ev.coordinate || geo.coordinate) <= RADIUS_KM;
    const start = Date.parse(ev.start_at), end = Date.parse(ev.end_at || ev.start_at);
    return ev.location_type === "offline" && t?.is_free && inMumbai && end > now && start < horizon;
  });

  // 2. Pull full details (description, questions) and tag each event.
  const events = (await mapLimit(candidates, 4, async (c) => {
    const d = await getJSON("/event/get", { event_api_id: c.event.api_id }).catch(() => null);
    const ev = c.event, geo = ev.geo_address_info || {};
    const text = flatten(d?.description_mirror).replace(/\s+/g, " ").trim();
    const isTech = c.sources.some((s) => s.startsWith("cat-")) || TECH_RE.test(`${ev.name} ${text}`);
    if (!isTech || NOT_EVENT_RE.test(ev.name)) return null;
    const startDay = dayKey(ev.start_at), endDay = dayKey(ev.end_at || ev.start_at);
    return {
      id: ev.api_id,
      name: ev.name,
      url: `https://luma.com/${ev.url}`,
      start: ev.start_at,
      end: ev.end_at || ev.start_at,
      venue: geo.address || geo.full_address?.split(",")[0] || "Mumbai",
      area: geo.full_address || geo.description || "Mumbai",
      city: geo.city || "Mumbai",
      hosts: (d?.hosts || c.hosts || []).map((h) => h.name).filter(Boolean).slice(0, 3),
      going: c.guest_count || 0,
      food: uniq(text.match(FOOD_RE) || []),
      talks: uniq(text.match(TALK_RE) || []),
      multiDay: startDay !== endDay && Date.parse(ev.end_at) - Date.parse(ev.start_at) > 20 * 3600e3,
      approval: !!c.ticket_info?.require_approval,
      full: !!(c.ticket_info?.is_sold_out || d?.waitlist_active),
      questions: (d?.registration_questions || []).length,
      cover: ev.cover_url || c.cover_image?.url || null,
      summary: text.slice(0, 220),
    };
  })).filter(Boolean).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  // Paid pinned spots: pinned.json is [{ "id": "evt-…", "until": "YYYY-MM-DD" }].
  const pins = await readFile("pinned.json", "utf8").then(JSON.parse).catch(() => []);
  const pinned = new Set(pins.filter((p) => Date.parse(`${p.until}T23:59:59+05:30`) > now).map((p) => p.id));
  for (const e of events) e.sponsored = pinned.has(e.id);
  events.sort((a, b) => b.sponsored - a.sponsored);

  const builtAt = new Date().toISOString();
  await mkdir("docs", { recursive: true });
  await writeFile("docs/events.json", JSON.stringify({ builtAt, events }, null, 2));
  const digest = buildDigest(events);
  await writeFile("docs/digest.txt", digest);
  await writeFile("docs/index.html", buildPage(events, digest, builtAt));
  await writeFile("docs/events.ics", buildIcs(events, builtAt));
  await writeFile("docs/feed.xml", buildRss(events, builtAt));
  console.log(`pool=${pool.size} candidates=${candidates.length} published=${events.length}`);
}

function badges(e) {
  return [e.talks.length && "🎤", e.food.length && "🍕", e.multiDay && "🗓️", e.full && "⏳"].filter(Boolean).join("");
}

function buildDigest(events) {
  const cutoff = Date.now() + DIGEST_DAYS * 864e5;
  const week = events.filter((e) => Date.parse(e.start) < cutoff);
  const lines = [`*Mumbai tech events · next 7 days*`, `Free · in person · 🎤 talks 🍕 food 🗓️ multi-day ⏳ waitlist`, ""];
  let lastDay = "";
  for (const e of week.slice(0, 20)) {
    const day = fmt(e.start, { weekday: "short", day: "numeric", month: "short" });
    if (day !== lastDay) { lines.push(`*${day}*`); lastDay = day; }
    const time = fmt(e.start, { hour: "numeric", minute: "2-digit", hour12: true }).replace(" ", "").toLowerCase();
    lines.push(`• ${time} ${e.name} ${badges(e)}${e.sponsored ? " · Sponsored" : ""}`.trim(), `  ${e.url.replace("https://", "")}`);
  }
  if (!week.length) lines.push("Nothing new this week.");
  lines.push("", `All ${events.length} upcoming: ${SITE_URL}`);
  return lines.join("\n");
}

// iCalendar (RFC 5545): CRLF line ends, text escaped, lines folded at 75 octets.
const icsText = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function icsFold(line) {
  const out = [];
  let buf = "", bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 75) { out.push(buf); buf = " "; bytes = 1; }
    buf += ch; bytes += b;
  }
  out.push(buf);
  return out.join("\r\n");
}

function buildIcs(events, builtAt) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mumbai Event Radar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Free tech events in Mumbai",
    `X-WR-CALDESC:${icsText(`Free, in-person AI, startup and crypto events in Mumbai, updated every morning. ${SITE_URL}`)}`,
    `X-WR-TIMEZONE:${TZ}`, "REFRESH-INTERVAL;VALUE=DURATION:PT12H", "X-PUBLISHED-TTL:PT12H",
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@event-radar.shubham-sahu.me`,
      `DTSTAMP:${icsTime(builtAt)}`,
      `DTSTART:${icsTime(e.start)}`,
      `DTEND:${icsTime(e.end)}`,
      `SUMMARY:${icsText(e.name)}`,
      `LOCATION:${icsText(e.area)}`,
      `URL:${e.url}`,
      `DESCRIPTION:${icsText(`Register on Luma: ${e.url}\n${e.summary ? `${e.summary}…\n` : ""}\nMore free Mumbai tech events: ${SITE_URL}`)}`,
      "STATUS:CONFIRMED", "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

function buildRss(events, builtAt) {
  const items = events.map((e) => {
    const when = fmt(e.start, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
    return `<item><title>${esc(`${when} · ${e.name}`)}</title><link>${esc(e.url)}</link><guid isPermaLink="false">${esc(e.id)}</guid><description>${esc(`${e.venue}. ${e.summary}`)}</description></item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Free tech events in Mumbai</title>
<link>${esc(SITE_URL)}</link>
<description>Free, in-person AI, startup and crypto events in Mumbai, updated every morning.</description>
<lastBuildDate>${new Date(builtAt).toUTCString()}</lastBuildDate>
${items}
</channel></rss>
`;
}

// schema.org Event markup so search engines can show each event.
function jsonLd(events) {
  const graph = events.map((e) => ({
    "@type": "Event",
    name: e.name,
    startDate: e.start,
    endDate: e.end,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    isAccessibleForFree: true,
    location: {
      "@type": "Place",
      name: e.venue,
      address: { "@type": "PostalAddress", streetAddress: e.area, addressLocality: e.city || "Mumbai", addressRegion: "Maharashtra", addressCountry: "IN" },
    },
    ...(e.cover ? { image: [e.cover] } : {}),
    ...(e.summary ? { description: e.summary } : {}),
    url: e.url,
    offers: { "@type": "Offer", price: 0, priceCurrency: "INR", url: e.url, availability: e.full ? "https://schema.org/SoldOut" : "https://schema.org/InStock" },
    ...(e.hosts.length ? { organizer: { "@type": "Organization", name: e.hosts.join(", "), url: e.url } } : {}),
  }));
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function gcalLink(e) {
  const t = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const u = new URL("https://calendar.google.com/calendar/render");
  u.searchParams.set("action", "TEMPLATE");
  u.searchParams.set("text", e.name);
  u.searchParams.set("dates", `${t(e.start)}/${t(e.end)}`);
  u.searchParams.set("location", e.area);
  u.searchParams.set("details", `Luma: ${e.url}`);
  return u.toString();
}

function card(e) {
  const date = fmt(e.start, { weekday: "short", day: "numeric", month: "short" });
  const time = `${fmt(e.start, { hour: "numeric", minute: "2-digit", hour12: true })} – ${fmt(e.end, { hour: "numeric", minute: "2-digit", hour12: true })}`;
  const endDate = e.multiDay ? ` → ${fmt(e.end, { day: "numeric", month: "short" })}` : "";
  const tags = [
    e.sponsored && `<span class="tag sponsored">Sponsored</span>`,
    e.talks.length && `<span class="tag talk">🎤 ${esc(e.talks.slice(0, 2).join(", "))}</span>`,
    e.food.length && `<span class="tag food">🍕 ${esc(e.food.slice(0, 2).join(", "))}</span>`,
    e.multiDay && `<span class="tag multi">🗓️ multi-day</span>`,
    e.full && `<span class="tag full">⏳ full · waitlist</span>`,
    e.approval && `<span class="tag">needs approval</span>`,
  ].filter(Boolean).join("");
  return `<article class="card${e.sponsored ? " sponsored" : ""}" data-start="${esc(e.start)}" data-food="${e.food.length > 0}" data-talks="${e.talks.length > 0}" data-multi="${e.multiDay}">
  <div class="when"><b>${esc(date)}${esc(endDate)}</b><span>${esc(time)}</span></div>
  <h2><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a></h2>
  <p class="where">${esc(e.venue)}${e.hosts.length ? ` · by ${esc(e.hosts.join(", "))}` : ""}${e.going ? ` · ${e.going} going` : ""}</p>
  ${e.summary ? `<p class="sum">${esc(e.summary)}…</p>` : ""}
  <div class="tags">${tags}</div>
  <div class="actions">
    <a class="btn primary" href="${esc(e.url)}" target="_blank" rel="noopener">Register on Luma</a>
    <a class="btn" href="${esc(gcalLink(e))}" target="_blank" rel="noopener">Add to calendar</a>
  </div>
</article>`;
}

function buildPage(events, digest, builtAt) {
  const updated = fmt(builtAt, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
  const wa = `https://wa.me/?text=${encodeURIComponent(digest)}`;
  const gcalSubscribe = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(WEBCAL_URL)}`;
  const description = `${events.length} free, in-person tech events in Mumbai this month: AI, startups, crypto and developer meetups. Updated every morning at 6:30 IST.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Free Tech Events in Mumbai This Week | Mumbai Event Radar</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(SITE_URL)}">
<link rel="alternate" type="application/rss+xml" title="Free tech events in Mumbai" href="${esc(SITE_URL)}feed.xml">
<link rel="alternate" type="text/calendar" title="Free tech events in Mumbai" href="${esc(ICS_URL)}">
<meta name="robots" content="max-image-preview:large">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(SITE_URL)}">
<meta property="og:title" content="Free tech events in Mumbai this week">
<meta property="og:description" content="${esc(description)}">
<script type="application/ld+json">${jsonLd(events)}</script>
<style>
:root{--bg:#f6f6f4;--card:#fff;--ink:#141414;--muted:#6b6b6b;--line:#e6e6e2;--accent:#141414;--accent-ink:#fff;--wa:#1f8f4e;--tag:#f0f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e0e;--card:#181818;--ink:#f2f2f2;--muted:#9a9a9a;--line:#2a2a2a;--accent:#f2f2f2;--accent-ink:#111;--wa:#25a35a;--tag:#232323}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}
header h1{font-size:28px;line-height:1.15;margin:0 0 6px;letter-spacing:-.02em}
header p{margin:0;color:var(--muted)}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 16px;align-items:center}
.chip{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:7px 14px;font:inherit;cursor:pointer;min-height:36px}
.chip[aria-pressed=true]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.wa{display:inline-flex;align-items:center;gap:8px;background:var(--wa);color:#fff;text-decoration:none;border-radius:12px;padding:12px 16px;font-weight:600;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.when{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.when b{color:var(--ink);font-size:14px}
h2{font-size:17px;line-height:1.3;margin:6px 0 4px}
h2 a{color:inherit;text-decoration:none}
.where,.sum{margin:0 0 8px;color:var(--muted);font-size:14px}
.sum{font-size:13.5px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 12px}
.tag{background:var(--tag);border-radius:8px;padding:3px 8px;font-size:12.5px}
.tag.sponsored{background:var(--accent);color:var(--accent-ink)}
.card.sponsored{border-color:var(--accent)}
.brand{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin:0 0 6px!important}
.subs{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.intro{color:var(--muted);font-size:14px;margin:24px 0 0}
footer a,.intro a{color:inherit}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{border:1px solid var(--line);border-radius:10px;padding:9px 14px;text-decoration:none;color:var(--ink);font-size:14px;min-height:40px;display:inline-flex;align-items:center}
.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.empty{color:var(--muted);text-align:center;padding:40px 0}
footer{color:var(--muted);font-size:12.5px;margin-top:32px}
</style>
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"cc6413a12f3d4cb29e824cf64f3d7f43"}'></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-R10BYGZFYW"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-R10BYGZFYW',location.search.indexOf('ga_debug=1')>-1?{debug_mode:true}:{});document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a.wa');if(a)gtag('event','whatsapp_share');});</script>
</head>
<body>
<main>
<header>
  <p class="brand">Mumbai Event Radar</p>
  <h1>Free tech events in Mumbai</h1>
  <p>${events.length} free, in-person tech events · AI, crypto, startups · updated ${esc(updated)}</p>
  <a class="wa" href="${esc(wa)}" target="_blank" rel="noopener">Send this week to WhatsApp</a>
  <div class="subs">
    <a class="btn" href="${esc(gcalSubscribe)}" target="_blank" rel="noopener">Get every event in Google Calendar</a>
    <a class="btn" href="${esc(WEBCAL_URL)}">Apple / Outlook calendar</a>
    ${WA_CHANNEL_URL ? `<a class="btn" href="${esc(WA_CHANNEL_URL)}" target="_blank" rel="noopener">Follow on WhatsApp</a>` : ""}
  </div>
</header>
<div class="bar" role="group" aria-label="Filter">
  <button class="chip" data-f="all" aria-pressed="true">All</button>
  <button class="chip" data-f="week" aria-pressed="false">This week</button>
  <button class="chip" data-f="talks" aria-pressed="false">🎤 Talks</button>
  <button class="chip" data-f="food" aria-pressed="false">🍕 Food</button>
  <button class="chip" data-f="multi" aria-pressed="false">🗓️ Multi-day</button>
</div>
<section id="list">
${events.map(card).join("\n") || '<p class="empty">No events right now.</p>'}
</section>
<p class="empty" id="none" hidden>Nothing matches this filter.</p>
<p class="intro">Every morning at 6:30 IST this page collects free, in-person AI, startup, crypto and developer events in Mumbai, Thane and Navi Mumbai from Luma, and drops paid and online ones. Subscribe to the calendar once and new events show up in your calendar by themselves.</p>
<p class="intro"><b>Running a free tech event in Mumbai?</b> If it's on Luma, it shows up here on its own. To pin it to the top as a sponsored listing, email <a href="mailto:${CONTACT}?subject=${encodeURIComponent("Pin my event on Mumbai Event Radar")}">${CONTACT}</a>.</p>
<footer>Listings come from Luma's public Discover feed. Register and submit on Luma yourself. <a href="${esc(SITE_URL)}feed.xml">RSS</a> · <a href="/privacy/">Privacy</a></footer>
</main>
<script>
const chips=[...document.querySelectorAll('.chip')],cards=[...document.querySelectorAll('.card')];
const weekEnd=Date.now()+7*864e5;
const test={all:()=>true,week:c=>Date.parse(c.dataset.start)<weekEnd,talks:c=>c.dataset.talks==='true',food:c=>c.dataset.food==='true',multi:c=>c.dataset.multi==='true'};
function apply(f){chips.forEach(b=>b.setAttribute('aria-pressed',b.dataset.f===f));let n=0;cards.forEach(c=>{const ok=test[f](c);c.hidden=!ok;n+=ok});document.getElementById('none').hidden=n>0;try{localStorage.setItem('radar-filter',f)}catch(e){}}
chips.forEach(b=>b.addEventListener('click',()=>apply(b.dataset.f)));
try{const f=localStorage.getItem('radar-filter');if(f&&test[f])apply(f)}catch(e){}
</script>
</body>
</html>`;
}

main().catch((err) => { console.error(err); process.exit(1); });
