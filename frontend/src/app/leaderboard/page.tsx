'use client';

import { useEffect, useState } from 'react';

import { KinoraContract } from '@/config';
import { CRITIC_SCORE, type LeaderRow, type Taste } from '@/lib/kinora';
import { useNearWallet } from '@/providers/near-provider';

export default function Leaderboard() {
  const { viewFunction, signedAccountId } = useNearWallet();
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [mine, setMine] = useState<Taste | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const board = (await viewFunction({
          contractId: KinoraContract,
          method: 'get_leaderboard',
          args: { limit: 50 },
        })) as LeaderRow[];
        const taste = signedAccountId
          ? ((await viewFunction({
              contractId: KinoraContract,
              method: 'get_taste',
              args: { account_id: signedAccountId },
            })) as Taste)
          : null;
        if (!cancelled) {
          setRows(board);
          setMine(taste);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to load leaderboard');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewFunction, signedAccountId]);

  return (
    <main className="container">
      <section className="hero">
        <h1>Taste leaderboard</h1>
        <p>
          Every vote counts toward your level. Your Taste Score grows when a vote matches the movie&apos;s final verdict. {CRITIC_SCORE}+ points earns the
          Critic badge.
        </p>
      </section>

      {mine && signedAccountId && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <h2>Your Taste Score</h2>
          <div className="headline">
            <b>{mine.score}</b>
            <span>
              {mine.matched} correct of {mine.calls} votes
              {mine.score >= CRITIC_SCORE ? ' · Critic' : ''}
            </span>
          </div>
        </section>
      )}

      {error && <p className="error">{error}</p>}
      {!rows && !error && <p className="empty">Loading...</p>}
      {rows && rows.length === 0 && (
        <p className="empty">No voters yet. Cast a vote and you will appear here.</p>
      )}

      {rows && rows.length > 0 && (
        <section className="panel" style={{ marginBottom: 48 }}>
          <table className="board">
            <thead>
              <tr>
                <th>#</th>
                <th>Account</th>
                <th>Score</th>
                <th>Correct</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.account_id} className={r.account_id === signedAccountId ? 'me' : undefined}>
                  <td>{i + 1}</td>
                  <td>
                    {r.account_id}
                    {r.score >= CRITIC_SCORE && <span className="pill pill-open" style={{ marginLeft: 8 }}>Critic</span>}
                  </td>
                  <td>{r.score}</td>
                  <td>
                    {r.matched}/{r.calls}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
