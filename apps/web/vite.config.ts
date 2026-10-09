import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Where `pnpm --filter @human-msg/server dev` listens
const SERVER = process.env.API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  // One .env for the whole repository; Vite exposes to the page only the variables named VITE_*
  envDir: '../..',
  server: {
    port: 5173,
    // The browser talks only to the dev server: cookies stay same-origin, as behind Caddy in production
    proxy: {
      '/api': { target: SERVER, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
