'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { marketQuestion, marketSides } from '@/components/market';
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

  const titles = Object.fromEntries(Object.values(movies).map((m) => [m.id, m.title]));

  return (
    <main className="container">
      <section className="hero">
        <h1>Box office calls</h1>
        <p>
          Two kinds of call on the US box office. Pick Over or Under on a movie&apos;s gross, or pick which of two new
          releases earns more. Winners split the losing side&apos;s pool by stake. A data agent posts OMDb readings with
          evidence, and anyone can settle a market once its time comes.
        </p>
      </section>

      {error && <p className="error">{error}</p>}
      {!markets && !error && <p className="empty">Loading markets...</p>}
      {markets && markets.length === 0 && <p className="empty">No markets yet.</p>}

      <section style={{ paddingBottom: 72 }}>
        {markets?.map((m) => {
          const a = movies[m.movie_id];
          const b = m.movie_b !== null ? movies[m.movie_b] : undefined;
          const sides = marketSides(m, titles);
          const posters = [a, b].filter(Boolean) as Movie[];
          return (
            <Link key={m.id} href={`/movie/${m.movie_id}`} className="market-row">
              <div className="thumbs">
                {posters.length === 0 && <div className="thumb" />}
                {posters.map((p) =>
                  p.poster_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={p.id} src={p.poster_url} alt="" loading="lazy" />
                  ) : (
                    <div key={p.id} className="thumb" />
                  ),
                )}
              </div>
              <div>
                <h3>{marketQuestion(m, titles)}</h3>
                <p className="note">
                  {m.state === 'open' ? `Betting open until ${shortDate(m.closes_at_ms)}.` : `${STATE_LABEL[m.state]}.`}{' '}
                  {m.state === 'resolved' &&
                    m.outcome !== null &&
                    (m.kind === 1
                      ? `${sides[m.outcome]} earned more, ${formatUsd(m.resolved_value ?? 0)} against ${formatUsd(m.resolved_value_b ?? 0)}.`
                      : `${sides[m.outcome]} won at ${formatUsd(m.resolved_value ?? 0)}.`)}
                </p>
                <p className="note">
                  {sides[1]} {formatNear(m.pools[1])} NEAR from {m.counts[1]} {m.counts[1] === 1 ? 'bet' : 'bets'}.{' '}
                  {sides[0]} {formatNear(m.pools[0])} NEAR from {m.counts[0]} {m.counts[0] === 1 ? 'bet' : 'bets'}.
                </p>
              </div>
            </Link>
          );
        })}
      </section>
    </main>
  );
}
