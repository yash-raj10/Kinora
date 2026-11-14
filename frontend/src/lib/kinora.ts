export const BUCKETS = [
  { id: 0, name: 'Skip', fill: 'var(--skip)', text: 'var(--skip-ink)' },
  { id: 1, name: 'Timepass', fill: 'var(--timepass)', text: 'var(--timepass-ink)' },
  { id: 2, name: 'Go for it', fill: 'var(--goforit)', text: 'var(--goforit-ink)' },
  { id: 3, name: 'Perfection', fill: 'var(--perfection)', text: 'var(--perfection-ink)' },
] as const;

export type Movie = {
  id: number;
  tmdb_id: number;
  title: string;
  poster_url: string;
  release_ts_ms: string;
  vote_end_ts_ms: string;
};

export type Meter = {
  counts: number[];
  stakes: string[];
  stake_pct: number[];
  weights: string[];
  weight_pct: number[];
  total_votes: number;
  total_stake: string;
  headline_bucket: number | null;
  headline_pct: number;
};

export type MovieCard = {
  movie: Movie;
  meter: Meter;
  final_bucket: number | null;
};

export type Vote = {
  bucket: number;
  stake: string;
  ts_ms: string;
  claimed: boolean;
};

export type Taste = {
  calls: number;
  matched: number;
  score: number;
};

export type LeaderRow = Taste & { account_id: string };

export const CRITIC_SCORE = 30;

export type Config = {
  owner: string;
  min_stake: string;
  movie_count: number;
  slash_bps: number;
  level_step: number;
  resolver: string;
  market_count: number;
};

export type Profile = {
  calls: number;
  matched: number;
  score: number;
  level: number;
  weight: number;
  next_level_in: number | null;
};

export type ClaimPreview = {
  state: 'pending' | 'won' | 'lost';
  payout: string;
  claimed: boolean;
};

export type MarketView = {
  id: number;
  movie_id: number;
  metric: string;
  threshold: string;
  closes_at_ms: string;
  resolves_at_ms: string;
  pools: string[];
  counts: number[];
  over_pct: number;
  state: 'open' | 'closed' | 'resolved' | 'void';
  outcome: number | null;
  resolved_value: string | null;
};

export type Bet = { side: number; stake: string; claimed: boolean };

export type DataPoint = {
  value: string;
  source: string;
  source_url: string;
  evidence_hash: string;
  fetched_at_ms: string;
  posted_at_ms: string;
  poster: string;
};

export type MarketClaimPreview = {
  state: 'pending' | 'won' | 'lost' | 'void';
  payout: string;
  claimed: boolean;
};

export function formatUsd(value: string | number): string {
  const n = Number(value);
  if (n >= 1e9) return `$${parseFloat((n / 1e9).toFixed(2))}B`;
  if (n >= 1e6) return `$${parseFloat((n / 1e6).toFixed(1))}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

export const FINALIZE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function weightLabel(weight: number): string {
  return `${weight / 100}x`;
}

export type MovieMeta = {
  year: number | null;
  runtime: number | null;
  language: string;
  tagline: string;
  overview: string;
  genres: string[];
  backdrop: string;
  director: string;
  cast: { name: string; role: string }[];
};

let metaCache: Promise<Record<string, MovieMeta>> | null = null;

export function loadMeta(): Promise<Record<string, MovieMeta>> {
  metaCache ??= fetch('/movies-meta.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return metaCache;
}

const YOCTO_PER_NEAR = BigInt('1000000000000000000000000');

export function formatNear(yocto: string, digits = 2): string {
  const value = BigInt(yocto);
  const whole = value / YOCTO_PER_NEAR;
  const frac = (value % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, digits);
  return digits > 0 ? `${whole}.${frac}` : `${whole}`;
}

export function votingState(movie: Movie, nowMs = Date.now()): 'open' | 'closed' {
  return nowMs < Number(movie.vote_end_ts_ms) ? 'open' : 'closed';
}

export function shortDate(ms: string): string {
  return new Date(Number(ms)).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function runtimeLabel(minutes: number | null): string {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// Weights favour the first-listed genres; they sum to exactly 100.
export function vibeMix(genres: string[]): { name: string; pct: number }[] {
  const picked = genres.slice(0, 4);
  if (picked.length === 0) return [];
  const weights = [5, 4, 3, 2].slice(0, picked.length);
  const total = weights.reduce((a, b) => a + b, 0);
  const pcts = weights.map((w) => Math.round((w / total) * 100));
  pcts[pcts.length - 1] += 100 - pcts.reduce((a, b) => a + b, 0);
  return picked.map((name, i) => ({ name, pct: pcts[i] }));
}
