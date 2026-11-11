import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { ClerkProvider } from '@clerk/nextjs'
import { Toaster } from '@/components/ui/sonner'
import { APP_NAME } from '@/lib/config/org'
import './globals.css'

// Self-hosted rather than next/font/google: a build-time fetch of
// fonts.googleapis.com can fail a production deploy with "Module not found"
// while CI and the preview build both pass. See ./fonts/README.md. Files are
// the latin subsets, OFL-licensed.

const fraunces = localFont({
  src: [{ path: './fonts/Fraunces-latin.woff2', weight: '400 600', style: 'normal' }],
  variable: '--font-fraunces',
  display: 'swap',
})

const ibmPlex = localFont({
  src: [
    { path: './fonts/IBMPlexSans-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexSans-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/IBMPlexSans-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-ibm-plex',
  display: 'swap',
})

const jbMono = localFont({
  src: [{ path: './fonts/JetBrainsMono-latin.woff2', weight: '400 500', style: 'normal' }],
  variable: '--font-jb-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: `${APP_NAME}`,
  description: 'Lender and funding-source database with deal matching.',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${fraunces.variable} ${ibmPlex.variable} ${jbMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          {children}
          <Toaster richColors closeButton position="top-right" />
        </body>
      </html>
    </ClerkProvider>
  )
}
