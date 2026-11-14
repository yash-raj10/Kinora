import { vibeMix } from '@/lib/kinora';

const SHADES = [1, 0.7, 0.48, 0.3];

export function VibeChart({ genres }: { genres: string[] }) {
  const mix = vibeMix(genres);
  if (mix.length === 0) return null;
  return (
    <div className="vibe">
      <div className="vibe-bar" role="img" aria-label={mix.map((m) => `${m.name} ${m.pct}%`).join(', ')}>
        {mix.map((m, i) => (
          <span key={m.name} style={{ width: `${m.pct}%`, opacity: SHADES[i] }} />
        ))}
      </div>
      <ul className="vibe-list">
        {mix.map((m, i) => (
          <li key={m.name}>
            <i style={{ opacity: SHADES[i] }} />
            {m.name} <b>{m.pct}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
