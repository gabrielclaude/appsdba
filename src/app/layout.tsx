import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Header } from '@/components/Header';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: '21st Century Apps DBA',
    template: '%s | 21st Century Apps DBA',
  },
  description:
    'Deep-dive articles on Oracle Database, EBS Suite 12, WebLogic, GoldenGate, Data Guard disaster recovery, and Oracle RAC & Clusterware.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-50">
        <Header />
        <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">{children}</main>
        <footer className="border-t bg-gray-900 text-gray-400 text-sm text-center py-6">
          © {new Date().getFullYear()} 21st Century Apps DBA · Oracle · EBS · WebLogic · GoldenGate · RAC
        </footer>
      </body>
    </html>
  );
}
