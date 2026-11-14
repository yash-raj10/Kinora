// Usage:
//   node scripts/create-market.mjs <movie_id> <threshold_usd> <closes> <resolves> [--contract ID]
// <closes> and <resolves> are either minutes from now ("45m") or an ISO date ("2026-11-27").
// Creates an Over/Under market on a movie's worldwide gross. Only the contract owner can create markets.
import { execFileSync } from 'node:child_process';

const [movieId, threshold, closesArg, resolvesArg, ...rest] = process.argv.slice(2);
if (!movieId || !threshold || !closesArg || !resolvesArg) {
  console.error('Usage: node scripts/create-market.mjs <movie_id> <threshold_usd> <closes> <resolves> [--contract ID]');
  process.exit(1);
}
const ci = rest.indexOf('--contract');
const CONTRACT = ci >= 0 ? rest[ci + 1] : (process.env.KINORA_CONTRACT ?? 'reelcall-yash-1113.testnet');

function toMs(arg) {
  if (/^\d+m$/.test(arg)) return Date.now() + Number(arg.slice(0, -1)) * 60_000;
  const t = Date.parse(arg);
  if (Number.isNaN(t)) throw new Error(`Cannot read time "${arg}"`);
  return t;
}

const payload = {
  movie_id: Number(movieId),
  metric: 'Worldwide gross (USD, TMDB)',
  threshold: String(Math.round(Number(threshold))),
  closes_at_ms: String(toMs(closesArg)),
  resolves_at_ms: String(toMs(resolvesArg)),
};
if (Number(payload.closes_at_ms) > Number(payload.resolves_at_ms)) {
  console.error('Betting must close before the market resolves.');
  process.exit(1);
}

execFileSync(
  'near',
  [
    'contract', 'call-function', 'as-transaction', CONTRACT, 'create_market',
    'json-args', JSON.stringify(payload),
    'prepaid-gas', '30 Tgas', 'attached-deposit', '0 NEAR',
    'sign-as', CONTRACT, 'network-config', 'testnet', 'sign-with-keychain', 'send',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
console.log(`created market on movie #${movieId}: over $${Number(threshold).toLocaleString()}`);
console.log(`  betting closes ${new Date(Number(payload.closes_at_ms)).toISOString()}`);
console.log(`  resolves from  ${new Date(Number(payload.resolves_at_ms)).toISOString()}`);
