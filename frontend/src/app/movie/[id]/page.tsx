'use client';

import { nearToYocto } from 'near-api-js';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { MarketCard } from '@/components/market';
import { StakeStacks } from '@/components/stacks';
import { VibeChart } from '@/components/vibe';
import { KinoraContract } from '@/config';
import {
  BUCKETS,
  FINALIZE_GRACE_MS,
  formatNear,
  loadMeta,
  runtimeLabel,
  shortDate,
  votingState,
  weightLabel,
  type ClaimPreview,
  type Config,
  type Meter,
  type MarketView,
  type Movie,
  type MovieMeta,
  MAX_COMMENT_CHARS,
  type Comment,
  type Profile,
  type Vote,
} from '@/lib/kinora';
import { useNearWallet } from '@/providers/near-provider';

export default function MoviePage() {
  const { id } = useParams<{ id: string }>();
  const movieId = Number(id);
  const { signedAccountId, viewFunction, callFunction, signIn } = useNearWallet();

  const [movie, setMovie] = useState<Movie | null>(null);
  const [meta, setMeta] = useState<MovieMeta | null>(null);
  const [meter, setMeter] = useState<Meter | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [myVote, setMyVote] = useState<Vote | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [finalBucket, setFinalBucket] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [nowMs, setNowMs] = useState(0);

  const [bucket, setBucket] = useState<number | null>(null);
  const [amount, setAmount] = useState('0.1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    setNowMs(Date.now());
    try {
      const [m, mt, cfg, fin, allMarkets, allMovies] = await Promise.all([
        viewFunction({ contractId: KinoraContract, method: 'get_movie', args: { movie_id: movieId } }) as Promise<Movie | null>,
        viewFunction({ contractId: KinoraContract, method: 'get_meter', args: { movie_id: movieId } }) as Promise<Meter>,
        viewFunction({ contractId: KinoraContract, method: 'get_config' }) as Promise<Config>,
        viewFunction({ contractId: KinoraContract, method: 'get_final', args: { movie_id: movieId } }) as Promise<number | null>,
        viewFunction({ contractId: KinoraContract, method: 'get_markets', args: { limit: 100 } }) as Promise<MarketView[]>,
        viewFunction({ contractId: KinoraContract, method: 'get_movies', args: { limit: 100 } }) as Promise<Movie[]>,
      ]);
      setMarkets(allMarkets.filter((x) => x.movie_id === movieId || x.movie_b === movieId));
      setTitles(Object.fromEntries(allMovies.map((x) => [x.id, x.title])));
      setComments(
        (await viewFunction({
          contractId: KinoraContract,
          method: 'get_comments',
          args: { movie_id: movieId, limit: 30 },
        })) as Comment[],
      );
      setMovie(m);
      setMeter(mt);
      setConfig(cfg);
      setFinalBucket(fin);
      if (m) void loadMeta().then((all) => setMeta(all[String(m.tmdb_id)] ?? null));
      if (signedAccountId) {
        const args = { movie_id: movieId, account_id: signedAccountId };
        const [vote, isSettled, prof, prev] = await Promise.all([
          viewFunction({ contractId: KinoraContract, method: 'get_vote', args }) as Promise<Vote | null>,
          viewFunction({ contractId: KinoraContract, method: 'is_settled', args }) as Promise<boolean>,
          viewFunction({ contractId: KinoraContract, method: 'get_profile', args: { account_id: signedAccountId } }) as Promise<Profile>,
          viewFunction({ contractId: KinoraContract, method: 'preview_claim', args }) as Promise<ClaimPreview | null>,
        ]);
        setMyVote(vote);
        setSettled(isSettled);
        setProfile(prof);
        setPreview(prev);
      } else {
        setMyVote(null);
        setSettled(false);
        setProfile(null);
        setPreview(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load movie');
    } finally {
      setLoaded(true);
    }
  }, [viewFunction, movieId, signedAccountId]);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  const runAction = async (method: string, args: Record<string, unknown>, done: string, deposit?: string) => {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await callFunction({ contractId: KinoraContract, method, args, deposit });
      setMessage(done);
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : `${method} failed`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const postComment = async () => {
    const text = commentText.trim();
    if (!text) return setError('Write a comment first.');
    if ([...text].length > MAX_COMMENT_CHARS) return setError(`Comments can be up to ${MAX_COMMENT_CHARS} characters.`);
    if (await runAction('post_comment', { movie_id: movieId, text }, 'Comment posted.')) setCommentText('');
  };

  const submitVote = () => {
    setError('');
    setMessage('');
    if (bucket === null) return setError('Pick a bucket first.');
    if (!/^\d+(\.\d{1,24})?$/.test(amount.trim())) return setError('Enter a valid NEAR amount.');
    const yocto = nearToYocto(amount.trim() as `${number}`).toString();
    if (config && BigInt(yocto) < BigInt(config.min_stake)) {
      return setError(`Minimum stake is ${formatNear(config.min_stake)} NEAR.`);
    }
    void runAction(
      'vote',
      { movie_id: movieId, bucket },
      'Vote recorded. Claim your payout after voting closes and the verdict is final.',
      yocto,
    );
  };

  if (!loaded) return <main className="container"><p className="empty">Loading...</p></main>;
  if (!movie) {
    return (
      <main className="container">
        <p className="empty">Movie not found. <Link href="/">Back to all movies</Link></p>
        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  const open = votingState(movie, nowMs) === 'open';
  const head = meter && meter.headline_bucket !== null ? BUCKETS[meter.headline_bucket] : null;
  const slashPct = config ? config.slash_bps / 100 : 20;
  const graceOver = nowMs >= Number(movie.vote_end_ts_ms) + FINALIZE_GRACE_MS;
  const canClaim = finalBucket !== null || graceOver;
  const needsFinalize = !open && finalBucket === null && (meter?.total_votes ?? 0) > 0;

  return (
    <main>
      <header
        className="mhero"
        style={{ ['--bd' as string]: meta?.backdrop ? `url(${meta.backdrop})` : 'none' }}
      >
        <div className="container">
          <Link href="/" className="back">All movies</Link>
          <div className="mhero-row">
            {movie.poster_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="mposter" src={movie.poster_url} alt={`${movie.title} poster`} />
            ) : (
              <div className="mposter poster-fallback">No poster</div>
            )}
            <div className="mhero-copy">
              <h1>{movie.title}</h1>
              {meta?.tagline && <p className="tagline">{meta.tagline}</p>}
              <p className="facts">
                {meta?.year && <span>{meta.year}</span>}
                {meta?.runtime && <span>{runtimeLabel(meta.runtime)}</span>}
                {meta?.language && <span>{meta.language.toUpperCase()}</span>}
                {meta?.genres.length ? <span>{meta.genres.join(', ')}</span> : null}
              </p>
              <p className="status">
                {finalBucket !== null
                  ? `Final verdict: ${BUCKETS[finalBucket].name}`
                  : open
                    ? `Voting open until ${shortDate(movie.vote_end_ts_ms)}`
                    : 'Voting closed'}
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="container mbody">
        <div className="mmain">
          <section>
            <h2>The Meter</h2>
            <div className="verdict">
              {head ? (
                <>
                  <span className="verdict-num" style={{ color: head.text }}>{meter?.headline_pct}%</span>
                  <span className="verdict-text">
                    <b>{head.name}</b>
                    <br />
                    {meter?.total_votes} {meter?.total_votes === 1 ? 'vote' : 'votes'} with{' '}
                    {formatNear(meter?.total_stake ?? '0')} NEAR staked
                  </span>
                </>
              ) : (
                <span className="verdict-text">No votes yet. The first stake sets the Meter.</span>
              )}
            </div>
            <StakeStacks meter={meter} />
            <p className="note" style={{ marginTop: 12 }}>
              Column height is weighted votes: seasoned voters count more. Stake does not change a vote&apos;s weight.
            </p>
            {finalBucket !== null && (
              <p className="final-line">
                Final verdict locked in: <b style={{ color: BUCKETS[finalBucket].text }}>{BUCKETS[finalBucket].name}</b>
              </p>
            )}
            {needsFinalize && (
              <>
                <p className="final-line">Voting is closed. Anyone can lock in the verdict.</p>
                <button
                  className="btn"
                  disabled={busy || !signedAccountId}
                  onClick={() => runAction('finalize_meter', { movie_id: movieId }, 'Verdict locked in.')}
                >
                  {signedAccountId ? 'Finalize verdict' : 'Connect a wallet to finalize'}
                </button>
              </>
            )}
          </section>

          {markets.length > 0 && (
            <section>
              <h2>Box office call</h2>
              {markets.map((mk) => (
                <MarketCard
                  key={mk.id}
                  market={mk}
                  titles={titles}
                  config={config}
                  onChanged={() => void refresh()}
                />
              ))}
            </section>
          )}

          <section>
            <h2>Comments{comments.length > 0 ? ` (${comments.length})` : ''}</h2>
            {signedAccountId ? (
              <div className="comment-form">
                <textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="What did you think?"
                  rows={3}
                  aria-label="Your comment"
                />
                <div className="comment-bar">
                  <span className="note">{[...commentText].length}/{MAX_COMMENT_CHARS}</span>
                  <button className="btn btn-primary" disabled={busy} onClick={postComment}>
                    {busy
                      ? 'Waiting for wallet...'
                      : comments.some((c) => c.author === signedAccountId)
                        ? 'Update my comment'
                        : 'Post comment'}
                  </button>
                </div>
                <p className="note">
                  Comments are saved on the NEAR blockchain. Posting again replaces your earlier comment on this movie.
                </p>
              </div>
            ) : (
              <div className="comment-form">
                <p className="note">Connect a NEAR wallet to comment.</p>
                <button className="btn btn-primary" onClick={() => void signIn()}>Connect wallet</button>
              </div>
            )}
            {comments.length === 0 ? (
              <p className="empty">No comments yet. Be the first.</p>
            ) : (
              <div className="comments">
                {comments.map((c) => (
                  <article className="comment" key={c.author}>
                    <header>
                      <b>{c.author}</b>
                      <span>{shortDate(c.ts_ms)}</span>
                    </header>
                    <p>{c.text}</p>
                  </article>
                ))}
              </div>
            )}
          </section>

          {meta && (meta.overview || meta.cast.length > 0) && (
            <section>
              <h2>About</h2>
              {meta.overview && <p className="overview">{meta.overview}</p>}
              {meta.director && <p className="credit"><b>Director</b> {meta.director}</p>}
              {meta.cast.length > 0 && (
                <p className="credit"><b>Cast</b> {meta.cast.map((c) => c.name).join(', ')}</p>
              )}
            </section>
          )}
        </div>

        <div className="mside">
        <aside className="stub" aria-label="Your call">
          <div className="stub-head">
            <h2>Your call</h2>
            <p className="note">
              Right side: your stake back plus a share of the slashed pool. Wrong side: lose {slashPct}% of your stake.
              Minimum stake {config ? formatNear(config.min_stake) : '0.10'} NEAR.
            </p>
          </div>
          <div className="stub-body">
            {profile && (
              <p className="level">
                <b>Level {profile.level + 1}</b>, vote weight {weightLabel(profile.weight)}.{' '}
                {profile.next_level_in !== null
                  ? `${profile.next_level_in} more ${profile.next_level_in === 1 ? 'vote' : 'votes'} to level up.`
                  : 'Top level reached.'}
              </p>
            )}
            {!signedAccountId ? (
              <>
                <p className="note">Connect a NEAR wallet to vote.</p>
                <button className="btn btn-primary" onClick={() => void signIn()}>Connect wallet</button>
              </>
            ) : myVote ? (
              <>
                <p>
                  You called <b style={{ color: BUCKETS[myVote.bucket].text }}>{BUCKETS[myVote.bucket].name}</b> with{' '}
                  {formatNear(myVote.stake)} NEAR.
                </p>
                {open && <p className="note">Payouts open after voting closes and the verdict is final.</p>}
                {!open && !myVote.claimed && finalBucket === null && !graceOver && (
                  <p className="note">Waiting for the verdict. Anyone can finalize it from the Meter section.</p>
                )}
                {!open && !myVote.claimed && finalBucket === null && graceOver && (
                  <p className="note">The verdict never landed, so you get your full stake back.</p>
                )}
                {!open && finalBucket !== null && preview && (
                  <p className={preview.state === 'won' ? 'success' : 'note'}>
                    {preview.state === 'won'
                      ? `You called it. You get ${formatNear(preview.payout, 4)} NEAR: your stake plus a share of the pool.`
                      : `Your call lost. You get ${formatNear(preview.payout, 4)} NEAR back after the ${slashPct}% slash.`}
                  </p>
                )}
                {!open && !myVote.claimed && canClaim && (
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => runAction('claim_bond', { movie_id: movieId }, 'Payout sent to your wallet.')}
                  >
                    Claim payout
                  </button>
                )}
                {myVote.claimed && <p className="success">Payout claimed.</p>}
                {myVote.claimed && finalBucket !== null && !settled && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      runAction(
                        'settle_taste',
                        { movie_id: movieId, account_id: signedAccountId },
                        'Taste Score updated.',
                      )
                    }
                  >
                    Update my Taste Score
                  </button>
                )}
                {settled && (
                  <p className="success">Taste Score updated. <Link href="/leaderboard">See the leaderboard</Link></p>
                )}
              </>
            ) : open ? (
              <>
                <div className="bucket-picker" role="group" aria-label="Pick a bucket">
                  {BUCKETS.map((b) => (
                    <button
                      key={b.id}
                      className="bucket-btn"
                      style={{ ['--c' as string]: b.fill }}
                      aria-pressed={bucket === b.id}
                      onClick={() => setBucket(b.id)}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span>Stake in NEAR</span>
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <button className="btn btn-primary" disabled={busy} onClick={submitVote}>
                  {busy ? 'Waiting for wallet...' : 'Stake and vote'}
                </button>
              </>
            ) : (
              <p className="note">Voting is closed for this movie.</p>
            )}
            {error && <p className="error">{error}</p>}
            {message && <p className="success">{message}</p>}
          </div>
        </aside>

        {meta && meta.genres.length > 0 && (
          <section className="side-vibe">
            <h2>Vibe</h2>
            <VibeChart genres={meta.genres} />
            <p className="note">Genre mix from TMDB, weighted toward the first-listed genres.</p>
          </section>
        )}
        </div>
      </div>
    </main>
  );
}
