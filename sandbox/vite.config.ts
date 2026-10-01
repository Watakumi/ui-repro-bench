import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // ハーネスが --port で上書きする。strictPort にして黙ってずれるのを防ぐ。
    port: 5199,
    strictPort: true,
  },
})
