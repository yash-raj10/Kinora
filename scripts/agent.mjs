// Kinora box-office data agent.
// For every market that still needs data it fetches the movie's worldwide gross from TMDB, posts the
// reading on-chain with a hash of the raw response as evidence, and resolves markets whose time has come.
//
// Usage:
//   TMDB_API_KEY=xxxx node scripts/agent.mjs [--contract ID] [--signer ID] [--dry-run] [--force] [--loop SECONDS]
// The signer must be the contract's resolver (or owner) and have its key in the near CLI keychain.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CONTRACT = opt('contract', process.env.KINORA_CONTRACT ?? 'reelcall-yash-1113.testnet');
const SIGNER = opt('signer', process.env.KINORA_SIGNER ?? CONTRACT);
const RPC = process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com';
const DRY = flag('dry-run');
const FORCE = flag('force');
const LOOP_SECONDS = Number(opt('loop', '0'));
const TMDB_KEY = process.env.TMDB_API_KEY;
const SAME_VALUE_COOLDOWN_MS = 24 * 3600 * 1000;

if (!TMDB_KEY) {
  console.error('Set TMDB_API_KEY (free v3 key from themoviedb.org).');
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
      'sign-as', SIGNER, 'network-config', 'testnet', 'sign-with-keychain', 'send',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

async function readTmdb(tmdbId) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} for movie ${tmdbId}`);
  const raw = await res.text();
  const data = JSON.parse(raw);
  return {
    value: Number(data.revenue) || 0,
    title: data.title,
    // The key is not part of the hash input: hash only the response body.
    evidenceHash: createHash('sha256').update(raw).digest('hex'),
    sourceUrl: `https://www.themoviedb.org/movie/${tmdbId}`,
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
  const movieIds = [...new Set(live.map((m) => m.movie_id))];

  for (const movieId of movieIds) {
    try {
      const movie = await view('get_movie', { movie_id: movieId });
      const points = await view('get_data_points', { movie_id: movieId });
      const last = points[points.length - 1];
      const reading = await readTmdb(movie.tmdb_id);

      if (reading.value === 0 && !FORCE) {
        log(`#${movieId} ${movie.title}: TMDB reports no gross yet, skipping`);
      } else if (last && reading.value < Number(last.value) && !FORCE) {
        log(`#${movieId} ${movie.title}: gross fell from ${last.value} to ${reading.value}, refusing to post (use --force)`);
      } else if (
        last && Number(last.value) === reading.value && now - Number(last.posted_at_ms) < SAME_VALUE_COOLDOWN_MS && !FORCE
      ) {
        log(`#${movieId} ${movie.title}: unchanged at ${reading.value}, nothing new to post`);
      } else {
        send('post_data_point', {
          movie_id: movieId,
          value: String(reading.value),
          source: 'TMDB',
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

  // Close the loop: resolve any market whose time has come and that has a fresh reading.
  const fresh = await view('get_markets', { limit: 100 });
  for (const m of fresh.filter((x) => x.state === 'closed' && now >= Number(x.resolves_at_ms))) {
    const points = await view('get_data_points', { movie_id: m.movie_id });
    if (points.some((p) => Number(p.posted_at_ms) >= Number(m.resolves_at_ms))) {
      try {
        send('resolve_market', { market_id: m.id });
        log(`market #${m.id}: resolve_market submitted`);
      } catch (e) {
        log(`market #${m.id}: ${e.message}`);
      }
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
