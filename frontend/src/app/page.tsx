'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { StakeStacks } from '@/components/stacks';
import { KinoraContract } from '@/config';
import {
  BUCKETS,
  formatNear,
  loadMeta,
  runtimeLabel,
  shortDate,
  votingState,
  type MovieCard,
  type MovieMeta,
} from '@/lib/kinora';
import { useNearWallet } from '@/providers/near-provider';

type Filter = 'all' | 'open' | 'closed' | 'final';
type Sort = 'staked' | 'ending' | 'newest' | 'title';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Voting open' },
  { id: 'closed', label: 'Closed' },
  { id: 'final', label: 'Finalized' },
];

function statusOf(card: MovieCard): Exclude<Filter, 'all'> {
  if (card.final_bucket !== null) return 'final';
  return votingState(card.movie) === 'open' ? 'open' : 'closed';
}

function statusText(card: MovieCard): string {
  const s = statusOf(card);
  if (s === 'final') return `Final verdict: ${BUCKETS[card.final_bucket as number].name}`;
  if (s === 'open') return `Voting ends ${shortDate(card.movie.vote_end_ts_ms)}`;
  return 'Voting closed';
}

export default function Home() {
  const { viewFunction } = useNearWallet();
  const [cards, setCards] = useState<MovieCard[] | null>(null);
  const [meta, setMeta] = useState<Record<string, MovieMeta>>({});
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('staked');

  useEffect(() => {
    let cancelled = false;
    void loadMeta().then((m) => !cancelled && setMeta(m));
    (async () => {
      try {
        const data = (await viewFunction({
          contractId: KinoraContract,
          method: 'get_overview',
          args: { limit: 100 },
        })) as MovieCard[];
        if (!cancelled) setCards(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to load movies');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewFunction]);

  const featured = useMemo(() => {
    if (!cards?.length) return null;
    const open = cards.filter((c) => statusOf(c) === 'open');
    const pool = open.length ? open : cards;
    return pool.reduce((best, c) =>
      BigInt(c.meter.total_stake) > BigInt(best.meter.total_stake) ? c : best,
    );
  }, [cards]);

  const visible = useMemo(() => {
    if (!cards) return [];
    const q = query.trim().toLowerCase();
    const list = cards.filter(
      (c) => (filter === 'all' || statusOf(c) === filter) && (!q || c.movie.title.toLowerCase().includes(q)),
    );
    const staked = (c: MovieCard) => BigInt(c.meter.total_stake);
    return [...list].sort((a, b) => {
      if (sort === 'title') return a.movie.title.localeCompare(b.movie.title);
      if (sort === 'newest') return Number(b.movie.release_ts_ms) - Number(a.movie.release_ts_ms);
      if (sort === 'ending') return Number(a.movie.vote_end_ts_ms) - Number(b.movie.vote_end_ts_ms);
      return staked(a) === staked(b) ? a.movie.id - b.movie.id : staked(b) > staked(a) ? 1 : -1;
    });
  }, [cards, query, filter, sort]);

  const fm = featured ? meta[String(featured.movie.tmdb_id)] : undefined;

  return (
    <main>
      <section className="container intro">
        <h1>Ratings that cost something to fake.</h1>
        <p>
          Call a movie Skip, Timepass, Go for it or Perfection and back it with a refundable NEAR stake.
          Bigger stakes move the Meter more, so a crowd can&apos;t be faked for free.
        </p>
      </section>

      {featured && (
        <section
          className="feature"
          style={{ ['--bd' as string]: fm?.backdrop ? `url(${fm.backdrop})` : 'none' }}
          aria-label="Most staked movie"
        >
          <div className="container feature-inner">
            <div className="feature-copy">
              <p className="feature-kicker">Most staked right now</p>
              <h2>{featured.movie.title}</h2>
              <p className="feature-facts">
                {fm?.year && <span>{fm.year}</span>}
                {fm?.runtime && <span>{runtimeLabel(fm.runtime)}</span>}
                {fm?.genres.length ? <span>{fm.genres.slice(0, 3).join(', ')}</span> : null}
              </p>
              <p className="feature-total">
                {BigInt(featured.meter.total_stake) > BigInt(0)
                  ? `${formatNear(featured.meter.total_stake)} NEAR staked across ${featured.meter.total_votes} ${
                      featured.meter.total_votes === 1 ? 'vote' : 'votes'
                    }`
                  : 'No stakes yet. Be the first to call it.'}
              </p>
              <Link className="btn btn-light" href={`/movie/${featured.movie.id}`}>
                {statusOf(featured) === 'open' ? 'Make your call' : 'See the verdict'}
              </Link>
            </div>
            <div className="feature-stacks">
              <StakeStacks meter={featured.meter} compact />
            </div>
          </div>
        </section>
      )}

      <section className="container">
        <div className="toolbar">
          <input
            className="search"
            type="search"
            placeholder="Search movies"
            aria-label="Search movies"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="tabs" role="tablist" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                className="tab"
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <select
            className="select"
            aria-label="Sort movies"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            <option value="staked">Most staked</option>
            <option value="ending">Ending soon</option>
            <option value="newest">Newest release</option>
            <option value="title">Title A to Z</option>
          </select>
        </div>

        {error && <p className="error">{error}</p>}
        {!cards && !error && <p className="empty">Loading movies...</p>}
        {cards && visible.length === 0 && <p className="empty">No movies match. Clear the search or pick another filter.</p>}

        <div className="tiles">
          {visible.map((card) => {
            const { movie, meter } = card;
            const m = meta[String(movie.tmdb_id)];
            const head = meter.headline_bucket !== null ? BUCKETS[meter.headline_bucket] : null;
            return (
              <Link key={movie.id} href={`/movie/${movie.id}`} className="tile">
                <div className="tile-poster">
                  {movie.poster_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={movie.poster_url} alt="" loading="lazy" />
                  ) : (
                    <div className="poster-fallback">No poster</div>
                  )}
                  {head && (
                    <span className="tile-badge" style={{ background: head.fill }}>
                      <b>{meter.headline_pct}%</b> {head.name}
                    </span>
                  )}
                </div>
                <h3 className="tile-title">{movie.title}</h3>
                <p className="tile-sub">
                  {m?.year ?? ''} {m?.genres.length ? `  ${m.genres.slice(0, 2).join(', ')}` : ''}
                </p>
                <p className="tile-status">{statusText(card)}</p>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}
