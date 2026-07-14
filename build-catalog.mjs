#!/usr/bin/env node
/**
 * Builds public/catalog-v1.json from seeds.json.
 *
 * Runs hourly via GitHub Actions (see .github/workflows/build.yml) or locally:
 *   npm ci && node build-catalog.mjs
 *
 * Design rules (see docs/catalog-umsetzungsplan.md in the app repo):
 *  - Never publish a broken catalog: validate, else exit(1) → old file stays.
 *  - Self-healing: a feed that fails THIS run keeps its entry from the
 *    previous catalog instead of vanishing from every installed app.
 *  - IDs replicate the app's rules exactly (services/podcasts/feed.ts):
 *    show id   = apple digits | "substack-<nr>" | "rss-<fnv1a base36>"
 *    episode id = `${showId}:${guid ?? audioUrl}`
 *    — identical ids are what make the client's union-merge dedupe.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'public', 'catalog-v1.json');
const EPISODES_PER_SHOW = 20;
const FEED_TIMEOUT_MS = 20_000;
/** Publish only if at least this share of seeds made it (incl. self-healed). */
const MIN_SHOW_RATIO = 0.75;

// ── id rules (MUST mirror the app's extractPodcastId) ───────────────────────

function idForSeed(seed) {
  if (seed.appleId) return String(seed.appleId);
  const url = new URL(seed.feedUrl);
  const substackId = url.pathname.match(/\/podcast\/(\d+)(?:\.rss)?\/?$/)?.[1];
  if (substackId) return `substack-${substackId}`;
  let hash = 2166136261;
  const canonical = url.toString();
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `rss-${(hash >>> 0).toString(36)}`;
}

// ── small helpers ────────────────────────────────────────────────────────────

const text = (v) => {
  // fast-xml-parser yields strings, numbers, or { '#text': … } objects
  // (and arrays when a tag repeats — take the first).
  if (v == null) return undefined;
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text(v['#text']);
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
};

const attr = (v, name) => {
  if (v == null) return undefined;
  if (Array.isArray(v)) return attr(v[0], name);
  if (typeof v === 'object') return text(v[`@_${name}`]);
  return undefined;
};

function durationToSec(raw) {
  if (!raw) return 0;
  if (raw.includes(':')) {
    const parts = raw.split(':').map(Number);
    while (parts.length < 3) parts.unshift(0);
    const [h, m, s] = parts;
    return Number.isFinite(h + m + s) ? h * 3600 + m * 60 + s : 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toIso(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

/** Strip HTML tags/entities and cap length — show notes are often whole pages. */
function plainText(raw, max = 500) {
  if (!raw) return undefined;
  const s = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function fetchWithRetry(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        redirect: 'follow',
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: { 'user-agent': 'radiokosova-catalog-builder/1.0', ...init.headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (attempt >= 1) throw e; // one retry, then give up (self-healing takes over)
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── live-stream probing ──────────────────────────────────────────────────────
//
// Raw sockets instead of fetch(): Shoutcast v1 answers with "ICY 200 OK",
// which is not valid HTTP — undici/fetch rejects the response even though
// the stream is perfectly alive. Speaking HTTP/1.0 on a plain socket accepts
// both worlds, and a couple of body bytes prove audio actually flows.

const STREAM_PROBE_TIMEOUT_MS = 8000;

/** One connection attempt. Resolves { ok } or { redirect } (3xx Location). */
function probeOnce(url) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ ok: false });
    }
    const secure = u.protocol === 'https:';
    const port = u.port ? Number(u.port) : secure ? 443 : 80;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const socket = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false })
      : net.connect({ host: u.hostname, port });
    const timer = setTimeout(() => finish({ ok: false }), STREAM_PROBE_TIMEOUT_MS);
    socket.on('error', () => finish({ ok: false }));
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.0\r\n` +
          `Host: ${u.hostname}\r\n` +
          `User-Agent: radiokosova-catalog-builder/1.0\r\n` +
          `Icy-MetaData: 0\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
    });
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const nl = buf.indexOf('\n');
      if (nl < 0 && buf.length < 512) return; // wait for a full status line
      const status = buf.slice(0, nl >= 0 ? nl : 512).match(/^(?:HTTP\/\d\.\d|ICY)\s+(\d{3})/);
      if (!status) {
        // No HTTP/ICY status line at all, but the server is pushing bytes —
        // some ancient Shoutcasts stream raw audio straight away.
        if (buf.length > 2048) finish({ ok: true });
        return;
      }
      const code = Number(status[1]);
      if (code >= 300 && code < 400) {
        const loc = buf.match(/\r?\nlocation:\s*(\S+)/i)?.[1];
        return finish(loc ? { redirect: new URL(loc, u).toString() } : { ok: false });
      }
      if (code !== 200) return finish({ ok: false });
      // 200 alone isn't proof (some mounts 200 then hang) — require body
      // bytes after the header terminator before declaring the stream live.
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd >= 0 && buf.length > headerEnd + 64) finish({ ok: true });
    });
  });
}

async function probeStream(url, redirectsLeft = 3) {
  const result = await probeOnce(url);
  if (result.redirect && redirectsLeft > 0) return probeStream(result.redirect, redirectsLeft - 1);
  return result.ok === true;
}

// ── pipeline ─────────────────────────────────────────────────────────────────

const seeds = JSON.parse(readFileSync(path.join(ROOT, 'seeds.json'), 'utf8')).podcasts;

// Step 1: resolve Apple ids → feedUrl + metadata (one batched lookup).
const appleIds = seeds.filter((s) => s.appleId).map((s) => String(s.appleId));
const appleMeta = new Map();
if (appleIds.length > 0) {
  const res = await fetchWithRetry(
    `https://itunes.apple.com/lookup?id=${appleIds.join(',')}&entity=podcast`,
  );
  const data = await res.json();
  for (const r of data?.results ?? []) {
    if (!r.collectionId || !r.feedUrl) continue;
    appleMeta.set(String(r.collectionId), {
      title: r.collectionName,
      author: r.artistName ?? '',
      feedUrl: r.feedUrl,
      imageUrl: r.artworkUrl600 ?? r.artworkUrl100,
      genre: r.primaryGenreName,
    });
  }
}

// Previous catalog for self-healing.
const previous = new Map();
let previousStations = [];
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    for (const p of prev.podcasts ?? []) previous.set(p.id, p);
    previousStations = prev.stations ?? [];
  } catch {
    /* corrupt previous file — heal nothing, rebuild everything */
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep CDATA content as regular text.
  cdataPropName: false,
  trimValues: true,
  // fxp's default entity-expansion limits (1000 total) are DoS protection
  // sized for untrusted input on end-user devices. A big feed legitimately
  // contains tens of thousands of &amp;/&#39; entities across hundreds of
  // episodes — two of our seeds tripped the default. This builder runs in a
  // throwaway CI job on public feeds, so generous-but-bounded limits are
  // the right trade-off.
  processEntities: {
    enabled: true,
    maxTotalExpansions: 1_000_000,
    maxEntityCount: 100_000,
    maxExpandedLength: 50_000_000,
  },
});

// Step 2+3+4: fetch, parse, normalise each seed (parallel).
const results = await Promise.all(
  seeds.map(async (seed) => {
    const id = idForSeed(seed);
    const meta = seed.appleId ? appleMeta.get(String(seed.appleId)) : undefined;
    const feedUrl = meta?.feedUrl ?? seed.feedUrl;
    if (!feedUrl) return { id, error: 'no feedUrl (lookup failed?)' };
    try {
      const res = await fetchWithRetry(feedUrl);
      const xml = await res.text();
      const doc = parser.parse(xml);
      const channel = doc?.rss?.channel ?? doc?.feed;
      if (!channel) throw new Error('no <channel> in feed');

      const showTitle = meta?.title ?? text(channel.title) ?? 'Podcast';
      const showImage =
        meta?.imageUrl ?? attr(channel['itunes:image'], 'href') ?? text(channel.image?.url);

      const rawItems = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
      const episodes = [];
      for (const item of rawItems) {
        const audioUrl = attr(item.enclosure, 'url');
        if (!audioUrl) continue; // not playable → skip, same rule as the app
        const guid = text(item.guid);
        const title = text(item.title) ?? 'Episode';
        const epNum = text(item['itunes:episode']);
        const seasonNum = text(item['itunes:season']);
        episodes.push({
          id: `${id}:${guid ?? audioUrl}`,
          title,
          audioUrl,
          publishedAt: toIso(text(item.pubDate)),
          durationSec: durationToSec(text(item['itunes:duration'])),
          imageUrl: attr(item['itunes:image'], 'href') ?? showImage,
          description: plainText(text(item.description) ?? text(item['itunes:summary'])),
          ...(epNum ? { episodeNumber: Number(epNum) } : {}),
          ...(seasonNum ? { seasonNumber: Number(seasonNum) } : {}),
        });
      }
      episodes.sort((a, b) => (b.publishedAt > a.publishedAt ? 1 : b.publishedAt < a.publishedAt ? -1 : 0));

      return {
        id,
        show: {
          id,
          title: showTitle,
          author: meta?.author ?? text(channel['itunes:author']) ?? text(channel.author) ?? '',
          feedUrl,
          imageUrl: showImage,
          genre: meta?.genre ?? attr(channel['itunes:category'], 'text'),
          description: plainText(text(channel.description), 1000),
          episodes: episodes.slice(0, EPISODES_PER_SHOW),
        },
      };
    } catch (e) {
      return { id, error: e.message };
    }
  }),
);

// Step 5: self-healing — failed feeds keep their previous entry.
const podcasts = [];
const failed = [];
for (const r of results) {
  if (r.show) {
    podcasts.push(r.show);
  } else if (previous.has(r.id)) {
    podcasts.push(previous.get(r.id));
    failed.push(`${r.id}: ${r.error} → kept previous entry`);
  } else {
    failed.push(`${r.id}: ${r.error} → NOT in catalog (no previous entry)`);
  }
}

// Step 6: validate, then write.
const problems = [];
if (podcasts.length < Math.ceil(seeds.length * MIN_SHOW_RATIO)) {
  problems.push(`only ${podcasts.length}/${seeds.length} shows survived`);
}
for (const p of podcasts) {
  if (!p.title) problems.push(`${p.id}: missing title`);
  if (!p.episodes?.length) problems.push(`${p.id}: no episodes`);
  else if (p.episodes.some((e) => !e.audioUrl)) problems.push(`${p.id}: episode without audioUrl`);
}
if (failed.length) console.log(`Feed issues:\n  ${failed.join('\n  ')}`);
if (problems.length) {
  console.error(`VALIDATION FAILED — not writing catalog:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// ── live-stream health check ─────────────────────────────────────────────────
// A station being down is DATA, not a build error — it must never fail the
// run. Exception: if EVERY station probes offline, the far likelier cause is
// a broken checker or runner network, so we keep the previous status instead
// of wrongly greying out the whole rail in every installed app.
let stations = [];
const stationsPath = path.join(ROOT, 'stations.json');
if (existsSync(stationsPath)) {
  const stationSeeds = JSON.parse(readFileSync(stationsPath, 'utf8')).stations ?? [];
  stations = await Promise.all(
    stationSeeds.map(async (s) => ({ id: s.id, online: await probeStream(s.streamUrl) })),
  );
  const offline = stations.filter((s) => !s.online);
  if (offline.length === stations.length && previousStations.length > 0) {
    console.log('Stream check: ALL offline → keeping previous status (checker/network suspect).');
    stations = previousStations;
  } else if (offline.length > 0) {
    console.log(`Streams offline: ${offline.map((s) => s.id).join(', ')}`);
  } else {
    console.log('Streams: all online.');
  }
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), podcasts, stations }, null, 1),
);
const kb = Math.round(Buffer.byteLength(readFileSync(OUT)) / 1024);
console.log(
  `catalog-v1.json written: ${podcasts.length} shows, ${podcasts.reduce((n, p) => n + p.episodes.length, 0)} episodes, ${stations.length} stations checked, ${kb} KB raw.`,
);
