import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Served under /notes on the unified domain (Vercel multi-zone).
  base: '/notes/',
  plugins: [react()],
});
