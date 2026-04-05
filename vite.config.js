import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  server: {
    port: 5174,
    strictPort: false,
  },
  build: {
    target: "es2020",
    outDir: "../dist",
    emptyOutDir: true,
  },
});
