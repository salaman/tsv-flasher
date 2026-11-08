import {
  deviceProfile,
  installPartitionNames,
  LK2ND_PREFIX_BYTES,
  partitionPolicy,
  programmerPin,
  wipePartitionNames,
  type Asset,
  type ImageAsset,
  type WipeAsset,
  type WritePartitionName,
} from "./profile.ts";

export type FirmwareImage = (ImageAsset & { format: "raw" }) | WipeAsset;

export interface FirmwareBuild {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly date: string;
  readonly sourceRevision: string;
  readonly description: string;
  readonly dtbBytes: number;
  readonly dtbSha256: string;
  readonly bootPayload: {
    readonly bytes: number;
    readonly sha256: string;
    readonly windowSha256: string;
  };
  readonly images: Readonly<Record<WritePartitionName, FirmwareImage>>;
}

export interface Catalog {
  readonly schemaVersion: 1;
  readonly device: string;
  readonly programmer: Asset & { fileName: string };
  readonly builds: readonly FirmwareBuild[];
}

export const MAX_MANIFEST_BYTES = 256 * 1024;

export function parseManifestUrl(value: string): URL {
  const message =
    "Manifest URL must be absolute HTTPS (or loopback HTTP), without credentials, queries or fragments.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(message);
  }
  return url;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be nonempty text of at most ${maximum} characters.`);
  }
  return value;
}

function integer(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no larger than ${maximum}.`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 96);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result) || result.includes("..")) {
    throw new Error(`${label} must be a safe filename or build identifier.`);
  }
  return result;
}

function assetUrl(value: unknown, base: URL): string {
  const url = new URL(text(value, "Asset URL", 2048), base);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.origin !== base.origin ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Assets must use the manifest's HTTPS origin, without credentials or URL tokens.",
    );
  }
  return url.href;
}

function image(value: unknown, name: WritePartitionName, base: URL): FirmwareImage {
  const source = object(value, `${name} image`);
  const fileName = identifier(source.fileName, `${name} filename`);
  const bytes = integer(source.bytes, `${name} download size`, partitionPolicy(name).bytes);
  const asset = {
    id: name,
    name: fileName,
    fileName,
    url: assetUrl(source.url, base),
    bytes,
    sha256: hash(source.sha256, `${name} SHA-256`),
  };

  if (name === "userdata" || name === "cache" || name === "oem") {
    const expandedBytes = integer(
      source.expandedBytes,
      `${name} expanded size`,
      partitionPolicy(name).bytes,
    );
    if (
      source.format !== "android-sparse" ||
      bytes > 16 * 1024 * 1024 ||
      expandedBytes % 512 !== 0 ||
      partitionPolicy(name).bytes - expandedBytes >= 4096
    ) {
      throw new Error(`${name} requires a bounded sparse filesystem matching the stock partition.`);
    }
    return Object.freeze({
      ...asset,
      id: name,
      format: "android-sparse",
      expandedBytes,
      expandedSha256: hash(source.expandedSha256, `${name} expanded SHA-256`),
      partitionSha256: hash(source.partitionSha256, `${name} full-partition SHA-256`),
    });
  }

  if (source.format !== "raw" || bytes !== partitionPolicy(name).bytes) {
    throw new Error(`${name} requires a raw image covering its exact stock partition.`);
  }
  return Object.freeze({ ...asset, format: "raw" });
}

function build(value: unknown, base: URL): FirmwareBuild {
  const source = object(value, "Build");
  const date = text(source.date, "Build date", 10);
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== date
  ) {
    throw new Error("Build dates must be valid YYYY-MM-DD dates.");
  }

  const images = object(source.images, "Build images");
  const allowed = installPartitionNames("clean");
  if (
    Object.keys(images).length !== allowed.length ||
    Object.keys(images).some((name) => !allowed.some((allowedName) => allowedName === name))
  ) {
    throw new Error("Builds must contain exactly boot, system, vendor, userdata, cache and oem.");
  }
  const payload = object(source.bootPayload, "Boot payload");
  const sourceRevision = text(source.sourceRevision, "Source revision", 40);
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) {
    throw new Error("Source revisions must be full lowercase Git commit hashes.");
  }
  return Object.freeze({
    id: identifier(source.id, "Build ID"),
    name: text(source.name, "Build name"),
    version: text(source.version, "Build version", 80),
    date,
    sourceRevision,
    description: text(source.description, "Build description", 400),
    dtbBytes: integer(source.dtbBytes, "DTB size", 1024 * 1024),
    dtbSha256: hash(source.dtbSha256, "DTB SHA-256"),
    bootPayload: Object.freeze({
      bytes: integer(
        payload.bytes,
        "Boot payload size",
        partitionPolicy("boot").bytes - LK2ND_PREFIX_BYTES,
      ),
      sha256: hash(payload.sha256, "Boot payload SHA-256"),
      windowSha256: hash(payload.windowSha256, "Android boot window SHA-256"),
    }),
    images: Object.freeze({
      boot: image(images.boot, "boot", base),
      system: image(images.system, "system", base),
      vendor: image(images.vendor, "vendor", base),
      userdata: image(images.userdata, "userdata", base),
      cache: image(images.cache, "cache", base),
      oem: image(images.oem, "oem", base),
    }),
  });
}

/** Treat catalog data as untrusted; it cannot change the programmer or device write policy. */
export function parseCatalog(value: unknown, manifestUrl: string): Catalog {
  const source = object(value, "Manifest");
  if (source.schemaVersion !== 1 || source.device !== deviceProfile.id) {
    throw new Error("The manifest schema or target device is unsupported.");
  }
  if (!Array.isArray(source.builds) || source.builds.length === 0 || source.builds.length > 100) {
    throw new Error("The manifest must contain between 1 and 100 builds.");
  }
  const base = parseManifestUrl(manifestUrl);
  const programmer = object(source.programmer, "Programmer");
  if (programmer.bytes !== programmerPin.bytes || programmer.sha256 !== programmerPin.sha256) {
    throw new Error("The manifest programmer does not match the application's trusted programmer.");
  }
  const builds = source.builds.map((entry) => build(entry, base));
  if (new Set(builds.map((entry) => entry.id)).size !== builds.length) {
    throw new Error("Build IDs must be unique.");
  }
  builds.sort(
    (left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id),
  );
  return Object.freeze({
    schemaVersion: 1,
    device: deviceProfile.id,
    programmer: Object.freeze({
      id: "programmer",
      name: "Lenovo MSM8953 eMMC Firehose programmer",
      fileName: identifier(programmer.fileName, "Programmer filename"),
      url: assetUrl(programmer.url, base),
      ...programmerPin,
    }),
    builds: Object.freeze(builds),
  });
}

export function wipeAssets(selected: FirmwareBuild): WipeAsset[] {
  return wipePartitionNames
    .map((name) => selected.images[name])
    .filter((asset): asset is WipeAsset => asset.format === "android-sparse");
}
