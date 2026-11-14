import '@/app/globals.css';
import type { Metadata } from 'next';
import { Big_Shoulders, Instrument_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from '@/providers';

const display = Big_Shoulders({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const text = Instrument_Sans({ subsets: ['latin'], variable: '--font-text', display: 'swap' });

export const metadata: Metadata = {
  title: 'Kinora',
  description: 'Movie ratings backed by refundable NEAR stakes.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
