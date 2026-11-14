// Usage: TMDB_API_KEY=xxxx [OMDB_API_KEY=yyyy] node scripts/seed.mjs
// Picks up to 30 of the highest-grossing non-Indian theatrical releases from the last 60 days, then writes
//   scripts/seed.json                    (chain fields; position in the file = on-chain movie id)
//   frontend/public/movies-meta.json     (display metadata keyed by tmdb_id)
// With OMDB_API_KEY set, movies whose OMDb BoxOffice is "N/A" are rejected, since markets need that number.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMDB_KEY = process.env.TMDB_API_KEY;
const OMDB_KEY = process.env.OMDB_API_KEY;
if (!TMDB_KEY) {
  console.error('Set TMDB_API_KEY (free v3 key from themoviedb.org).');
  process.exit(1);
}

const WANT = 30;
const MAX_PAGES = 10;
const WINDOW_DAYS = 60;
const VOTE_WINDOW_DAYS = 10;
const MIN_REVENUE = Number(process.env.MIN_REVENUE ?? 5_000_000); // proxy for a real theatrical run
const INDIAN_LANGS = new Set(['hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa', 'gu', 'ur', 'or', 'as']);
const DAY_MS = 86_400_000;

const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);
const from = new Date(now - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
const here = dirname(fileURLToPath(import.meta.url));

async function tmdb(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('api_key', TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}`);
  return res.json();
}

async function omdbBoxOffice(imdbId) {
  const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_KEY}`);
  if (!res.ok) throw new Error(`OMDb ${res.status} for ${imdbId}`);
  const body = await res.json();
  if (body.Response === 'False') throw new Error(`OMDb: ${body.Error}`);
  return body.BoxOffice;
}

function rejectReason(d) {
  if (d.status !== 'Released') return `status is ${d.status}`;
  if (!d.release_date || d.release_date > today) return 'not released yet';
  if (INDIAN_LANGS.has(d.original_language)) return `Indian language (${d.original_language})`;
  if ((d.production_countries ?? []).some((c) => c.iso_3166_1 === 'IN')) return 'Indian production';
  if (!d.imdb_id) return 'no IMDb id';
  if (!d.poster_path) return 'no poster';
  if (!d.revenue || d.revenue < MIN_REVENUE) return `TMDB revenue ${d.revenue || 0} is under ${MIN_REVENUE} (not a clear theatrical earner)`;
  return null;
}

if (!OMDB_KEY) {
  console.warn('WARNING: OMDB_API_KEY not set, so OMDb BoxOffice availability was NOT verified for these movies.');
}

const picked = [];
const seen = new Set();
let lowRevenueStreak = 0;

for (let page = 1; page <= MAX_PAGES && picked.length < WANT && lowRevenueStreak < 5; page++) {
  const list = await tmdb('/discover/movie', {
    'primary_release_date.gte': from,
    'primary_release_date.lte': today,
    region: 'US',
    sort_by: 'revenue.desc',
    with_release_type: '3|2',
    include_adult: 'false',
    page,
  });
  if (!list.results?.length) break;

  for (const c of list.results) {
    if (picked.length >= WANT || lowRevenueStreak >= 5) break;
    if (seen.has(c.id)) continue;
    seen.add(c.id);

    const d = await tmdb(`/movie/${c.id}`, { append_to_response: 'credits' });
    let why = rejectReason(d);
    // Voting does not need box-office data, so a missing OMDb number only marks the movie as
    // "no markets". Set REQUIRE_OMDB=1 to drop such movies from the catalog instead.
    let omdbBox = null;
    if (!why && OMDB_KEY) {
      try {
        const box = await omdbBoxOffice(d.imdb_id);
        omdbBox = box && box !== 'N/A' ? box : null;
        if (!omdbBox && process.env.REQUIRE_OMDB === '1') why = 'OMDb BoxOffice is N/A';
      } catch (e) {
        why = e.message;
      }
    }
    // Results are sorted by revenue, so a run of low earners means the rest are lower still.
    lowRevenueStreak = why?.startsWith('TMDB revenue') ? lowRevenueStreak + 1 : 0;
    if (why) {
      console.log(`skip  ${d.title} (${d.release_date}): ${why}`);
      continue;
    }
    picked.push({ d, revenue: d.revenue, omdbBox });
  }
}

if (picked.length < WANT) {
  console.warn(`WARNING: only ${picked.length} movies qualified out of ${WANT} wanted.`);
}

picked.sort((a, b) => b.revenue - a.revenue || a.d.id - b.d.id);

const chain = [];
const meta = {};
for (const { d, omdbBox } of picked) {
  chain.push({
    tmdb_id: d.id,
    title: d.title,
    poster_url: `https://image.tmdb.org/t/p/w500${d.poster_path}`,
    release_ts_ms: String(Date.parse(d.release_date)),
    vote_end_ts_ms: String(now + VOTE_WINDOW_DAYS * DAY_MS),
  });
  meta[d.id] = {
    year: Number(d.release_date.slice(0, 4)),
    runtime: d.runtime || null,
    language: d.original_language,
    tagline: d.tagline || '',
    overview: d.overview || '',
    genres: (d.genres ?? []).map((g) => g.name),
    backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
    director: d.credits?.crew?.find((c) => c.job === 'Director')?.name ?? '',
    cast: (d.credits?.cast ?? []).slice(0, 6).map((c) => ({ name: c.name, role: c.character })),
    imdb_id: d.imdb_id,
    omdb_box_office: omdbBox,
  };
}

writeFileSync(join(here, 'seed.json'), JSON.stringify(chain, null, 2) + '\n');
const metaDir = join(here, '..', 'frontend', 'public');
mkdirSync(metaDir, { recursive: true });
writeFileSync(join(metaDir, 'movies-meta.json'), JSON.stringify(meta));

console.log(`\nSelected ${chain.length} movies (movie id = position):`);
picked.forEach(({ d, omdbBox }, i) => {
  const box = OMDB_KEY ? (omdbBox ? `OMDb ${omdbBox}` : 'no OMDb box office') : '';
  console.log(`${String(i).padStart(2)}  ${d.release_date}  ${d.imdb_id.padEnd(10)} ${d.title}  ${box}`);
});
console.log(`Wrote seed.json and movies-meta.json`);
