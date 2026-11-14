// Kinora box-office data agent.
// For every movie that a live market depends on it reads the US domestic gross from OMDb, posts the
// reading on-chain with a hash of the raw OMDb response as evidence, and resolves markets whose time has come.
// TMDB is used only to map a movie's tmdb_id to its imdb_id.
//
// Usage:
//   TMDB_API_KEY=xxxx OMDB_API_KEY=yyyy node scripts/agent.mjs [--contract ID] [--signer ID] [--dry-run] [--force] [--loop SECONDS]
//   node scripts/agent.mjs --selftest
// The signer must be the contract's resolver (or owner) and have its key in the near CLI keychain.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// OMDb's BoxOffice is a string like "$292,576,195", or "N/A". Returns an integer, or null when unusable.
export function parseBoxOffice(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\$?\d{1,3}(,\d{3})*$|^\$?\d+$/.test(text)) return null;
  const value = Number(text.replace(/[$,]/g, ''));
  return Number.isSafeInteger(value) ? value : null;
}

function selftest() {
  const cases = [
    ['$292,576,195', 292576195],
    ['N/A', null],
    ['', null],
    ['$0', 0],
    ['$12,34,567', null],
    ['about $5 million', null],
    [undefined, null],
    ['1000', 1000],
  ];
  let failed = 0;
  for (const [input, expected] of cases) {
    const got = parseBoxOffice(input);
    const ok = got === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} parseBoxOffice(${JSON.stringify(input)}) = ${got}`);
  }
  if (failed) {
    console.error(`${failed} selftest case(s) failed`);
    process.exit(1);
  }
  console.log('selftest passed');
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };

  if (flag('selftest')) return selftest();

  const CONTRACT = opt('contract', process.env.KINORA_CONTRACT ?? 'kinora-yash-1114.testnet');
  // Scheduled runs set KEEPER_ACCOUNT and KEEPER_PRIVATE_KEY (kept as secrets); local runs use the near CLI keychain.
  // Secrets pasted into a settings page often carry a trailing line break, which the CLI rejects, so trim every key.
  const KEEPER_KEY = process.env.KEEPER_PRIVATE_KEY?.trim() || undefined;
  const SIGNER = opt('signer', process.env.KINORA_SIGNER ?? process.env.KEEPER_ACCOUNT ?? CONTRACT);
  const RPC = process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com';
  const DRY = flag('dry-run');
  const FORCE = flag('force');
  const LOOP_SECONDS = Number(opt('loop', '0'));
  const TMDB_KEY = process.env.TMDB_API_KEY?.trim();
  const OMDB_KEY = process.env.OMDB_API_KEY?.trim();
  const SAME_VALUE_COOLDOWN_MS = 24 * 3600 * 1000;
  const REFRESH_MS = 6 * 3600 * 1000;

  if (!OMDB_KEY) {
    console.error('Set OMDB_API_KEY (free key from omdbapi.com/apikey.aspx). OMDb is the only box-office source.');
    process.exit(1);
  }
  if (!TMDB_KEY) {
    console.error('Set TMDB_API_KEY (free v3 key from themoviedb.org). It is used to map tmdb_id to imdb_id.');
    process.exit(1);
  }

  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

  async function view(method, argsObj = {}) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: CONTRACT,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(argsObj)).toString('base64'),
        },
      }),
    });
    const body = await res.json();
    if (body.error || body.result?.error) {
      throw new Error(`view ${method} failed: ${JSON.stringify(body.error ?? body.result.error)}`);
    }
    return JSON.parse(Buffer.from(body.result.result).toString());
  }

  function send(method, argsObj) {
    if (DRY) {
      log(`dry-run: would call ${method} ${JSON.stringify(argsObj)}`);
      return;
    }
    execFileSync(
      'near',
      [
        'contract', 'call-function', 'as-transaction', CONTRACT, method,
        'json-args', JSON.stringify(argsObj),
        'prepaid-gas', '60 Tgas', 'attached-deposit', '0 NEAR',
        'sign-as', SIGNER, 'network-config', 'testnet',
        ...(KEEPER_KEY ? ['sign-with-plaintext-private-key', KEEPER_KEY, 'send'] : ['sign-with-keychain', 'send']),
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  }

  const imdbIds = new Map();
  async function imdbIdFor(tmdbId) {
    if (imdbIds.has(tmdbId)) return imdbIds.get(tmdbId);
    const res = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`);
    if (!res.ok) throw new Error(`TMDB ${res.status} while mapping movie ${tmdbId} to an IMDb id`);
    const id = (await res.json()).imdb_id || null;
    imdbIds.set(tmdbId, id);
    return id;
  }

  async function readOmdb(imdbId) {
    const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_KEY}`);
    if (!res.ok) throw new Error(`OMDb ${res.status} for ${imdbId}`);
    const raw = await res.text();
    const data = JSON.parse(raw);
    if (data.Response === 'False') throw new Error(`OMDb error for ${imdbId}: ${data.Error}`);
    return {
      rawBoxOffice: data.BoxOffice,
      value: parseBoxOffice(data.BoxOffice),
      evidenceHash: createHash('sha256').update(raw).digest('hex'),
      sourceUrl: `https://www.omdbapi.com/?i=${imdbId}`,
    };
  }

  async function runOnce() {
    const config = await view('get_config');
    if (SIGNER !== config.resolver && SIGNER !== config.owner) {
      log(`warning: ${SIGNER} is neither the resolver (${config.resolver}) nor the owner; posts will fail`);
    }
    const markets = await view('get_markets', { limit: 100 });
    const live = markets.filter((m) => m.state === 'open' || m.state === 'closed');
    if (live.length === 0) return log('no markets waiting on data');

    const now = Date.now();
    const movieIds = new Set();
    // movie id -> latest resolve time among its markets that are due now; a reading posted after
    // that time is required to settle them, so an "unchanged" value must still be posted.
    const dueAfter = new Map();
    for (const m of live) {
      const ids = [m.movie_id];
      if (m.kind === 1 && m.movie_b !== null && m.movie_b !== undefined) ids.push(m.movie_b);
      for (const id of ids) {
        movieIds.add(id);
        if (m.state === 'closed' && now >= Number(m.resolves_at_ms)) {
          dueAfter.set(id, Math.max(dueAfter.get(id) ?? 0, Number(m.resolves_at_ms)));
        }
      }
    }

    for (const movieId of movieIds) {
      try {
        const movie = await view('get_movie', { movie_id: movieId });
        const points = await view('get_data_points', { movie_id: movieId });
        const last = points[points.length - 1];
        const mustPost = dueAfter.has(movieId) && (!last || Number(last.posted_at_ms) < dueAfter.get(movieId));
        // Spare OMDb's daily request limit: a reading is only urgent when a market needs one to settle.
        if (!mustPost && !FORCE && last && now - Number(last.posted_at_ms) < REFRESH_MS) {
          log(`#${movieId} ${movie.title}: last reading is under ${REFRESH_MS / 3600000}h old, skipping OMDb`);
          continue;
        }
        const imdbId = await imdbIdFor(movie.tmdb_id);
        if (!imdbId) {
          log(`#${movieId} ${movie.title}: TMDB has no IMDb id, skipping`);
          continue;
        }
        const reading = await readOmdb(imdbId);

        if (reading.value === null) {
          log(`#${movieId} ${movie.title}: OMDb BoxOffice is ${JSON.stringify(reading.rawBoxOffice ?? null)}, skipping`);
        } else if (reading.value === 0 && !FORCE) {
          log(`#${movieId} ${movie.title}: OMDb reports $0, skipping`);
        } else if (last && reading.value < Number(last.value) && !FORCE) {
          log(`#${movieId} ${movie.title}: gross fell from ${last.value} to ${reading.value}, refusing to post (use --force)`);
        } else if (
          last && Number(last.value) === reading.value && now - Number(last.posted_at_ms) < SAME_VALUE_COOLDOWN_MS && !FORCE && !mustPost
        ) {
          log(`#${movieId} ${movie.title}: unchanged at ${reading.value}, nothing new to post`);
        } else {
          send('post_data_point', {
            movie_id: movieId,
            value: String(reading.value),
            source: 'OMDb',
            source_url: reading.sourceUrl,
            evidence_hash: reading.evidenceHash,
            fetched_at_ms: String(now),
          });
          log(`#${movieId} ${movie.title}: ${DRY ? 'would post' : 'posted'} $${reading.value.toLocaleString()} (evidence ${reading.evidenceHash.slice(0, 12)})`);
        }
      } catch (e) {
        log(`#${movieId}: ${e.message}`);
      }
    }

    // Close the loop: resolve markets whose time has come and whose movies all have a fresh reading.
    const fresh = await view('get_markets', { limit: 100 });
    const hasFreshReading = async (movieId, resolvesAt) =>
      (await view('get_data_points', { movie_id: movieId })).some((p) => Number(p.posted_at_ms) >= resolvesAt);

    for (const m of fresh.filter((x) => x.state === 'closed' && now >= Number(x.resolves_at_ms))) {
      const resolvesAt = Number(m.resolves_at_ms);
      const needed = [m.movie_id];
      if (m.kind === 1 && m.movie_b !== null && m.movie_b !== undefined) needed.push(m.movie_b);
      const ready = (await Promise.all(needed.map((id) => hasFreshReading(id, resolvesAt)))).every(Boolean);
      if (!ready) {
        log(`market #${m.id}: waiting for a fresh reading on ${needed.length === 2 ? 'both movies' : 'its movie'}`);
        continue;
      }
      try {
        send('resolve_market', { market_id: m.id });
        log(`market #${m.id}: resolve_market submitted`);
      } catch (e) {
        log(`market #${m.id}: ${e.message}`);
      }
    }
  }

  do {
    try {
      await runOnce();
    } catch (e) {
      log(`run failed: ${e.message}`);
    }
    if (LOOP_SECONDS > 0) await new Promise((r) => setTimeout(r, LOOP_SECONDS * 1000));
  } while (LOOP_SECONDS > 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
