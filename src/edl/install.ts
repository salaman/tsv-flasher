import { sha256 } from "@noble/hashes/sha2.js";
import {
  LK2ND_PREFIX_BYTES,
  installPartitionNames,
  selectedPartitionNames,
  partitionPolicy,
  type InstallMode,
  type WipePartitionName,
  type WritePartitionName,
} from "../../shared/profile";
import type { FirmwareBuild } from "../../shared/catalog";
import { dataView, hex } from "./diagnostics";
import { FILE_CHUNK_BYTES, hashFile, writeFile, type ByteProgress } from "./files";
import type { GptInfo, Partition } from "./gpt";
import type { SectorReader } from "./firehose";

export interface InstallTarget {
  name: WritePartitionName;
  partition: Partition;
  file: File;
  sha256: string;
}

/** Resolve the selected mode's pinned GPT ranges; images cannot grant write access. */
export function installPartitions(
  gpt: GptInfo,
  mode: InstallMode = "update",
  names: readonly WritePartitionName[] = installPartitionNames(mode),
): (Partition & { name: WritePartitionName })[] {
  if (!gpt.capacityConfirmed || !gpt.layoutMatches) {
    throw new Error(
      "Installation requires storage-confirmed capacity and compatible GPT geometry.",
    );
  }

  return selectedPartitionNames(mode, names).map((name) => {
    const matches = gpt.partitions.filter((partition) => partition.name === name);
    const partition = matches[0];
    const policy = partitionPolicy(name);
    if (
      matches.length !== 1 ||
      !partition ||
      partition.firstLba !== policy.firstLba ||
      partition.bytes !== BigInt(policy.bytes)
    ) {
      throw new Error(`The live ${name} partition does not match the pinned stock layout.`);
    }
    return Object.assign({}, partition, { name });
  });
}

/** Stock OEM may need formatting on first install; inspect without modifying it. */
export async function inspectOemFilesystem(reader: SectorReader, gpt: GptInfo): Promise<boolean> {
  const matches = gpt.partitions.filter((partition) => partition.name.toLowerCase() === "oem");
  const oem = matches[0];
  if (matches.length !== 1 || !oem || oem.bytes < 2048n) {
    throw new Error("A unique OEM partition is required for Android metadata.");
  }
  const bytes = await reader.readSectors(oem.firstLba + 2n, 2);
  if (bytes.length !== 1024) {
    throw new Error("OEM metadata superblock read was incomplete.");
  }
  const header = dataView(bytes);
  return header.getUint16(56, true) === 0xef53 && Boolean(header.getUint32(96, true) & 0x40);
}

/** Ignore the generic bundle's loader; retain only its separately pinned Android payload. */
export async function extractBootPayload(
  file: File,
  build: FirmwareBuild,
  signal: AbortSignal,
): Promise<File> {
  if (file.size !== partitionPolicy("boot").bytes) {
    throw new Error("Generic boot bundle has an incorrect physical partition length.");
  }
  const payload = new File(
    [file.slice(LK2ND_PREFIX_BYTES, LK2ND_PREFIX_BYTES + build.bootPayload.bytes)],
    "boot-payload.img",
  );
  if ((await hashFile(payload, signal)) !== build.bootPayload.sha256) {
    throw new Error("The generic boot bundle's Android payload does not match the pinned build.");
  }
  await validateBootPayload(payload, build, signal);
  return payload;
}

/** A reset needs a full-size prepared filesystem, not zeros or a sparse-file header. */
export async function validateWipeImage(
  file: File,
  name: WipePartitionName,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (file.size !== partitionPolicy(name).bytes) {
    throw new Error(`The ${name} wipe image must cover its exact stock partition.`);
  }

  const header = dataView(new Uint8Array(await file.slice(1024, 2048).arrayBuffer()));
  signal.throwIfAborted();
  const blockShift = header.getUint32(24, true);
  const incompat = header.getUint32(96, true);
  const readOnlyFeatures = header.getUint32(100, true);
  if (header.getUint16(56, true) !== 0xef53 || blockShift > 2 || !(incompat & 0x40)) {
    throw new Error(`The ${name} wipe image is not a supported raw ext4 filesystem.`);
  }

  const blockBytes = 1024n << BigInt(blockShift);
  const blocks =
    BigInt(header.getUint32(4, true)) +
    ((incompat & 0x80 ? BigInt(header.getUint32(336, true)) : 0n) << 32n);
  const filesystemBytes = blocks * blockBytes;
  const slack = BigInt(file.size) - filesystemBytes;
  if (blocks === 0n || slack < 0n || slack >= blockBytes) {
    throw new Error(`The ${name} ext4 filesystem does not fill its stock partition.`);
  }
  if (name === "userdata" && (!(incompat & 0x10000) || !(readOnlyFeatures & 0x8000))) {
    throw new Error("Userdata must be prepared with ext4 encryption and verity features.");
  }
}

/** Validate the installed loader header before preserving its exact reserved prefix. */
export function validateLk2nd(prefix: Uint8Array): string {
  if (prefix.length !== LK2ND_PREFIX_BYTES) {
    throw new Error("A complete 512 KiB live lk2nd prefix is required.");
  }
  const view = dataView(prefix);
  const page = view.getUint32(36, true);
  const commandBytes = prefix.subarray(64, 576);
  const terminator = commandBytes.indexOf(0);
  const commandLine = new TextDecoder("utf-8", { fatal: true })
    .decode(terminator < 0 ? commandBytes : commandBytes.subarray(0, terminator))
    ?.trim()
    .split(/\s+/)[0];

  if (
    new TextDecoder().decode(prefix.subarray(0, 8)) !== "ANDROID!" ||
    commandLine !== "lk2nd" ||
    ![2048, 4096].includes(page) ||
    view.getUint32(8, true) === 0
  ) {
    throw new Error("The live boot partition does not contain a supported installed lk2nd.");
  }

  const aligned = (bytes: number) => Math.ceil(bytes / page) * page;
  const loaderEnd =
    page + [8, 16, 24, 40].reduce((sum, offset) => sum + aligned(view.getUint32(offset, true)), 0);
  if (loaderEnd > LK2ND_PREFIX_BYTES) {
    throw new Error("The installed lk2nd exceeds its reserved 512 KiB prefix.");
  }
  return hex(sha256(prefix));
}

/** Port the native bundle's v0/gzip/ARM64/DTB/LZ4 checks without inflating the whole kernel. */
export async function validateBootPayload(
  file: File,
  build: FirmwareBuild,
  signal: AbortSignal,
): Promise<void> {
  const bootBytes = partitionPolicy("boot").bytes;
  if (file.size < 2048 || file.size > bootBytes - LK2ND_PREFIX_BYTES) {
    throw new Error("Android boot payload does not fit the lk2nd boot window.");
  }

  const header = new Uint8Array(await file.slice(0, 2048).arrayBuffer());
  const view = dataView(header);
  const kernelBytes = view.getUint32(8, true);
  const ramdiskBytes = view.getUint32(16, true);
  const page = view.getUint32(36, true);
  const align = (bytes: number) => Math.ceil(bytes / page) * page;

  if (
    new TextDecoder().decode(header.subarray(0, 8)) !== "ANDROID!" ||
    page !== 2048 ||
    view.getUint32(40, true) !== 0 ||
    view.getUint32(24, true) !== 0 ||
    !kernelBytes ||
    !ramdiskBytes ||
    file.size !== page + align(kernelBytes) + align(ramdiskBytes) ||
    kernelBytes <= build.dtbBytes
  ) {
    throw new Error("Expected the pinned lk2nd-compatible Android v0 boot payload.");
  }

  const dtbStart = page + kernelBytes - build.dtbBytes;
  const dtb = new Uint8Array(await file.slice(dtbStart, page + kernelBytes).arrayBuffer());
  const dtbView = dataView(dtb);
  if (
    dtbView.getUint32(0) !== 0xd00dfeed ||
    dtbView.getUint32(4) !== dtb.length ||
    hex(sha256(dtb)) !== build.dtbSha256
  ) {
    throw new Error("The appended boot DTB does not match the pinned ThinkSmart device tree.");
  }

  const compressed = file.slice(page, dtbStart).stream();
  const reader = compressed.pipeThrough(new DecompressionStream("gzip")).getReader();
  const armHeader = new Uint8Array(64);
  let expanded = 0;

  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (expanded < armHeader.length) {
        armHeader.set(value.subarray(0, armHeader.length - expanded), expanded);
      }
      expanded += value.length;
      if (expanded > 50 * 1024 * 1024) {
        throw new Error("The expanded ARM64 kernel exceeds the supported boot window.");
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  const arm = dataView(armHeader);
  const imageBytes = arm.getBigUint64(16, true);
  if (
    expanded < 64 ||
    hex(armHeader.subarray(56, 60)) !== "41524d64" ||
    imageBytes === 0n ||
    arm.getBigUint64(8, true) + (imageBytes > BigInt(expanded) ? imageBytes : BigInt(expanded)) >
      50n * 1024n * 1024n
  ) {
    throw new Error("The gzip kernel is not a supported bounded ARM64 image.");
  }

  const ramdiskOffset = page + align(kernelBytes);
  const ramdisk = new Uint8Array(await file.slice(ramdiskOffset, ramdiskOffset + 4).arrayBuffer());
  if (![0x184c2102, 0x184d2204].includes(dataView(ramdisk).getUint32(0, true))) {
    throw new Error("The Android boot ramdisk is not in the expected LZ4 format.");
  }
  signal.throwIfAborted();
}

/** Compose a full hashable boot image, but the flash engine never rewrites its lk2nd prefix. */
export async function composeBoot(
  directory: FileSystemDirectoryHandle,
  prefix: Uint8Array,
  payload: File,
  build: FirmwareBuild,
  signal: AbortSignal,
  onProgress: ByteProgress,
): Promise<{ file: File; sha256: string }> {
  validateLk2nd(prefix);
  await validateBootPayload(payload, build, signal);
  const total = partitionPolicy("boot").bytes;
  const digest = sha256.create();
  const handle = await directory.getFileHandle("boot-composed.img", { create: true });

  const file = await writeFile(handle, async (writer) => {
    digest.update(prefix);
    await writer.write(prefix.slice().buffer);
    let written = prefix.length;

    for (let offset = 0; offset < payload.size; offset += FILE_CHUNK_BYTES) {
      signal.throwIfAborted();
      const bytes = await payload.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer();
      digest.update(new Uint8Array(bytes));
      await writer.write(bytes);
      written += bytes.byteLength;
      onProgress(written, total);
    }

    // Explicit zeros make the final partition hash independent of old boot slack.
    const zeros = new Uint8Array(FILE_CHUNK_BYTES);
    while (written < total) {
      signal.throwIfAborted();
      const count = Math.min(zeros.length, total - written);
      digest.update(zeros.subarray(0, count));
      await writer.write(zeros.slice(0, count).buffer);
      written += count;
      onProgress(written, total);
    }
    signal.throwIfAborted();
  });

  if (file.size !== total) {
    throw new Error("Composed boot image has an incorrect physical partition length.");
  }
  const expected = hex(digest.digest());
  if ((await hashFile(file, signal, onProgress)) !== expected) {
    throw new Error(
      "Saved boot composition differs from its exact prefix, payload, or zero padding.",
    );
  }
  return { file, sha256: expected };
}
