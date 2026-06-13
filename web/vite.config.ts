import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // We register + poll for updates manually in main.tsx (self-healing), so
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
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
        navigateFallback: '/index.html',
        // SPA routes fall back to index.html, but API + public pages must NOT.
        navigateFallbackDenylist: [/^\/api/, /^\/help/, /^\/view\//, /^\/skill\//],
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
