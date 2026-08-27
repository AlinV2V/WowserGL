import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const assetOrigin = env.VANILLAGL_ASSET_ORIGIN || 'http://localhost:5173';
  return {
    server: {
      port: 5180,
      strictPort: true,
      proxy: {
        '/terrain': { target: assetOrigin, changeOrigin: true },
        '/textures': { target: assetOrigin, changeOrigin: true },
        '/models': { target: assetOrigin, changeOrigin: true },
      },
    },
  };
});
