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

export function VibeChart({ genres }: { genres: string[] }) {
  const mix = vibeMix(genres);
  if (mix.length === 0) return null;
  return (
    <div className="vibe">
      <div className="vibe-bar" role="img" aria-label={mix.map((m) => `${m.name} ${m.pct}%`).join(', ')}>
        {mix.map((m, i) => (
          <span key={m.name} style={{ width: `${m.pct}%`, background: colorFor(m.name, i) }} />
        ))}
      </div>
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
