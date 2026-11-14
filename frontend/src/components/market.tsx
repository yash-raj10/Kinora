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

const LEDGER_NOTE = 'US domestic gross from OMDb';

export function marketSides(market: MarketView, titles: Record<number, string>): string[] {
  if (market.kind === 1) {
    return [titles[market.movie_id] ?? `Movie #${market.movie_id}`, titles[market.movie_b ?? -1] ?? `Movie #${market.movie_b}`];
  }
  return ['Under', 'Over'];
}

export function marketQuestion(market: MarketView, titles: Record<number, string>): string {
  const [a, b] = marketSides(market, titles);
  return market.kind === 1
    ? `Which earns more at the US box office: ${a} or ${b}?`
    : `Will ${titles[market.movie_id] ?? `Movie #${market.movie_id}`} gross more than ${formatUsd(market.threshold)} at the US box office?`;
}

export function MarketCard({
  market,
  titles,
  config,
  onChanged,
}: {
  market: MarketView;
  titles: Record<number, string>;
  config: Config | null;
  onChanged: () => void;
}) {
  const { signedAccountId, viewFunction, callFunction, signIn } = useNearWallet();
  const duel = market.kind === 1;
  const sides = marketSides(market, titles);
  const sideColors = duel ? ['var(--perfection)', 'var(--goforit)'] : ['var(--timepass)', 'var(--goforit)'];

  const [pointsA, setPointsA] = useState<DataPoint[]>([]);
  const [pointsB, setPointsB] = useState<DataPoint[]>([]);
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
      const get = (movie_id: number) =>
        viewFunction({ contractId: KinoraContract, method: 'get_data_points', args: { movie_id } }) as Promise<DataPoint[]>;
      setPointsA(await get(market.movie_id));
      setPointsB(market.movie_b !== null ? await get(market.movie_b) : []);
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
  }, [viewFunction, signedAccountId, market.id, market.movie_id, market.movie_b]);

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
    if (side === null) return setError('Pick a side first.');
    if (!/^\d+(\.\d{1,24})?$/.test(amount.trim())) return setError('Enter a valid NEAR amount.');
    const yocto = nearToYocto(amount.trim() as `${number}`).toString();
    if (config && BigInt(yocto) < BigInt(config.min_stake)) {
      return setError(`Minimum stake is ${formatNear(config.min_stake)} NEAR.`);
    }
    void act('bet', { market_id: market.id, side }, 'Bet placed. Payouts open once the market resolves.', yocto);
  };

  const threshold = Number(market.threshold);
  const latestA = pointsA[pointsA.length - 1];
  const latestB = pointsB[pointsB.length - 1];
  const progress = latestA ? Math.min(100, Math.round((Number(latestA.value) / threshold) * 100)) : 0;
  const resolvesAt = Number(market.resolves_at_ms);
  const resolveDue = nowMs >= resolvesAt;
  const fresh = (pts: DataPoint[]) => pts.some((p) => Number(p.posted_at_ms) >= resolvesAt);
  const canResolve = market.state === 'closed' && resolveDue && fresh(pointsA) && (!duel || fresh(pointsB));
  const totalPool = BigInt(market.pools[0]) + BigInt(market.pools[1]);

  const valueA = latestA ? Number(latestA.value) : 0;
  const valueB = latestB ? Number(latestB.value) : 0;
  const shareA = valueA + valueB === 0 ? 50 : Math.round((valueA / (valueA + valueB)) * 100);

  const resolvedText = () => {
    if (market.outcome === null) return '';
    if (!duel) return `Resolved ${sides[market.outcome]} at ${formatUsd(market.resolved_value ?? 0)}.`;
    return `Resolved: ${sides[market.outcome]} earned more, ${formatUsd(market.resolved_value ?? 0)} against ${formatUsd(market.resolved_value_b ?? 0)}.`;
  };

  const recent = (pts: DataPoint[], who?: string) =>
    pts.slice(-3).reverse().map((p) => (
      <li key={`${who ?? ''}${p.posted_at_ms}`}>
        {who && <span className="who">{who}</span>}
        <span>{shortDate(p.posted_at_ms)}</span>
        <b>{formatUsd(p.value)}</b>
        <a href={p.source_url} target="_blank" rel="noreferrer">{p.source}</a>
        <span className="hash" title={`SHA-256 of the raw response: ${p.evidence_hash}`}>
          evidence {p.evidence_hash.slice(0, 10)}
        </span>
      </li>
    ));

  return (
    <article className="market">
      <h3 className="market-q">{marketQuestion(market, titles)}</h3>
      <p className="note">
        {market.state === 'open' &&
          `Betting closes ${shortDate(market.closes_at_ms)}. Decided by the first reading posted on or after ${shortDate(market.resolves_at_ms)}. ${LEDGER_NOTE}.`}
        {market.state === 'closed' &&
          (resolveDue
            ? 'Betting is closed. Waiting for a fresh reading to settle it.'
            : `Betting is closed. Decided by the first reading posted on or after ${shortDate(market.resolves_at_ms)}.`)}
        {market.state === 'resolved' && resolvedText()}
        {market.state === 'void' &&
          `Void: ${duel ? 'a tie, ' : ''}nobody backed the winning side or no data arrived, so every stake is refunded.`}
      </p>

      <div className="pool">
        <div className="pool-bar" aria-hidden>
          <span style={{ width: `${market.over_pct}%`, background: sideColors[1] }} />
          <span style={{ width: `${totalPool === BigInt(0) ? 0 : 100 - market.over_pct}%`, background: sideColors[0] }} />
        </div>
        <div className="pool-labels">
          {[1, 0].map((i) => (
            <span key={i}>
              <b>{sides[i]}</b> {formatNear(market.pools[i])} NEAR, {market.counts[i]} {market.counts[i] === 1 ? 'bet' : 'bets'}
            </span>
          ))}
        </div>
      </div>

      <div className="reading">
        {!duel && (
          latestA ? (
            <>
              <div className="progress" role="img" aria-label={`${progress}% of the threshold`}>
                <span style={{ width: `${progress}%` }} />
              </div>
              <p className="reading-line">
                Latest reading <b>{formatUsd(latestA.value)}</b>, {progress}% of the way to {formatUsd(threshold)}.
              </p>
            </>
          ) : (
            <p className="note">No reading yet. The data agent posts one on a schedule.</p>
          )
        )}
        {duel && (
          latestA && latestB ? (
            <>
              <div className="pool-bar" role="img" aria-label={`${sides[0]} ${shareA}%, ${sides[1]} ${100 - shareA}%`}>
                <span style={{ width: `${shareA}%`, background: sideColors[0] }} />
                <span style={{ width: `${100 - shareA}%`, background: sideColors[1] }} />
              </div>
              <p className="reading-line">
                Latest readings: <b>{sides[0]}</b> {formatUsd(valueA)} against <b>{sides[1]}</b> {formatUsd(valueB)}.{' '}
                {valueA === valueB ? 'Level.' : `${valueA > valueB ? sides[0] : sides[1]} leads by ${formatUsd(Math.abs(valueA - valueB))}.`}
              </p>
            </>
          ) : (
            <p className="note">Waiting for readings on both movies. The data agent posts them on a schedule.</p>
          )
        )}
        {(pointsA.length > 0 || pointsB.length > 0) && (
          <ul className="readings">
            {recent(pointsA, duel ? sides[0] : undefined)}
            {duel && recent(pointsB, sides[1])}
          </ul>
        )}
      </div>

      <div className="market-actions">
        {market.state === 'open' && !bet && (
          signedAccountId ? (
            <>
              <div className="bucket-picker" role="group" aria-label="Pick a side">
                {sides.map((label, i) => (
                  <button
                    key={label}
                    className="bucket-btn"
                    style={{ ['--c' as string]: sideColors[i] }}
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
            You bet <b>{sides[bet.side]}</b> with {formatNear(bet.stake)} NEAR.
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
