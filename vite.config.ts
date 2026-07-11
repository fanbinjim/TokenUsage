import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5174,
    host: "0.0.0.0",
    strictPort: true,
    watch: {
      ignored: ["**/target/**", "**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2022", "chrome105"],
    sourcemap: process.env.TAURI_ENV_DEBUG === "true",
  },
  test: {
    environment: "jsdom",
  },
});
