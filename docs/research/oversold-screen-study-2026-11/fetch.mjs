// Fetch step of the survivor-only exploratory study. Throttled 1 req/s, disk-cached, 429 backoff.
import fs from 'node:fs';
import path from 'node:path';
const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CACHE = path.join(DIR, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const syms = fs.readFileSync(path.join(DIR, 'universe.txt'), 'utf8').split(/\s+/).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let consecutive429 = 0, failed = [], fetched = 0, cached = 0;
for (const s of syms) {
  const f = path.join(CACHE, s + '.json');
  if (fs.existsSync(f)) { cached++; continue; }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=10y&interval=1d&events=div%7Csplit`;
  let ok = false;
  for (let attempt = 0; attempt < 5 && !ok; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.status === 429) {
        consecutive429++;
        if (consecutive429 >= 8) { console.log('BLOCKED: repeated 429s, stopping.'); fs.writeFileSync(path.join(DIR, 'fetch_status.json'), JSON.stringify({ blocked: true, fetched, cached, failed })); process.exit(2); }
        const wait = 15000 * 2 ** attempt; console.log(`429 on ${s}, wait ${wait}ms`); await sleep(wait); continue;
      }
      consecutive429 = 0;
      if (r.status === 404) { failed.push([s, '404']); ok = true; fs.writeFileSync(f, JSON.stringify({ error: 404 })); break; }
      if (!r.ok) { failed.push([s, 'HTTP ' + r.status]); await sleep(2000); continue; }
      const txt = await r.text();
      fs.writeFileSync(f, txt); fetched++; ok = true;
    } catch { await sleep(3000); }
  }
  if (!ok) failed.push([s, 'gave up']);
  await sleep(1100);
  if ((fetched + failed.length) % 50 === 0) console.log(`progress fetched=${fetched} failed=${failed.length}`);
}
fs.writeFileSync(path.join(DIR, 'fetch_status.json'), JSON.stringify({ blocked: false, fetched, cached, failed }, null, 1));
console.log('done', { fetched, cached, failed: failed.length });
