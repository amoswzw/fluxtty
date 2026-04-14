import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Prefer .ts over .js so vitest loads source files, not compiled artifacts.
    extensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'],
    alias: {
      // Stub out Tauri APIs so tests run in Node without a WebView.
      '@tauri-apps/api/core': path.resolve(__dirname, 'src/__mocks__/tauri-core.ts'),
      '@tauri-apps/api/event': path.resolve(__dirname, 'src/__mocks__/tauri-event.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
