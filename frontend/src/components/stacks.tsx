import { BUCKETS, formatNear, type Meter } from '@/lib/kinora';

const MAX_CHIPS = 10;

// Column height is weighted vote power (what decides the verdict); the stake in NEAR sits underneath.
export function StakeStacks({ meter, compact = false }: { meter: Meter | null; compact?: boolean }) {
  const power = meter ? meter.weights.map((w) => BigInt(w)) : [BigInt(0), BigInt(0), BigInt(0), BigInt(0)];
  const biggest = power.reduce((a, b) => (b > a ? b : a), BigInt(0));

  return (
    <div className={compact ? 'stacks stacks-compact' : 'stacks'} role="img" aria-label="Weighted votes by bucket">
      {BUCKETS.map((b) => {
        const chips =
          biggest === BigInt(0) || power[b.id] === BigInt(0)
            ? 0
            : Math.max(1, Math.ceil(Number((power[b.id] * BigInt(1000)) / biggest) / (1000 / MAX_CHIPS)));
        const pct = meter?.weight_pct[b.id] ?? 0;
        const votes = meter?.counts[b.id] ?? 0;
        const isHead = meter?.headline_bucket === b.id;
        return (
          <div className="stack" key={b.id}>
            <div className="stack-top">
              <span className="stack-pct" style={{ color: isHead ? (compact ? b.fill : b.text) : undefined }}>
                {pct}%
              </span>
            </div>
            <div className="stack-col">
              {chips === 0 && <span className="chip chip-empty" />}
              {Array.from({ length: chips }, (_, i) => (
                <span
                  key={i}
                  className="chip"
                  style={{ background: b.fill, ['--i' as string]: i + b.id * 2 }}
                />
              ))}
            </div>
            <div className="stack-name">{b.name}</div>
            {!compact && (
              <div className="stack-meta">
                {votes} {votes === 1 ? 'vote' : 'votes'}
                <br />
                {meter ? formatNear(meter.stakes[b.id]) : '0.00'} NEAR
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
