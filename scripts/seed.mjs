// Usage: TMDB_API_KEY=xxxx node scripts/seed.mjs
// Writes scripts/seed.json (chain fields) and frontend/public/movies-meta.json (display metadata).
// Order matters: the position in MOVIES is the on-chain movie id, so only append.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = process.env.TMDB_API_KEY;
if (!KEY) {
  console.error('Set TMDB_API_KEY (free v3 key from themoviedb.org).');
  process.exit(1);
}

// windowDays: voting stays open this long from now. windowMinutes is for demoing claim_bond.
const MOVIES = [
  { query: 'Rockstar', year: 2011, windowDays: 7 },
  { query: 'Coraline', year: 2009, windowDays: 7 },
  { query: 'Rocky', year: 1976, windowDays: 7 },
  { query: 'Godzilla Minus Zero', year: 2026, windowDays: 14 },
  { query: 'The Hunger Games: Sunrise on the Reaping', year: 2026, windowDays: 14 },
  { query: 'Spirited Away', year: 2001, windowMinutes: 15 },
  { query: 'Dangal', year: 2016, windowDays: 9 },
  { query: '3 Idiots', year: 2009, windowDays: 9 },
  { query: 'Gangs of Wasseypur', year: 2012, windowDays: 10 },
  { query: 'Tumbbad', year: 2018, windowDays: 8 },
  { query: 'Zindagi Na Milegi Dobara', year: 2011, windowDays: 12 },
  { query: 'Barfi!', year: 2012, windowDays: 11 },
  { query: 'Andhadhun', year: 2018, windowDays: 10 },
  { query: 'Jab We Met', year: 2007, windowDays: 13 },
  { query: 'Taare Zameen Par', year: 2007, windowDays: 9 },
  { query: 'Drishyam', year: 2015, windowDays: 12 },
  { query: 'Inception', year: 2010, windowDays: 8 },
  { query: 'Interstellar', year: 2014, windowDays: 10 },
  { query: 'The Dark Knight', year: 2008, windowDays: 11 },
  { query: 'Parasite', year: 2019, windowDays: 9 },
  { query: 'Oppenheimer', year: 2023, windowDays: 13 },
  { query: 'Spider-Man: Into the Spider-Verse', year: 2018, windowDays: 8 },
  { query: 'Whiplash', year: 2014, windowMinutes: 15 },
  { query: 'The Shawshank Redemption', year: 1994, windowDays: 12 },
  { query: 'Your Name.', year: 2016, windowDays: 10 },
  { query: 'Fight Club', year: 1999, windowDays: 9 },
  { query: 'Pulp Fiction', year: 1994, windowDays: 11 },
  { query: 'Mad Max: Fury Road', year: 2015, windowDays: 14 },
];

const DAY_MS = 86_400_000;
const now = Date.now();
const here = dirname(fileURLToPath(import.meta.url));

async function tmdb(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}`);
  return res.json();
}

const chain = [];
const meta = {};

for (const m of MOVIES) {
  const hit = (await tmdb('/search/movie', { query: m.query, year: m.year })).results?.[0];
  if (!hit) {
    console.error(`No TMDB match for "${m.query}" (${m.year}). Fix it before seeding so ids stay in order.`);
    process.exit(1);
  }
  const d = await tmdb(`/movie/${hit.id}`, { append_to_response: 'credits' });
  const windowMs = m.windowMinutes ? m.windowMinutes * 60_000 : m.windowDays * DAY_MS;

  chain.push({
    tmdb_id: d.id,
    title: d.title,
    poster_url: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : '',
    release_ts_ms: String(d.release_date ? Date.parse(d.release_date) : now),
    vote_end_ts_ms: String(now + windowMs),
  });

  meta[d.id] = {
    year: d.release_date ? Number(d.release_date.slice(0, 4)) : null,
    runtime: d.runtime || null,
    language: d.original_language,
    tagline: d.tagline || '',
    overview: d.overview || '',
    genres: (d.genres ?? []).map((g) => g.name),
    backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
    director: d.credits?.crew?.find((c) => c.job === 'Director')?.name ?? '',
    cast: (d.credits?.cast ?? []).slice(0, 6).map((c) => ({ name: c.name, role: c.character })),
  };
  console.log(`ok  ${d.title} (${d.release_date ?? 'n/a'})`);
}

writeFileSync(join(here, 'seed.json'), JSON.stringify(chain, null, 2) + '\n');
const metaDir = join(here, '..', 'frontend', 'public');
mkdirSync(metaDir, { recursive: true });
writeFileSync(join(metaDir, 'movies-meta.json'), JSON.stringify(meta));
console.log(`Wrote ${chain.length} movies to seed.json and movies-meta.json`);
