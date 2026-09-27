import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build works from any folder (e.g. GitHub Pages project sites).
  base: "./",
  plugins: [react()],
  // MapLibre's worker is an ES module that imports a shared chunk.
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
