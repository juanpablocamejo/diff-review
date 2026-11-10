import { sveltekit } from '@sveltejs/kit/vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
// La versión publicada es la del paquete raíz (el CLI), no la de web/package.json.
const version = JSON.parse(readFileSync(path.resolve(here, '../package.json'), 'utf8')).version;

export default defineConfig({
  plugins: [sveltekit()],
  define: {
    __APP_VERSION__: JSON.stringify(version)
  },
  server: {
    port: 5190,
    host: '127.0.0.1',
    fs: {
      allow: [path.resolve(here, '..')]
    }
  }
});
