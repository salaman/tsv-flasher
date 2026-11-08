import type { FirmwareBuild } from "./catalog.ts";

export interface Asset {
  id: string;
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface ImageAsset extends Asset {
  fileName: string;
  format: "raw" | "android-sparse";
}

export type InstallMode = "update" | "clean";
export type BootMode = "preserve-lk2nd" | "complete";
export type WipePartitionName = "userdata" | "cache" | "oem";

export interface WipeAsset extends ImageAsset {
  id: WipePartitionName;
  format: "android-sparse";
  expandedBytes: number;
  expandedSha256: string;
  partitionSha256: string;
}

// Catalogs cannot change hardware identity, write permissions, or stock geometry.
export const deviceProfile = {
  id: "lenovo-cd-18781y-stock-v1",
  name: "Lenovo ThinkSmart View CD-18781Y",
  vendorId: 0x05c6,
  productId: 0x9008,
  hardwareId: "000660e160008000",
  oemKeyHash: "b9eca30dfea4693497b6ac7eec81d006967281e259eb9ac239f9ce6dabb70c14",
  sectorBytes: 512,
  systemStartSector: 923648n,
  maxDiskSectors: 64n * 1024n * 1024n,
  partitions: [
    { name: "boot", firstLba: 790528n, bytes: 33554432 },
    { name: "system", firstLba: 923648n, bytes: 1610612736 },
    { name: "vendor", firstLba: 4069376n, bytes: 402653184 },
    { name: "cache", firstLba: 4980736n, bytes: 132120576 },
    { name: "userdata", firstLba: 6890512n, bytes: 4290223616 },
    { name: "oem", firstLba: 5307456n, bytes: 104857600 },
  ],
} as const;

// This is the previously used Lenovo programmer, pinned before any RAM upload.
export const programmerPin = {
  bytes: 377196,
  sha256: "04e7f2f9495a2e7c70848a3587ee6336c9ab58e27f3153c1513a83d79133f5c6",
};

export const LK2ND_PREFIX_BYTES = 512 * 1024;

// Core images precede Android boot. Individually selected wipes may be added;
// catalog data cannot expand this policy.
export const writePartitionNames = ["vendor", "system", "boot"] as const;
export const wipePartitionNames = ["userdata", "cache", "oem"] as const;
const cleanInstallPartitionNames = [
  "vendor",
  "system",
  "userdata",
  "cache",
  "oem",
  "boot",
] as const;
export type WritePartitionName = (typeof cleanInstallPartitionNames)[number];

export function installPartitionNames(mode: InstallMode) {
  if (mode === "update") {
    return writePartitionNames;
  }
  if (mode === "clean") {
    return cleanInstallPartitionNames;
  }
  throw new Error(`Unsupported installation mode: ${mode}.`);
}

/** Validate membership independently of catalog data and preserve canonical write order. */
export function selectedPartitionNames(
  mode: InstallMode,
  names: readonly WritePartitionName[],
  allowEmpty = false,
): WritePartitionName[] {
  const allowed = installPartitionNames(mode);
  if (
    (!allowEmpty && names.length === 0) ||
    new Set(names).size !== names.length ||
    names.some((name) => !allowed.some((entry) => entry === name))
  ) {
    throw new Error("Select a valid, non-duplicated set of allowed Android partitions.");
  }
  return allowed.filter((name) => names.some((entry) => entry === name));
}

export function validateBootMode(mode: BootMode): void {
  if (mode !== "preserve-lk2nd" && mode !== "complete") {
    throw new Error(`Unsupported boot image mode: ${mode}.`);
  }
}

export function matchingBackupPartitions(
  build: FirmwareBuild | null,
  mode: BootMode,
  backups: readonly {
    name: string;
    bytes: number;
    sha256: string;
    androidWindowSha256?: string;
    lk2ndValidated?: boolean;
  }[],
): WritePartitionName[] {
  validateBootMode(mode);
  return cleanInstallPartitionNames.filter((name) => {
    if (!build) {
      return false;
    }
    const backup = backups.find((entry) => entry.name === name);
    if (!backup || backup.bytes !== partitionPolicy(name).bytes) {
      return false;
    }
    if (name === "boot" && mode === "preserve-lk2nd") {
      return (
        backup.lk2ndValidated === true &&
        backup.androidWindowSha256 === build.bootPayload.windowSha256
      );
    }
    const image = build.images[name];
    const hash = image.format === "android-sparse" ? image.partitionSha256 : image.sha256;
    return backup.sha256 === hash;
  });
}

export function partitionsWithoutBackup(
  names: readonly WritePartitionName[],
  backups: readonly { name: string }[],
): WritePartitionName[] {
  return names.filter((name) => !backups.some((backup) => backup.name === name));
}

export function wipeImagesAvailable(build: FirmwareBuild | null): boolean {
  return (
    build !== null &&
    wipePartitionNames.every((name) => build.images[name].format === "android-sparse")
  );
}

export function partitionPolicy(name: WritePartitionName) {
  if (!cleanInstallPartitionNames.some((allowed) => allowed === name)) {
    throw new Error(`Partition ${name} is not in the Android write allowlist.`);
  }
  const partition = deviceProfile.partitions.find((entry) => entry.name === name);
  if (!partition) {
    throw new Error(`No device policy for partition ${name}.`);
  }
  return partition;
}
