import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  compilerOptions: {
    experimental: {
      async: true
    }
  },
  kit: {
    adapter: adapter(),
    experimental: {
      remoteFunctions: true
    },
    alias: {
      $lib: 'src/lib',
      $review: path.resolve(here, '..')
    }
  }
};

export default config;
