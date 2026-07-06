import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Life Project',
  description: 'Life Project V1'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang='zh-CN'>
      <body>
        <div className='min-h-screen'>
          {children}
        </div>
      </body>
    </html>
  );
}
