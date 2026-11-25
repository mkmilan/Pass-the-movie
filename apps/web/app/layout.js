import './globals.css';

export const metadata = {
  title: 'Pass the Movie',
  description: 'Five friends. Three seconds each. One unpredictable movie.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
