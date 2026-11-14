import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useNearWallet } from '@/providers/near-provider';

export const Navigation = () => {
  const { signedAccountId, loading, signIn, signOut } = useNearWallet();
  const pathname = usePathname();

  const handleAction = () => {
    if (signedAccountId) {
      void signOut();
    } else {
      void signIn();
    }
  };

  const label = loading ? 'Loading...' : signedAccountId ? `Disconnect ${signedAccountId}` : 'Connect wallet';

  return (
    <nav className="nav" aria-label="Main">
      <div className="container nav-inner">
        <Link href="/" className="brand" aria-label="Kinora home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/kinora-logo.svg" alt="Kinora" width={1381} height={595} />
        </Link>
        <div className="nav-links">
          <Link href="/" aria-current={pathname === '/' || pathname.startsWith('/movie') ? 'page' : undefined}>
            Movies
          </Link>
          <Link href="/markets" aria-current={pathname === '/markets' ? 'page' : undefined}>
            Box office
          </Link>
          <Link href="/leaderboard" aria-current={pathname === '/leaderboard' ? 'page' : undefined}>
            Leaderboard
          </Link>
        </div>
        <button className="btn nav-wallet" onClick={handleAction} disabled={loading}>
          {label}
        </button>
      </div>
    </nav>
  );
};
