import {
  MAX_MANIFEST_BYTES,
  parseCatalog,
  parseManifestUrl,
  type Catalog,
} from "../shared/catalog";

export async function fetchCatalog(signal: AbortSignal): Promise<Catalog> {
  const configured = import.meta.env.VITE_MANIFEST_URL?.trim();
  if (!configured) {
    throw new Error("No build catalog configured. Set VITE_MANIFEST_URL and restart or rebuild.");
  }
  const url = parseManifestUrl(new URL(configured, window.location.href).href);
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    credentials: "omit",
    redirect: "error",
    cache: "no-cache",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Build manifest is unavailable (HTTP ${response.status}).`);
  }
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    await response.body.cancel();
    throw new Error("The build manifest did not return JSON.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let json = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.length;
      if (bytes > MAX_MANIFEST_BYTES) {
        throw new Error("The build manifest exceeds the supported size.");
      }
      json += decoder.decode(value, { stream: true });
    }
    json += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(json);
  return parseCatalog(value, url.href);
}
