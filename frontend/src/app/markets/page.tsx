'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { KinoraContract } from '@/config';
import { formatNear, formatUsd, shortDate, type MarketView, type Movie } from '@/lib/kinora';
import { useNearWallet } from '@/providers/near-provider';

const STATE_LABEL: Record<MarketView['state'], string> = {
  open: 'Betting open',
  closed: 'Closed, awaiting data',
  resolved: 'Resolved',
  void: 'Void, stakes refunded',
};

export default function Markets() {
  const { viewFunction } = useNearWallet();
  const [markets, setMarkets] = useState<MarketView[] | null>(null);
  const [movies, setMovies] = useState<Record<number, Movie>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ms, mv] = await Promise.all([
          viewFunction({ contractId: KinoraContract, method: 'get_markets', args: { limit: 100 } }) as Promise<MarketView[]>,
          viewFunction({ contractId: KinoraContract, method: 'get_movies', args: { limit: 100 } }) as Promise<Movie[]>,
        ]);
        if (cancelled) return;
        setMovies(Object.fromEntries(mv.map((m) => [m.id, m])));
        setMarkets(ms);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to load markets');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewFunction]);

  return (
    <main className="container">
      <section className="hero">
        <h1>Box office calls</h1>
        <p>
          Back Over or Under on a movie&apos;s worldwide gross. Winners split the losing side&apos;s pool in proportion to
          their stake. A data agent posts readings with evidence, and anyone can settle a market once its time comes.
        </p>
      </section>

      {error && <p className="error">{error}</p>}
      {!markets && !error && <p className="empty">Loading markets...</p>}
      {markets && markets.length === 0 && <p className="empty">No markets yet.</p>}

      <section style={{ paddingBottom: 72 }}>
        {markets?.map((m) => {
          const movie = movies[m.movie_id];
          return (
            <Link key={m.id} href={`/movie/${m.movie_id}`} className="market-row">
              {movie?.poster_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={movie.poster_url} alt="" loading="lazy" />
              ) : (
                <div className="thumb" />
              )}
              <div>
                <h3>
                  {movie?.title ?? `Movie #${m.movie_id}`} over {formatUsd(m.threshold)} worldwide
                </h3>
                <p className="note">
                  {m.state === 'open' ? `Betting open until ${shortDate(m.closes_at_ms)}.` : `${STATE_LABEL[m.state]}.`}{' '}
                  {m.state === 'resolved' &&
                    `${m.outcome === 1 ? 'Over' : 'Under'} won at ${formatUsd(m.resolved_value ?? 0)}.`}
                </p>
                <p className="note">
                  Over {formatNear(m.pools[1])} NEAR from {m.counts[1]} {m.counts[1] === 1 ? 'bet' : 'bets'}. Under{' '}
                  {formatNear(m.pools[0])} NEAR from {m.counts[0]} {m.counts[0] === 1 ? 'bet' : 'bets'}.
                </p>
              </div>
            </Link>
          );
        })}
      </section>
    </main>
  );
}
