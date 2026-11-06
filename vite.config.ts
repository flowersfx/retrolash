import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Listen on the LAN so phones on the same Wi-Fi can join during dev.
  server: { host: true },
});
