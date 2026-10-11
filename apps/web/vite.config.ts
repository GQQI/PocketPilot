import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"],
      manifest: {
        name: "PocketPilot 口袋领航",
        short_name: "PocketPilot",
        description: "Mobile-first control panel for coding agents",
        theme_color: "#f3f0ea",
        background_color: "#f3f0ea",
        display: "standalone",
        start_url: "/",
        lang: "zh",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@pocketpilot/remote": fileURLToPath(new URL("../../packages/remote/src/index.ts", import.meta.url)),
      "@pocketpilot/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 47231,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:47232",
    },
  },
});
