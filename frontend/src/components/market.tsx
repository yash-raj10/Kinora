'use client';

import { nearToYocto } from 'near-api-js';
import { useCallback, useEffect, useState } from 'react';

import { KinoraContract } from '@/config';
import {
  formatNear,
  formatUsd,
  shortDate,
  type Bet,
  type Config,
  type DataPoint,
  type MarketClaimPreview,
  type MarketView,
} from '@/lib/kinora';
import { useNearWallet } from '@/providers/near-provider';

const SIDES = ['Under', 'Over'] as const;
const SIDE_COLORS = ['var(--timepass)', 'var(--goforit)'] as const;

export function MarketCard({
  market,
  movieTitle,
  config,
  onChanged,
}: {
  market: MarketView;
  movieTitle: string;
  config: Config | null;
  onChanged: () => void;
}) {
  const { signedAccountId, viewFunction, callFunction, signIn } = useNearWallet();
  const [points, setPoints] = useState<DataPoint[]>([]);
  const [bet, setBet] = useState<Bet | null>(null);
  const [preview, setPreview] = useState<MarketClaimPreview | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [side, setSide] = useState<number | null>(null);
  const [amount, setAmount] = useState('0.1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setNowMs(Date.now());
    try {
      setPoints(
        (await viewFunction({
          contractId: KinoraContract,
          method: 'get_data_points',
          args: { movie_id: market.movie_id },
        })) as DataPoint[],
      );
      if (signedAccountId) {
        const args = { market_id: market.id, account_id: signedAccountId };
        setBet((await viewFunction({ contractId: KinoraContract, method: 'get_bet', args })) as Bet | null);
        setPreview(
          (await viewFunction({
            contractId: KinoraContract,
            method: 'preview_market_claim',
            args,
          })) as MarketClaimPreview | null,
        );
      } else {
        setBet(null);
        setPreview(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load market data');
    }
  }, [viewFunction, signedAccountId, market.id, market.movie_id]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load, market.state]);

  const act = async (method: string, args: Record<string, unknown>, done: string, deposit?: string) => {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await callFunction({ contractId: KinoraContract, method, args, deposit });
      setMessage(done);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${method} failed`);
    } finally {
      setBusy(false);
    }
  };

  const placeBet = () => {
    setError('');
    setMessage('');
    if (side === null) return setError('Pick Over or Under first.');
    if (!/^\d+(\.\d{1,24})?$/.test(amount.trim())) return setError('Enter a valid NEAR amount.');
    const yocto = nearToYocto(amount.trim() as `${number}`).toString();
    if (config && BigInt(yocto) < BigInt(config.min_stake)) {
      return setError(`Minimum stake is ${formatNear(config.min_stake)} NEAR.`);
    }
    void act('bet', { market_id: market.id, side }, 'Bet placed. Payouts open once the market resolves.', yocto);
  };

  const threshold = Number(market.threshold);
  const latest = points[points.length - 1];
  const latestValue = latest ? Number(latest.value) : null;
  const progress = latestValue === null ? 0 : Math.min(100, Math.round((latestValue / threshold) * 100));
  const resolveDue = nowMs >= Number(market.resolves_at_ms);
  const canResolve =
    market.state === 'closed' && resolveDue && points.some((p) => Number(p.posted_at_ms) >= Number(market.resolves_at_ms));
  const totalPool = BigInt(market.pools[0]) + BigInt(market.pools[1]);

  return (
    <article className="market">
      <h3 className="market-q">
        Will {movieTitle} gross more than {formatUsd(threshold)} worldwide?
      </h3>
      <p className="note">
        {market.state === 'open' && `Betting closes ${shortDate(market.closes_at_ms)}. Decided by the first reading posted on or after ${shortDate(market.resolves_at_ms)}.`}
        {market.state === 'closed' && (resolveDue ? 'Betting is closed. Waiting for a fresh reading to settle it.' : `Betting is closed. Decided by the first reading posted on or after ${shortDate(market.resolves_at_ms)}.`)}
        {market.state === 'resolved' &&
          `Resolved ${SIDES[market.outcome ?? 0]} at ${formatUsd(market.resolved_value ?? 0)}.`}
        {market.state === 'void' && 'Void: nobody backed the winning side or no data arrived, so every stake is refunded.'}
      </p>

      <div className="pool">
        <div className="pool-bar" aria-hidden>
          <span style={{ width: `${market.over_pct}%`, background: SIDE_COLORS[1] }} />
          <span style={{ width: `${totalPool === BigInt(0) ? 0 : 100 - market.over_pct}%`, background: SIDE_COLORS[0] }} />
        </div>
        <div className="pool-labels">
          <span>
            <b>Over</b> {formatNear(market.pools[1])} NEAR, {market.counts[1]} {market.counts[1] === 1 ? 'bet' : 'bets'}
          </span>
          <span>
            <b>Under</b> {formatNear(market.pools[0])} NEAR, {market.counts[0]} {market.counts[0] === 1 ? 'bet' : 'bets'}
          </span>
        </div>
      </div>

      <div className="reading">
        {latest ? (
          <>
            <div className="progress" role="img" aria-label={`${progress}% of the threshold`}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <p className="reading-line">
              Latest reading <b>{formatUsd(latest.value)}</b>, {progress}% of the way to {formatUsd(threshold)}.
            </p>
          </>
        ) : (
          <p className="note">No reading yet. The data agent posts one on a schedule.</p>
        )}
        {points.length > 0 && (
          <ul className="readings">
            {points.slice(-4).reverse().map((p) => (
              <li key={p.posted_at_ms}>
                <span>{shortDate(p.posted_at_ms)}</span>
                <b>{formatUsd(p.value)}</b>
                <a href={p.source_url} target="_blank" rel="noreferrer">{p.source}</a>
                <span className="hash" title={`SHA-256 of the raw response: ${p.evidence_hash}`}>
                  evidence {p.evidence_hash.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="market-actions">
        {market.state === 'open' && !bet && (
          signedAccountId ? (
            <>
              <div className="bucket-picker" role="group" aria-label="Pick a side">
                {SIDES.map((label, i) => (
                  <button
                    key={label}
                    className="bucket-btn"
                    style={{ ['--c' as string]: SIDE_COLORS[i] }}
                    aria-pressed={side === i}
                    onClick={() => setSide(i)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="field">
                <span>Stake in NEAR</span>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <button className="btn btn-primary" disabled={busy} onClick={placeBet}>
                {busy ? 'Waiting for wallet...' : 'Place bet'}
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => void signIn()}>Connect wallet to bet</button>
          )
        )}

        {bet && (
          <p>
            You bet <b>{SIDES[bet.side]}</b> with {formatNear(bet.stake)} NEAR.
          </p>
        )}
        {bet && preview?.state === 'won' && (
          <p className="success">You called it. You get {formatNear(preview.payout, 4)} NEAR.</p>
        )}
        {bet && preview?.state === 'lost' && <p className="note">Your side lost, so there is nothing to claim.</p>}
        {bet && preview?.state === 'void' && (
          <p className="note">Market void. Your {formatNear(preview.payout, 4)} NEAR stake is refunded.</p>
        )}
        {bet && !bet.claimed && (preview?.state === 'won' || preview?.state === 'void') && (
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => act('claim_market', { market_id: market.id }, 'Payout sent to your wallet.')}
          >
            Claim payout
          </button>
        )}
        {bet?.claimed && <p className="success">Payout claimed.</p>}

        {canResolve && (
          <button
            className="btn"
            disabled={busy || !signedAccountId}
            onClick={() => act('resolve_market', { market_id: market.id }, 'Market resolved.')}
          >
            {signedAccountId ? 'Resolve market' : 'Connect a wallet to resolve'}
          </button>
        )}

        {error && <p className="error">{error}</p>}
        {message && <p className="success">{message}</p>}
      </div>
    </article>
  );
}
