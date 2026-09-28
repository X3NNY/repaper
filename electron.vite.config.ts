import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: { lib: { entry: 'electron/main/index.ts' } }
  },
  preload: {
    build: { lib: { entry: 'electron/preload/index.ts' } }
  },
  renderer: {
    root: 'src',
    plugins: [react()],
    build: { rollupOptions: { input: resolve(process.cwd(), 'src/index.html') } }
  }
})
