// Sitemap généré au build. Le site n'a que quelques pages : les énumérer ici
// évite d'ajouter une intégration pour si peu.

import type { APIRoute } from 'astro';
import { SITE } from '../consts';

const PAGES = [
  { chemin: '/', priorite: '1.0', frequence: 'weekly' },
  { chemin: '/a-propos/', priorite: '0.5', frequence: 'monthly' },
  { chemin: '/mentions-legales/', priorite: '0.2', frequence: 'yearly' },
];

export const GET: APIRoute = () => {
  const aujourdhui = new Date().toISOString().slice(0, 10);

  const urls = PAGES.map(
    ({ chemin, priorite, frequence }) => `  <url>
    <loc>${SITE}${chemin}</loc>
    <lastmod>${aujourdhui}</lastmod>
    <changefreq>${frequence}</changefreq>
    <priority>${priorite}</priority>
  </url>`
  ).join('\n');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } }
  );
};
