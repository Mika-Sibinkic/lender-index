import { APP_NAME, LOGO_URL, ORG_NAME } from '@/lib/config/org'

/** The org logo when NEXT_PUBLIC_LOGO_URL is set, else APP_NAME as a text wordmark. */
export function BrandMark({ imgClassName, textClassName }: { imgClassName: string; textClassName: string }) {
  if (!LOGO_URL) return <span className={textClassName}>{APP_NAME}</span>
  // Plain <img>: the logo can live on any host, and next/image would need remotePatterns for it.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={LOGO_URL} alt={ORG_NAME} className={imgClassName} />
}
