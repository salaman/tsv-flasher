import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { localAssets } from "./dev/local-assets.ts";
import { hosting } from "./dev/hosting.ts";

// https://vite.dev/config/
export default defineConfig(({ mode, command, isPreview }) => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const env = loadEnv(mode, root, ["VITE_", "LOCAL_ASSET_"]);
  const manifestUrl = env.VITE_MANIFEST_URL?.trim();
  return {
    plugins: [
      tailwindcss(),
      command === "serve" && !isPreview && manifestUrl === "/local-assets/manifest.json"
        ? localAssets({
            manifest: env.LOCAL_ASSET_MANIFEST ?? "",
            baseUrl: env.LOCAL_ASSET_BASE_URL ?? "",
            imageRoot: env.LOCAL_ASSET_IMAGE_ROOT ?? "",
            programmer: env.LOCAL_ASSET_PROGRAMMER ?? "",
          })
        : null,
      hosting(manifestUrl),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
    ],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
    preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  };
});
