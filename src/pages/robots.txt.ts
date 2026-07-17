export function GET() {
  const isProduction = import.meta.env.PUBLIC_SITE_ENV === 'production';
  const body = isProduction
    ? `User-agent: *\nAllow: /\n\nSitemap: https://daniel.rochatka.com/sitemap-index.xml\n`
    : `User-agent: *\nDisallow: /\n`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
