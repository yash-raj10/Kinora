import { vibeMix } from '@/lib/kinora';

// One colour per TMDB genre so a movie's mix reads at a glance.
const GENRE_COLORS: Record<string, string> = {
  Action: '#e5482f',
  Adventure: '#f28c28',
  Animation: '#e85da8',
  Comedy: '#f2c200',
  Crime: '#5b4b9a',
  Documentary: '#5c7a8a',
  Drama: '#2a7fdb',
  Family: '#2bb6a3',
  Fantasy: '#a66bff',
  History: '#a98467',
  Horror: '#b3262b',
  Music: '#ff7a59',
  Mystery: '#3f51b5',
  Romance: '#f0508c',
  'Science Fiction': '#12a0c8',
  Thriller: '#4a5568',
  War: '#7c6f57',
  Western: '#c08a3e',
};

const FALLBACK = ['#2a7fdb', '#12a06a', '#f28c28', '#e85da8'];

function colorFor(genre: string, index: number): string {
  return GENRE_COLORS[genre] ?? FALLBACK[index % FALLBACK.length];
}

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 2.5; // visible gap between slices, in stroke length

export function VibeChart({ genres }: { genres: string[] }) {
  const mix = vibeMix(genres);
  if (mix.length === 0) return null;

  const slices = mix.map((m, i) => {
    const start = mix.slice(0, i).reduce((sum, prev) => sum + prev.pct, 0);
    const visible = Math.max((m.pct / 100) * CIRCUMFERENCE - GAP, 0.1);
    return {
      key: m.name,
      color: colorFor(m.name, i),
      dash: `${visible} ${CIRCUMFERENCE - visible}`,
      offset: -(start / 100) * CIRCUMFERENCE,
    };
  });
  const top = mix[0];

  return (
    <div className="vibe">
      <svg
        className="vibe-donut"
        viewBox="0 0 140 140"
        role="img"
        aria-label={mix.map((m) => `${m.name} ${m.pct}%`).join(', ')}
      >
        <g transform="rotate(-90 70 70)">
          <circle cx="70" cy="70" r={RADIUS} fill="none" stroke="var(--line)" strokeWidth="16" />
          {slices.map((s) => (
            <circle
              key={s.key}
              cx="70"
              cy="70"
              r={RADIUS}
              fill="none"
              stroke={s.color}
              strokeWidth="16"
              strokeDasharray={s.dash}
              strokeDashoffset={s.offset}
            />
          ))}
        </g>
        <text x="70" y="68" textAnchor="middle" className="vibe-donut-pct">{top.pct}%</text>
        <text x="70" y="88" textAnchor="middle" className="vibe-donut-name">{top.name}</text>
      </svg>
      <ul className="vibe-list">
        {mix.map((m, i) => (
          <li key={m.name}>
            <i style={{ background: colorFor(m.name, i) }} />
            {m.name} <b>{m.pct}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
