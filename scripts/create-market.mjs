// Usage:
//   node scripts/create-market.mjs ladder <movie_id> <threshold_usd> <closes> <resolves> [--contract ID] [--dry-run]
//   node scripts/create-market.mjs duel   <movie_a> <movie_b> <closes> <resolves> [--contract ID] [--dry-run]
// <closes> and <resolves> are either minutes from now ("45m") or an ISO date ("2026-11-27").
// ladder: Over/Under on one movie's US domestic gross. duel: which of two movies has the higher gross.
// Only the contract owner can create markets. --dry-run prints the call and exits without sending it.
import { execFileSync } from 'node:child_process';

const METRIC = 'US domestic gross (USD, OMDb)';
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a === '--dry-run'));
const ci = argv.indexOf('--contract');
const CONTRACT = ci >= 0 ? argv[ci + 1] : (process.env.KINORA_CONTRACT ?? 'kinora-yash-1114.testnet');
const positional = argv.filter((a, i) => !a.startsWith('--') && !(ci >= 0 && i === ci + 1));
const [kind, a, b, closesArg, resolvesArg] = positional;
const DRY = flags.has('--dry-run');

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage:');
  console.error('  node scripts/create-market.mjs ladder <movie_id> <threshold_usd> <closes> <resolves> [--contract ID] [--dry-run]');
  console.error('  node scripts/create-market.mjs duel <movie_a> <movie_b> <closes> <resolves> [--contract ID] [--dry-run]');
  process.exit(1);
}

function toMs(arg) {
  if (/^\d+m$/.test(arg)) return Date.now() + Number(arg.slice(0, -1)) * 60_000;
  const t = Date.parse(arg);
  if (Number.isNaN(t)) usage(`Cannot read time "${arg}"`);
  return t;
}

if (!['ladder', 'duel'].includes(kind) || !a || !b || !closesArg || !resolvesArg) usage();

const closes = toMs(closesArg);
const resolves = toMs(resolvesArg);
if (closes > resolves) usage('Betting must close before the market resolves.');

let method;
let payload;
if (kind === 'ladder') {
  if (!(Number(b) > 0)) usage('Threshold must be a positive number of dollars.');
  method = 'create_market';
  payload = {
    movie_id: Number(a),
    metric: METRIC,
    threshold: String(Math.round(Number(b))),
    closes_at_ms: String(closes),
    resolves_at_ms: String(resolves),
  };
} else {
  if (a === b) usage('A duel needs two different movies.');
  method = 'create_duel';
  payload = {
    movie_a: Number(a),
    movie_b: Number(b),
    metric: METRIC,
    closes_at_ms: String(closes),
    resolves_at_ms: String(resolves),
  };
}

console.log(`${DRY ? 'dry-run: ' : ''}${method} on ${CONTRACT}`);
console.log(JSON.stringify(payload, null, 2));
console.log(`  betting closes ${new Date(closes).toISOString()}`);
console.log(`  resolves from  ${new Date(resolves).toISOString()}`);
if (DRY) process.exit(0);

execFileSync(
  'near',
  [
    'contract', 'call-function', 'as-transaction', CONTRACT, method,
    'json-args', JSON.stringify(payload),
    'prepaid-gas', '30 Tgas', 'attached-deposit', '0 NEAR',
    'sign-as', CONTRACT, 'network-config', 'testnet', 'sign-with-keychain', 'send',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
console.log('created.');
