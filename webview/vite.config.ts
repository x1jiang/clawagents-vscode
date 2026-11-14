import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Single protocol source (host src/protocol.ts).
      "../../src/protocol": path.resolve(__dirname, "../src/protocol.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react-markdown") || id.includes("remark-") || id.includes("mdast-") || id.includes("micromark")) {
              return "markdown-vendor";
            }
          }
        },
      },
    },
  },
});
