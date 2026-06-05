import { defineConfig } from "vite";

// The dashboard frontend lives in `web/` and builds to `dist/web/`, which the
// dashboard server (src/dashboard/server.ts) serves statically.
export default defineConfig({
  root: "web",
  base: "./",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
