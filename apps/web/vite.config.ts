import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { wasp } from "wasp/client/vite";
import { scopeWaspTypeCheck } from "../../scripts/wasp-build-scope.mjs";
import { parseAppSurfaceConfig } from "./src/client/app-surface";

const surface = parseAppSurfaceConfig({ surface: process.env.VITE_APP_SURFACE, adminOrigin: process.env.VITE_ADMIN_APP_ORIGIN, customerOrigin: process.env.VITE_CUSTOMER_APP_ORIGIN });

export default defineConfig({
  plugins: [await scopeWaspTypeCheck(wasp(), fileURLToPath(new URL('./tsconfig.build.json', import.meta.url))), tailwindcss()],
  cacheDir: `node_modules/.vite/${surface.surface}`,
  // Wasp reserves REACT_APP_ and disables automatic Vite env loading. Expose
  // only public website identifiers and app origins from the build command.
  define: {
    'import.meta.env.VITE_GA4_MEASUREMENT_ID': JSON.stringify(process.env.VITE_GA4_MEASUREMENT_ID ?? ''),
    'import.meta.env.VITE_CLARITY_PROJECT_ID': JSON.stringify(process.env.VITE_CLARITY_PROJECT_ID ?? ''),
    'import.meta.env.VITE_APP_SURFACE': JSON.stringify(surface.surface),
    'import.meta.env.VITE_ADMIN_APP_ORIGIN': JSON.stringify(surface.adminOrigin),
    'import.meta.env.VITE_CUSTOMER_APP_ORIGIN': JSON.stringify(surface.customerOrigin),
  },
  server: {
    open: false,
    host: '127.0.0.1',
  },
});
