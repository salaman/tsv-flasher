import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Plugin } from "vite";
import { MAX_MANIFEST_BYTES, parseCatalog } from "../shared/catalog.ts";

interface LocalAssetOptions {
  manifest: string;
  baseUrl: string;
  imageRoot: string;
  programmer: string;
}

interface AssetFile {
  path: string;
  bytes: number;
}

function fail(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(message);
}

/** Stream only named build assets, without granting Vite access to parent directories. */
async function serveAsset(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
  files: ReadonlyMap<string, AssetFile>,
  manifest: string,
) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/local-assets/")) {
    next();
    return;
  }

  // Local workspace files are never a cross-origin download API.
  const host = request.headers.host;
  if (
    !host ||
    !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
    request.headers["sec-fetch-site"] === "cross-site" ||
    (request.headers.origin && request.headers.origin !== `http://${host}`)
  ) {
    fail(response, 403, "Local assets are available only to this loopback origin.");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    fail(response, 405, "Only GET and HEAD are allowed.");
    return;
  }

  if (url.pathname === "/local-assets/manifest.json") {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(manifest),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : manifest);
    return;
  }

  const file = files.get(url.pathname);
  if (!file) {
    fail(response, 404, "This asset is not in the local build allowlist.");
    return;
  }

  // Do not let a replaced file symlink expose a different workspace file.
  if ((await realpath(file.path)) !== file.path) {
    fail(response, 409, "The configured asset must be a regular, non-symlink file.");
    return;
  }

  const metadata = await stat(file.path);
  if (!metadata.isFile() || metadata.size !== file.bytes) {
    fail(
      response,
      409,
      "Local asset size differs from the pinned build. Update the profile explicitly.",
    );
    return;
  }

  // Keep large images disk-backed. A request selects an inclusive byte range;
  // malformed, multipart, and suffix ranges are deliberately unsupported.
  let start = 0;
  let end = metadata.size - 1;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (match) {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
    }
    if (
      !match ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      end >= metadata.size
    ) {
      response.setHeader("Content-Range", `bytes */${metadata.size}`);
      fail(response, 416, "Invalid or unsupported byte range.");
      return;
    }

    response.setHeader("Content-Range", `bytes ${start}-${end}/${metadata.size}`);
  }

  response.writeHead(range ? 206 : 200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": end - start + 1,
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  await pipeline(createReadStream(file.path, { start, end }), response);
}

/** Local-only Vite endpoints; these assets are never copied into the UI bundle. */
export function localAssets(options: LocalAssetOptions): Plugin {
  const files = new Map<string, AssetFile>();
  let manifest = "";

  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    void serveAsset(request, response, next, files, manifest).catch((error: unknown) => {
      console.error("[local-assets]", error);
      if (!response.headersSent) {
        fail(response, 503, "Local asset unavailable. Check the pinned paths and server log.");
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  return {
    name: "thinksmart-local-assets",
    apply: (_, { command, isPreview }) => command === "serve" && !isPreview,

    async configResolved(config) {
      if (Object.values(options).some((value) => !value.trim())) {
        throw new Error(
          "Local assets require LOCAL_ASSET_MANIFEST, LOCAL_ASSET_BASE_URL, LOCAL_ASSET_IMAGE_ROOT and LOCAL_ASSET_PROGRAMMER. See .env.example.",
        );
      }
      const manifestBytes = await readFile(resolve(config.root, options.manifest));
      if (manifestBytes.length > MAX_MANIFEST_BYTES) {
        throw new Error("The local manifest exceeds the supported size.");
      }
      const raw: unknown = JSON.parse(manifestBytes.toString("utf8"));
      const catalog = parseCatalog(raw, options.baseUrl);
      const programmerUrl = "/local-assets/programmer.bin";

      files.set(programmerUrl, {
        path: resolve(config.root, options.programmer),
        bytes: catalog.programmer.bytes,
      });

      manifest = JSON.stringify({
        ...catalog,
        programmer: { ...catalog.programmer, url: programmerUrl },
        builds: catalog.builds.map((build) =>
          Object.assign({}, build, {
            images: Object.fromEntries(
              Object.entries(build.images).map(([name, asset]) => {
                const url = `/local-assets/${build.id}/${asset.fileName}`;
                files.set(url, {
                  path: resolve(config.root, options.imageRoot, build.id, asset.fileName),
                  bytes: asset.bytes,
                });
                return [name, { ...asset, url }];
              }),
            ),
          }),
        ),
      });
    },

    configureServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
