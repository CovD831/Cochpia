import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  // .env 在项目根目录(而非 client/),显式指定 envDir,否则 VITE_SUPABASE_* 等前端环境变量不会注入,
  // 前端 supabase=null → 不带鉴权 → /api/sessions 401 → refresh() 失败 → 模型列表空 → 显示“未配置”。
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: { force: true, include: ['react', 'react-dom/client'] },
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787', '/mcp': 'http://localhost:8787' }
  }
});
