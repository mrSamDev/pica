import vueJsx from "@vitejs/plugin-vue-jsx";
import { defineConfig } from "vite";

// Dashboard client bundle: one ESM file the server serves at /dashboard/app.js.
// Output lives under src/ so the Dockerfile's `COPY src` ships it.
export default defineConfig({
  plugins: [vueJsx()],
  build: {
    outDir: "src/dashboard/dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/dashboard/app.jsx",
      output: { format: "es", entryFileNames: "app.js" },
    },
  },
});
