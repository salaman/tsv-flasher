import { deviceProfile } from "../../shared/profile";
import { dataView, hex, type Logger } from "./diagnostics";
import type { SectorReader, StorageInfo } from "./firehose";

interface GptHeader {
  currentLba: bigint;
  alternateLba: bigint;
  firstUsable: bigint;
  lastUsable: bigint;
  diskGuid: string;
  entriesLba: bigint;
  entryCount: number;
  entryBytes: number;
  entriesCrc: number;
  headerCrc: number;
}

export interface Partition {
  index: number;
  name: string;
  typeGuid: string;
  uniqueGuid: string;
  firstLba: bigint;
  lastLba: bigint;
  attributes: bigint;
  bytes: bigint;
}

export interface GptInfo {
  primary: GptHeader;
  backup: GptHeader;
  totalSectors: bigint;
  capacityConfirmed: boolean;
  partitions: Partition[];
  layoutMatches: boolean;
  layoutNotes: string[];
}

/** Include the protective MBR and reserved entry-array space, never usable partitions. */
export function gptBackupRanges(
  gpt: GptInfo,
): { name: "gpt-primary" | "gpt-secondary"; startLba: bigint; sectorCount: number }[] {
  const primaryEnd =
    gpt.primary.entriesLba +
    BigInt(Math.max(32, Math.ceil((gpt.primary.entryCount * gpt.primary.entryBytes) / 512)));
  const secondaryStart = gpt.backup.entriesLba;
  const ranges = [
    { name: "gpt-primary" as const, startLba: 0n, sectorCount: Number(primaryEnd) },
    {
      name: "gpt-secondary" as const,
      startLba: secondaryStart,
      sectorCount: Number(gpt.totalSectors - secondaryStart),
    },
  ];

  if (
    !gpt.capacityConfirmed ||
    !gpt.layoutMatches ||
    gpt.primary.currentLba !== 1n ||
    gpt.backup.currentLba !== gpt.totalSectors - 1n ||
    primaryEnd > gpt.primary.firstUsable ||
    secondaryStart <= gpt.backup.lastUsable ||
    ranges.some(
      (range) =>
        !Number.isSafeInteger(range.sectorCount) ||
        range.sectorCount < 1 ||
        range.sectorCount > 2048 ||
        range.startLba < 0n ||
        range.startLba + BigInt(range.sectorCount) > gpt.totalSectors,
    )
  ) {
    throw new Error("GPT backup ranges exceed verified, bounded metadata regions.");
  }
  return ranges;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

// GPT stores the first three GUID fields little-endian and the remainder as bytes.
function decodeGuid(bytes: Uint8Array): string {
  const view = dataView(bytes);

  return [
    view.getUint32(0, true).toString(16).padStart(8, "0"),
    view.getUint16(4, true).toString(16).padStart(4, "0"),
    view.getUint16(6, true).toString(16).padStart(4, "0"),
    hex(bytes.subarray(8, 10)),
    hex(bytes.subarray(10, 16)),
  ].join("-");
}

/** Validate a header before trusting its disk locations or allocation sizes. */
function parseHeader(bytes: Uint8Array, expectedLba: bigint): GptHeader {
  const view = dataView(bytes);

  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== "EFI PART") {
    throw new Error(`GPT signature missing at LBA ${expectedLba}.`);
  }

  const size = view.getUint32(12, true);
  if (
    view.getUint32(8, true) !== 0x00010000 ||
    size < 92 ||
    size > 512 ||
    view.getUint32(20, true) !== 0
  ) {
    throw new Error(`Unsupported or malformed GPT header at LBA ${expectedLba}.`);
  }

  // UEFI calculates the header CRC with the CRC field itself set to zero.
  const copy = bytes.slice(0, size);
  const expectedCrc = view.getUint32(16, true);
  dataView(copy).setUint32(16, 0, true);
  if (crc32(copy) !== expectedCrc) {
    throw new Error(`GPT header CRC mismatch at LBA ${expectedLba}. No repair attempted.`);
  }

  const result: GptHeader = {
    currentLba: view.getBigUint64(24, true),
    alternateLba: view.getBigUint64(32, true),
    firstUsable: view.getBigUint64(40, true),
    lastUsable: view.getBigUint64(48, true),
    diskGuid: decodeGuid(bytes.subarray(56, 72)),
    entriesLba: view.getBigUint64(72, true),
    entryCount: view.getUint32(80, true),
    entryBytes: view.getUint32(84, true),
    entriesCrc: view.getUint32(88, true),
    headerCrc: expectedCrc,
  };

  // Even a CRC-valid device response cannot authorize unbounded allocations.
  const arrayBytes = result.entryCount * result.entryBytes;
  if (
    result.currentLba !== expectedLba ||
    result.alternateLba === expectedLba ||
    result.alternateLba < 1n ||
    result.alternateLba >= deviceProfile.maxDiskSectors ||
    result.firstUsable < 2n ||
    result.lastUsable < result.firstUsable ||
    result.lastUsable >= deviceProfile.maxDiskSectors ||
    bytes.subarray(56, 72).every((byte) => byte === 0) ||
    result.entryCount < 1 ||
    result.entryCount > 1024 ||
    result.entryBytes < 128 ||
    result.entryBytes > 1024 ||
    (result.entryBytes & (result.entryBytes - 1)) !== 0 ||
    arrayBytes > 1024 * 1024
  ) {
    throw new Error(`GPT fields exceed the supported inspection bounds at LBA ${expectedLba}.`);
  }

  // The 16 KiB minimum is reserved disk space, not the bytes covered by the
  // array CRC. Compact OEM tables can declare fewer entries within that space.
  const minimumReservedSectors = 16384n / 512n;
  const backupLba = expectedLba === 1n ? result.alternateLba : expectedLba;
  if (
    result.firstUsable < 2n + minimumReservedSectors ||
    backupLba - result.lastUsable - 1n < minimumReservedSectors
  ) {
    throw new Error(`GPT does not reserve 16 KiB for each entry array at LBA ${expectedLba}.`);
  }

  // Primary entries precede usable storage; backup entries follow it and must
  // end before the backup header. Neither copy may overlap a partition.
  const end = result.entriesLba + BigInt(Math.ceil(arrayBytes / 512));
  const placementValid =
    expectedLba === 1n
      ? result.entriesLba >= 2n &&
        end <= result.firstUsable &&
        result.lastUsable < result.alternateLba
      : result.entriesLba > result.lastUsable &&
        end <= expectedLba &&
        result.lastUsable < expectedLba;
  if (!placementValid) {
    throw new Error("GPT entry array overlaps headers or usable storage.");
  }

  return result;
}

/** Read only the bounded array declared by an already-validated GPT header. */
async function readEntries(firehose: SectorReader, table: GptHeader): Promise<Uint8Array> {
  const length = table.entryCount * table.entryBytes;

  const bytes = (await firehose.readSectors(table.entriesLba, Math.ceil(length / 512))).slice(
    0,
    length,
  );
  if (crc32(bytes) !== table.entriesCrc) {
    throw new Error(
      `GPT entry-array CRC mismatch at LBA ${table.entriesLba}. No repair attempted.`,
    );
  }

  return bytes;
}

/** Decode active entries, rejecting ambiguous identities and overlapping extents. */
function parsePartitions(bytes: Uint8Array, table: GptHeader): Partition[] {
  const result: Partition[] = [];
  const identifiers = new Set<string>();

  for (let index = 0; index < table.entryCount; index++) {
    const entry = bytes.subarray(index * table.entryBytes, (index + 1) * table.entryBytes);
    if (entry.subarray(0, 16).every((byte) => byte === 0)) {
      continue;
    }

    const view = dataView(entry);
    const firstLba = view.getBigUint64(32, true);
    const lastLba = view.getBigUint64(40, true);
    const uniqueGuid = decodeGuid(entry.subarray(16, 32));

    if (
      firstLba < table.firstUsable ||
      lastLba < firstLba ||
      lastLba > table.lastUsable ||
      entry.subarray(16, 32).every((byte) => byte === 0) ||
      identifiers.has(uniqueGuid)
    ) {
      throw new Error(`Invalid extent or duplicate/empty GUID in GPT entry ${index + 1}.`);
    }

    identifiers.add(uniqueGuid);

    // Names occupy 36 UTF-16LE code units, independent of any extended entry data.
    let nameEnd = 128;
    for (let offset = 56; offset < 128; offset += 2) {
      if (view.getUint16(offset, true) === 0) {
        nameEnd = offset;
        break;
      }
    }
    const name = new TextDecoder("utf-16le", { fatal: true }).decode(entry.subarray(56, nameEnd));
    const hasControlCharacter = Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });

    if (hasControlCharacter) {
      throw new Error(`Control character in GPT entry ${index + 1} name.`);
    }

    result.push({
      index: index + 1,
      name,
      typeGuid: decodeGuid(entry.subarray(0, 16)),
      uniqueGuid,
      firstLba,
      lastLba,
      attributes: view.getBigUint64(48, true),
      bytes: (lastLba - firstLba + 1n) * 512n,
    });
  }

  const ordered = [...result].sort((left, right) => Number(left.firstLba - right.firstLba));
  let previous: Partition | null = null;

  for (const partition of ordered) {
    if (previous && partition.firstLba <= previous.lastLba) {
      throw new Error(`GPT partitions ${previous.name} and ${partition.name} overlap.`);
    }

    previous = partition;
  }

  return result;
}

/** Verify both GPT copies before assessing the expected Android partition geometry. */
export async function inspectGpt(
  firehose: SectorReader,
  storage: StorageInfo,
  log: Logger,
): Promise<GptInfo> {
  const beginning = await firehose.readSectors(0n, 2);
  const mbr = dataView(beginning.subarray(0, 512));

  // Reject MBR-only and hybrid layouts instead of trying to reinterpret them.
  if (mbr.getUint16(510, true) !== 0xaa55) {
    throw new Error("Protective MBR signature is invalid.");
  }

  const protectiveEntries = [0, 1, 2, 3].filter(
    (index) => mbr.getUint8(446 + index * 16 + 4) === 0xee,
  );

  if (
    protectiveEntries.length !== 1 ||
    [0, 1, 2, 3].some((index) => ![0, 0xee].includes(mbr.getUint8(446 + index * 16 + 4)))
  ) {
    throw new Error("Missing or hybrid protective MBR; no layout repair will be attempted.");
  }

  const primary = parseHeader(beginning.subarray(512), 1n);
  const totalSectors = primary.alternateLba + 1n;

  if (storage.totalSectors !== null && totalSectors !== storage.totalSectors) {
    throw new Error("GPT backup location disagrees with the reported eMMC capacity.");
  }

  const protectiveOffset = 446 + protectiveEntries[0]! * 16;
  const protectiveSectors = mbr.getUint32(protectiveOffset + 12, true);

  // Like Linux's valid_pmbr, recognize the saturated OEM size marker without
  // treating it as disk capacity. GPT and live eMMC geometry remain authoritative.
  if (
    mbr.getUint32(protectiveOffset + 8, true) !== 1 ||
    (protectiveSectors !== 0xffffffff && BigInt(protectiveSectors) !== totalSectors - 1n)
  ) {
    throw new Error("Protective MBR extent disagrees with GPT disk geometry.");
  }

  if (protectiveSectors === 0xffffffff) {
    log(
      "info",
      "GPT",
      "Recognized the OEM protective-MBR 0xffffffff size marker; it is not used as disk capacity.",
    );
  }

  // Validate the backup header independently, then require the tables to agree
  // byte-for-byte. Matching CRCs alone do not establish mirror equality.
  const primaryEntries = await readEntries(firehose, primary);
  const backupBytes = await firehose.readSectors(primary.alternateLba, 1);
  const backup = parseHeader(backupBytes, primary.alternateLba);

  if (
    backup.alternateLba !== primary.currentLba ||
    backup.firstUsable !== primary.firstUsable ||
    backup.lastUsable !== primary.lastUsable ||
    backup.diskGuid !== primary.diskGuid ||
    backup.entryCount !== primary.entryCount ||
    backup.entryBytes !== primary.entryBytes ||
    backup.entriesCrc !== primary.entriesCrc
  ) {
    throw new Error("Primary and backup GPT headers disagree. No repair attempted.");
  }

  const backupEntries = await readEntries(firehose, backup);
  if (!primaryEntries.every((byte, index) => byte === backupEntries[index])) {
    throw new Error("Primary and backup GPT entry arrays disagree.");
  }

  // GPT validity and installation geometry are separate results. A valid
  // repartitioned device must not receive an Android compatibility badge.
  const rows = parsePartitions(primaryEntries, primary);
  const layoutNotes: string[] = [];

  for (const expected of deviceProfile.partitions) {
    const matching = rows.filter((partition) => partition.name === expected.name);
    if (
      matching.length !== 1 ||
      matching[0]?.bytes !== BigInt(expected.bytes) ||
      matching[0]?.firstLba !== expected.firstLba
    ) {
      layoutNotes.push(
        `Expected ${expected.name}: ${expected.bytes} bytes at stock LBA ${expected.firstLba}.`,
      );
    }
  }

  if (
    rows.find((partition) => partition.name === "system")?.firstLba !==
    deviceProfile.systemStartSector
  ) {
    layoutNotes.push(
      `Expected system to begin at stock Android LBA ${deviceProfile.systemStartSector}.`,
    );
  }
  const capacityConfirmed = storage.totalSectors !== null && storage.sectorBytes === 512;
  if (!capacityConfirmed) {
    layoutNotes.push("Live storage capacity/sector geometry was not fully reported.");
  }

  log(
    "info",
    "GPT",
    `Both header/entry-array CRCs and mirrored tables verified; ${rows.length} partitions. No GPT changes.`,
  );

  return {
    primary,
    backup,
    totalSectors,
    capacityConfirmed,
    partitions: rows,
    layoutMatches: layoutNotes.length === 0,
    layoutNotes,
  };
}
