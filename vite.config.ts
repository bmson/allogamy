import { defineConfig } from 'vite';

// Host is exposed so an iPhone on the same LAN can later load the controller UI.
export default defineConfig({
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
});
