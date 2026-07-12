import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin /api during dev: proxy to the BFF (design/quotaui.md §3).
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
