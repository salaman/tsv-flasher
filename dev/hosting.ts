import type { Plugin } from "vite";
import { parseManifestUrl } from "../shared/catalog.ts";

/** Keep the production CSP in sync with the manifest origin selected at build time. */
export function hosting(manifestUrl?: string): Plugin {
  let origin: string;
  return {
    name: "thinksmart-hosting",
    apply: "build",
    configResolved() {
      if (!manifestUrl?.trim()) {
        throw new Error("Set VITE_MANIFEST_URL to an HTTPS catalog URL before building.");
      }
      const url = parseManifestUrl(manifestUrl);
      if (url.protocol !== "https:") {
        throw new Error("Production manifests must use HTTPS.");
      }
      origin = url.origin;
    },
    generateBundle() {
      const config = {
        globalHeaders: {
          "Cache-Control": "no-cache",
          "Content-Security-Policy": [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            `connect-src 'self' ${origin}`,
            "base-uri 'none'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "form-action 'none'",
            "upgrade-insecure-requests",
          ].join("; "),
          "Permissions-Policy": "usb=(self), camera=(), microphone=(), geolocation=(), payment=()",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Strict-Transport-Security": "max-age=31536000",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
        routes: [
          {
            route: "/assets/*",
            headers: { "Cache-Control": "public, max-age=31536000, immutable" },
          },
        ],
      };
      this.emitFile({
        type: "asset",
        fileName: "staticwebapp.config.json",
        source: JSON.stringify(config, null, 2),
      });
    },
  };
}
