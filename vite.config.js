import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const requestedBase = process.env.BASE_PATH;
const normalizedBase = requestedBase
  ? requestedBase.endsWith('/')
    ? requestedBase
    : `${requestedBase}/`
  : process.env.GITHUB_ACTIONS && repositoryName
    ? `/${repositoryName}/`
    : '/';

export default defineConfig({
  base: normalizedBase,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
      manifest: {
        id: normalizedBase,
        name: '3D Object Viewer',
        short_name: '3D Viewer',
        description: 'Local PWA viewer for ZIP, mounted folders, FBX, GLB, GLTF and OBJ assets with textures.',
        theme_color: '#1a1c1e',
        background_color: '#111213',
        lang: 'en',
        start_url: normalizedBase,
        scope: normalizedBase,
        display: 'standalone',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            purpose: 'any maskable',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        navigateFallback: 'index.html',
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}']
      }
    })
  ]
});
