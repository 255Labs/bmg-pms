import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        // libraries change rarely, so browsers keep them cached between releases
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('react')) return 'react';
          if (id.includes('@fontsource')) return undefined;
          return 'vendor';
        },
      },
    },
  },
});
