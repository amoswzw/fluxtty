import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  resolve: {
    extensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome100', 'safari14'],
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
