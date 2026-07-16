import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { writeFileSync } from 'fs';

// One build id, baked into the app (__APP_BUILD__) AND written to dist/version.json. The client
// compares them and force-reloads when they differ — drags a stuck/cached PWA onto the latest.
const BUILD_ID = new Date().toISOString().slice(5, 16).replace('T', ' '); // UTC "MM-DD HH:MM"

export default defineConfig({
  define: { __APP_BUILD__: JSON.stringify(BUILD_ID) },
  plugins: [
    {
      name: 'emit-version-json',
      closeBundle() {
        try {
          writeFileSync('dist/version.json', JSON.stringify({ build: BUILD_ID }));
        } catch {
          /* ignore */
        }
      },
    },
    react(),
    VitePWA({
      // 'prompt' so updates wait for the user: the app shows a bottom "Update" toast
      // (ui/UpdatePrompt.tsx) that activates the new SW + reloads on tap — no surprise reloads.
      registerType: 'prompt',
      // We register + poll for updates via the useRegisterSW hook (UpdatePrompt), so
      // disable the plugin's own auto-injected registration to avoid double-register.
      injectRegister: null,
      includeAssets: ['favicon-32.png', 'icons/icon-180.png'],
      manifest: {
        name: 'My Brain',
        short_name: 'My Brain',
        description: 'Your private second brain — research, bookmarks, ideas, tasks, activity & chat in one place.',
        theme_color: '#059669',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The main bundle crossed workbox's 2 MiB default (build hard-fails); keep precaching it.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
        navigateFallback: '/index.html',
        // SPA routes fall back to index.html, but API + public pages must NOT.
        navigateFallbackDenylist: [/^\/api/, /^\/help/, /^\/view\//, /^\/skill\//, /^\/meeting-view\//, /^\/request-view\//, /^\/version\.json/],
        runtimeCaching: [
          // Never serve a stale API response — the app's data is always live.
          { urlPattern: ({ url }) => url.pathname.startsWith('/api'), handler: 'NetworkOnly' },
        ],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    proxy: { '/api': 'http://localhost:8080' },
  },
  build: { outDir: 'dist' },
});
