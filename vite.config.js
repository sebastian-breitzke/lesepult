import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
});
