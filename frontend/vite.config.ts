import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // 관리 화면(index.html)과 근로자 앱(worker.html)을 따로 빌드한다
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        worker: resolve(__dirname, 'worker.html'),
      },
    },
  },
  server: {
    // 근로자 앱을 폰에서 https로 열 때(cloudflared 임시 터널) 쓰는 주소를 허용한다
    allowedHosts: ['.trycloudflare.com'],
    // https 페이지에서는 http 백엔드를 직접 부를 수 없어서, 같은 주소의 /api로 받아 백엔드(8000)로 넘긴다
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
