import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { wasp } from "wasp/client/vite";
import { scopeWaspTypeCheck } from "../../scripts/wasp-build-scope.mjs";
import { prerenderWaspTools } from "../../scripts/wasp-tools-prerender.mjs";
import { freeToolsHead } from "../../scripts/free-tools-head.mjs";
import { parseAppSurfaceConfig } from "./src/client/app-surface";
import { freeToolPaths } from "./src/shared/free-tools";

const surface = parseAppSurfaceConfig({ surface: process.env.VITE_APP_SURFACE, adminOrigin: process.env.VITE_ADMIN_APP_ORIGIN, customerOrigin: process.env.VITE_CUSTOMER_APP_ORIGIN });
const waspPlugins = await scopeWaspTypeCheck(wasp(), fileURLToPath(new URL('./tsconfig.build.json', import.meta.url)));

export default defineConfig({
  plugins: [surface.surface === 'customer' ? await prerenderWaspTools(waspPlugins, freeToolPaths) : waspPlugins, surface.surface === 'customer' && freeToolsHead(freeToolPaths), tailwindcss()],
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
