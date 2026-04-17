import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/3DZipView/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '3DZipView',
        short_name: '3DZipView',
        description: 'View 3D files (FBX, GLB, OBJ) directly in the browser via drag & drop ZIPs.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [
          {
            src: '/icon.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ]
});
