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
            if (
              id.includes("react-markdown") ||
              id.includes("remark-") ||
              id.includes("mdast-") ||
              id.includes("micromark") ||
              id.includes("unified") ||
              id.includes("unist-") ||
              id.includes("vfile") ||
              id.includes("hast-") ||
              id.includes("property-information") ||
              id.includes("space-separated-tokens") ||
              id.includes("comma-separated-tokens") ||
              id.includes("ccount") ||
              id.includes("devlop") ||
              id.includes("bail") ||
              id.includes("trough") ||
              id.includes("is-plain-obj") ||
              id.includes("zwitch") ||
              id.includes("html-url-attributes") ||
              id.includes("character-entities") ||
              id.includes("decode-named-character-reference") ||
              id.includes("stringify-entities") ||
              id.includes("trim-lines") ||
              id.includes("estree-util-")
            ) {
              return "markdown-vendor";
            }
          }
        },
      },
    },
  },
});
