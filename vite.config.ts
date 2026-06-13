import { defineConfig } from 'vite';

// `base` is the repo subpath for the GitHub Pages project site
// (https://bmson.github.io/allogamy/). It's applied ONLY to the production build,
// so `pnpm dev` still serves from root. Host is exposed so an iPhone on the same
// LAN can load the controller UI in dev.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/allogamy/' : '/',
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
}));
