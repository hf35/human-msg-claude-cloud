import react from '@vitejs/plugin-react';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Where `pnpm --filter @human-msg/server dev` listens
const SERVER = process.env.API_URL ?? 'http://127.0.0.1:3000';

// The router calls the home page `/admin` (no slash), while Vite serves the app only at `/admin/`:
// without this, reloading the home page answers 404
const toBase: Connect.NextHandleFunction = (request, response, next) => {
  if (request.url !== '/admin' && !request.url?.startsWith('/admin?')) return next();
  response.statusCode = 301;
  response.setHeader('location', request.url.replace('/admin', '/admin/'));
  response.end();
};
const redirectToBase: Plugin = {
  name: 'redirect-to-base',
  configureServer: (server) => void server.middlewares.use(toBase),
  configurePreviewServer: (server) => void server.middlewares.use(toBase),
};

export default defineConfig({
  plugins: [react(), redirectToBase],
  // The back office lives under /admin, like its API and its cookie (see ADMIN_PATH on the server)
  base: '/admin/',
  // One .env for the whole repository; Vite exposes to the page only the variables named VITE_*
  envDir: '../..',
  server: {
    port: 5175,
    // The browser talks only to the dev server: the cookie stays same-origin, as behind Caddy in production
    proxy: {
      '/admin/api': { target: SERVER },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Refine and antd render slowly in jsdom; a test walks several pages
    testTimeout: 20_000,
    // Refine's packages must be bundled with the app: loaded natively they get a second copy of
    // react-router (CJS next to ESM) and fail with "useLocation() may be used only in <Router>"
    server: { deps: { inline: [/@refinedev/, /react-router/] } },
  },
});
