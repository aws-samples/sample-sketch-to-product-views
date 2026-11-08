import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In dev, `VITE_API_URL` is the deployed site (output `web_url`): the API is reachable only
 * through CloudFront, and its CORS list allows the dev origin below (`allowed_web_origins`).
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5273, strictPort: true },
  preview: { port: 5273, strictPort: true },
});
