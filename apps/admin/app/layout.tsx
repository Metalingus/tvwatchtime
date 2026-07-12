import './globals.css';
import type { Metadata } from 'next';
import { AuthProvider } from '@/lib/auth';
import { DialogProvider } from '@/components/DialogProvider';
import { ThemeProvider } from '@/components/ThemeProvider';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'TVWatchTime Admin',
  description: 'Admin console for TVWatchTime',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const apiUrl = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__API_URL__=${JSON.stringify(apiUrl)};`,
          }}
        />
      </head>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <AuthProvider>
            <DialogProvider>{children}</DialogProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
