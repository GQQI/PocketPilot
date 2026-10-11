import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.pocketpilot.app",
  appName: "PocketPilot",
  // The built web UI is bundled into the APK and served from https://localhost (works fully offline).
  webDir: "../web/dist",
  android: {
    // Lets the bundled UI also reach a plain-http LAN host (pairing by code over Wi-Fi).
    allowMixedContent: true,
  },
};

export default config;
