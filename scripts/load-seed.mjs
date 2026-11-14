// Usage: node scripts/load-seed.mjs <contract-account>
// Syncs scripts/seed.json to the contract: movies already on-chain are updated in place
// (their voting window is kept), the rest are appended. Position in seed.json = movie id.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const account = process.argv[2];
if (!account) {
  console.error('Usage: node scripts/load-seed.mjs <contract-account>');
  process.exit(1);
}

const seed = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'seed.json'), 'utf8'));

function near(args, opts = {}) {
  return execFileSync('near', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}

function view(method, args) {
  const out = near([
    'contract', 'call-function', 'as-read-only', account, method,
    'json-args', JSON.stringify(args), 'network-config', 'testnet', 'now',
  ]);
  const start = out.search(/[\[{]/);
  return JSON.parse(out.slice(start, out.lastIndexOf('}') + 1));
}

function send(method, args) {
  near([
    'contract', 'call-function', 'as-transaction', account, method,
    'json-args', JSON.stringify(args),
    'prepaid-gas', '30 Tgas', 'attached-deposit', '0 NEAR',
    'sign-as', account, 'network-config', 'testnet', 'sign-with-keychain', 'send',
  ]);
}

const count = view('get_config', {}).movie_count;
console.log(`on-chain movies: ${count}, seed movies: ${seed.length}`);

for (const [i, movie] of seed.entries()) {
  if (i < count) {
    const existing = view('get_movie', { movie_id: i });
    send('update_movie', { movie_id: i, ...movie, vote_end_ts_ms: existing.vote_end_ts_ms });
    console.log(`updated #${i} ${movie.title}`);
  } else {
    send('add_movie', movie);
    console.log(`added   #${i} ${movie.title}`);
  }
}
