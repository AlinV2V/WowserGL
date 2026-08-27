import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const assetOrigin = env.VANILLAGL_ASSET_ORIGIN || 'http://localhost:5173';
  const proxy = (path: string) => [path, { target: assetOrigin, changeOrigin: true }] as const;
  return {
    server: {
      port: 5180,
      strictPort: true,
      proxy: Object.fromEntries([
        proxy('/terrain'),
        proxy('/textures'),
        proxy('/models'),
        proxy('/creatures'),
        proxy('/data'),
        proxy('/basis'),
      ]),
    },
  };
});
