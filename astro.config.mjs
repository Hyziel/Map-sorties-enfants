// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://sorties-enfants-geneve.netlify.app',
  output: 'static',
  build: { inlineStylesheets: 'auto' },
  vite: {
    build: { assetsInlineLimit: 2048 },
  },
});
