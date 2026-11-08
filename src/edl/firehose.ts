import {
  deviceProfile,
  LK2ND_PREFIX_BYTES,
  installPartitionNames,
  selectedPartitionNames,
  validateBootMode,
  partitionPolicy,
  type InstallMode,
  type BootMode,
  type WritePartitionName,
} from "../../shared/profile";
import { describeError, type Logger } from "./diagnostics";
import type { UsbTransport } from "./usb";

export interface StorageInfo {
  fields: Record<string, string>;
  totalSectors: bigint | null;
  sectorBytes: number | null;
  memoryName: string | null;
}

interface Reply {
  response: Element;
  logs: string[];
}

function positiveInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid Firehose ${field}: ${value}.`);
  }

  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Invalid Firehose ${field}: ${value}.`);
  }

  return number;
}

export interface SectorReader {
  readSectors(start: bigint, count: number): Promise<Uint8Array>;
}

export class Firehose implements SectorReader {
  #usb: UsbTransport;
  #log: Logger;
  #payloadBytes = 4096;
  #configured = false;
  #totalSectors: bigint | null = null;
  #writePayloadBytes = 4096;
  #writesEnabled = false;
  #writePartitions: readonly WritePartitionName[] = [];
  #bootMode: BootMode = "preserve-lk2nd";

  constructor(usb: UsbTransport, log: Logger) {
    this.#usb = usb;
    this.#log = log;
  }

  // Callers cannot send arbitrary XML, erase, patch, or address another physical partition.
  async #command(
    name: "configure" | "getstorageinfo" | "read" | "program" | "power",
    attributes: Record<string, string>,
    isExpected: (response: Element) => boolean = () => true,
  ): Promise<Reply> {
    const xmlAttributes = Object.entries(attributes)
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[<>&"']/.test(value)) {
          throw new Error("Invalid internally generated Firehose attribute.");
        }
        return `${key}="${value}"`;
      })
      .join(" ");

    const xml = `<?xml version="1.0" ?><data><${name} ${xmlAttributes}/></data>`;

    this.#log(
      "info",
      "Firehose",
      `Sending ${name}: ${Object.entries(attributes)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}.`,
    );

    // Some programmers send another log after an ACK before accepting OUT.
    // Arm IN first to avoid blocking both sides, but require both the completed
    // write and the expected protocol ACK before advancing the session.
    const received = this.#reply(isExpected);
    const sent = this.#usb.write(new TextEncoder().encode(xml));

    try {
      const [, reply] = await Promise.all([sent, received]);
      return reply;
    } catch (error) {
      // A failed half of this exchange must not leave the other transfer alive.
      const [closed] = await Promise.allSettled([this.#usb.close(), sent, received]);
      if (closed.status === "rejected") {
        this.#log("error", "USB", `Firehose cleanup failed: ${describeError(closed.reason)}.`);
      }
      throw error;
    }
  }

  /** Logs can precede an ACK in separate documents; consume them without losing raw data. */
  async #reply(isExpected: (response: Element) => boolean = () => true): Promise<Reply> {
    const logs: string[] = [];

    for (let documents = 0; documents < 256; documents++) {
      const xml = await this.#usb.readXml();
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
        throw new Error("Unexpected Firehose XML declaration.");
      }

      const document = new DOMParser().parseFromString(xml, "application/xml");
      if (document.querySelector("parsererror") || document.documentElement.tagName !== "data") {
        throw new Error("Malformed Firehose XML document.");
      }

      for (const element of document.documentElement.children) {
        if (element.tagName === "log") {
          const message = element.getAttribute("value");
          if (message === null || message.length > 8192) {
            throw new Error("Invalid or oversized Firehose log document.");
          }

          logs.push(message);
          this.#log("info", "Device", message);
        } else if (element.tagName !== "response") {
          throw new Error(`Unexpected Firehose element: ${element.tagName}.`);
        }
      }
      const responses = document.getElementsByTagName("response");
      if (responses.length > 1) {
        throw new Error("Ambiguous Firehose response document.");
      }

      const response = responses.item(0);
      if (!response) {
        continue;
      }

      if (response.getAttribute("value") !== "ACK") {
        throw new Error(
          `Firehose did not acknowledge the command: ${response.getAttribute("value") ?? "missing value"}. ${logs.slice(-4).join(" ")}`,
        );
      }

      if (isExpected(response)) {
        return { response, logs };
      }

      this.#log(
        "warning",
        "Firehose",
        "Ignoring an unsolicited startup ACK without configuration attributes.",
      );
    }

    throw new Error("Firehose exceeded the response-document budget.");
  }

  /** Request eMMC with SkipWrite as defense in depth; never negotiate a storage-type fallback. */
  async configure(): Promise<void> {
    await this.#configure(false);
  }

  /** Only the explicitly confirmed flash operation may leave read-only mode. */
  async enableWrites(
    mode: InstallMode = "update",
    names: readonly WritePartitionName[] = installPartitionNames(mode),
    bootMode: BootMode = "preserve-lk2nd",
  ): Promise<void> {
    const partitions = selectedPartitionNames(mode, names);
    validateBootMode(bootMode);
    if (!this.#configured || this.#totalSectors === null) {
      throw new Error("Verified live eMMC geometry is required before enabling writes.");
    }
    await this.#configure(true);
    this.#writePartitions = partitions;
    this.#bootMode = bootMode;
  }

  async #configure(writable: boolean): Promise<void> {
    this.#writesEnabled = false;
    this.#writePartitions = [];
    this.#bootMode = "preserve-lk2nd";
    const requestedPayload = 1024 * 1024;

    // The programmer may emit a startup ACK. Configuration must be identified
    // by its negotiated payload attribute, not merely the first ACK received.
    const { response } = await this.#command(
      "configure",
      {
        MemoryName: "eMMC",
        Verbose: "0",
        AlwaysValidate: "0",
        MaxDigestTableSizeInBytes: "2048",
        MaxPayloadSizeToTargetInBytes: String(requestedPayload),
        ZLPAwareHost: "1",
        SkipStorageInit: "0",
        SkipWrite: writable ? "0" : "1",
      },
      (element) => element.hasAttribute("MaxPayloadSizeToTargetInBytes"),
    );

    const memory = response.getAttribute("MemoryName");
    if (memory !== null && memory.toLowerCase() !== "emmc") {
      throw new Error(`Programmer reported ${memory}; this inspector supports only eMMC.`);
    }

    this.#writePayloadBytes = positiveInteger(
      response.getAttribute("MaxPayloadSizeToTargetInBytes") ?? "",
      "MaxPayloadSizeToTargetInBytes",
    );
    if (
      this.#writePayloadBytes < 512 ||
      this.#writePayloadBytes > requestedPayload ||
      this.#writePayloadBytes % 512 !== 0
    ) {
      throw new Error("Firehose negotiated an unsupported write payload size.");
    }

    const payload = response.getAttribute("MaxPayloadSizeFromTargetInBytes");
    if (payload !== null) {
      this.#payloadBytes = positiveInteger(payload, "MaxPayloadSizeFromTargetInBytes");
      if (
        this.#payloadBytes > 1024 * 1024 ||
        this.#payloadBytes < 512 ||
        this.#payloadBytes % 512 !== 0
      ) {
        throw new Error("Firehose negotiated an unsupported read payload size.");
      }
    } else {
      this.#payloadBytes = 4096;
      this.#log(
        "warning",
        "Firehose",
        "Read payload size was not reported; using bounded 4096-byte inspection reads.",
      );
    }

    this.#configured = true;
    this.#writesEnabled = writable;
    this.#log(
      "info",
      "Firehose",
      writable
        ? "eMMC write mode acknowledged for the confirmed installation."
        : "eMMC read-only configuration acknowledged (SkipWrite=1).",
    );
  }

  /** Normalize known storage-report formats while keeping unavailable geometry explicit. */
  async storageInfo(): Promise<StorageInfo> {
    if (!this.#configured) {
      throw new Error("Firehose must be configured before inspecting storage.");
    }

    const { logs } = await this.#command("getstorageinfo", { physical_partition_number: "0" });

    // Older programmers log name:value fields; newer ones emit storage_info JSON.
    const fields: Record<string, string> = {};

    for (const line of logs) {
      const text = line.replace(/^INFO:\s*/, "").trim();

      if (text.startsWith("{")) {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || !("storage_info" in parsed)) {
          this.#log(
            "warning",
            "Firehose",
            "Unrecognized JSON storage report; retained in the diagnostic log.",
          );
          continue;
        }

        const info = parsed.storage_info;
        if (typeof info !== "object" || info === null || Array.isArray(info)) {
          throw new Error("Invalid JSON storage_info response.");
        }

        for (const [key, value] of Object.entries(info)) {
          if (typeof value === "number" || typeof value === "string") {
            fields[key] = String(value);
          }
        }
      } else {
        const match = /^([^:=]+)\s*[:=]\s*(.+)$/.exec(text);
        if (match?.[1] && match[2]) {
          fields[match[1].trim()] = match[2].trim();
        }
      }
    }

    // Do not turn a missing or differently sized block report into a guessed
    // capacity. GPT can still be inspected, but compatibility stays unconfirmed.
    const sectorValue = fields.page_size ?? fields.SECTOR_SIZE_IN_BYTES ?? fields.block_size;
    const sectorBytes = sectorValue ? positiveInteger(sectorValue, "sector size") : null;
    if (sectorBytes !== null && sectorBytes !== deviceProfile.sectorBytes) {
      throw new Error(
        `Storage geometry is ${sectorBytes} bytes, not the required 512-byte eMMC sectors.`,
      );
    }

    const totalValue = fields.total_blocks ?? fields["Total Logical Blocks"];
    const totalSectors =
      totalValue && sectorBytes === 512
        ? BigInt(positiveInteger(totalValue, "total blocks"))
        : null;

    if (
      totalSectors !== null &&
      (totalSectors < 4096n || totalSectors > deviceProfile.maxDiskSectors)
    ) {
      throw new Error("Reported disk size is outside the ThinkSmart inspection bounds.");
    }

    const memoryName = fields.mem_type ?? fields.MemoryName ?? null;
    if (memoryName !== null && memoryName.toLowerCase() !== "emmc") {
      throw new Error(`Unexpected storage type: ${memoryName}.`);
    }

    if (totalSectors === null || sectorBytes === null) {
      this.#log(
        "warning",
        "Firehose",
        "Storage geometry was not fully reported. GPT inspection remains bounded; installation compatibility cannot be confirmed.",
      );
    }

    this.#totalSectors = totalSectors;

    return { fields, totalSectors, sectorBytes, memoryName };
  }

  async #beginRead(start: bigint, count: number, maximumSectors: number): Promise<void> {
    if (
      !this.#configured ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > maximumSectors ||
      start < 0n ||
      start + BigInt(count) > (this.#totalSectors ?? deviceProfile.maxDiskSectors)
    ) {
      throw new Error("Read is outside the bounded eMMC inspection region.");
    }

    const initial = await this.#command("read", {
      SECTOR_SIZE_IN_BYTES: "512",
      num_partition_sectors: String(count),
      physical_partition_number: "0",
      start_sector: String(start),
    });

    if (initial.response.getAttribute("rawmode") !== "true") {
      throw new Error("Firehose did not acknowledge entering raw read mode.");
    }
  }

  async #finishRead(start: bigint, count: number): Promise<void> {
    const final = await this.#reply();
    if (final.response.getAttribute("rawmode") !== "false") {
      throw new Error("Firehose did not acknowledge completing the raw read.");
    }

    this.#log(
      "info",
      "Firehose",
      `Read verified by protocol ACK: ${count} sectors at LBA ${start}.`,
    );
  }

  /** Small inspection reads retain their allocation limit and negotiated payload size. */
  async readSectors(
    start: bigint,
    count: number,
    onProgress?: (bytes: number) => void,
  ): Promise<Uint8Array> {
    await this.#beginRead(start, count, 2048);

    const bytes = new Uint8Array(count * 512);
    for (let offset = 0; offset < bytes.length; offset += this.#payloadBytes) {
      bytes.set(
        await this.#usb.readExact(Math.min(this.#payloadBytes, bytes.length - offset)),
        offset,
      );
      onProgress?.(Math.min(offset + this.#payloadBytes, bytes.length));
    }

    await this.#finishRead(start, count);
    return bytes;
  }

  /** Stream one bounded device range, overlapping USB with at most one consumer write. */
  async readSectorsTo(
    start: bigint,
    count: number,
    consume: (bytes: Uint8Array<ArrayBuffer>, offset: number) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.#beginRead(start, count, Number(this.#totalSectors ?? 0n));

    let consumed = Promise.resolve();
    let incoming: Promise<Uint8Array<ArrayBuffer>> | undefined;

    try {
      const total = count * 512;
      const chunkBytes = 1024 * 1024;
      for (let offset = 0; offset < total; offset += chunkBytes) {
        signal.throwIfAborted();
        incoming = this.#usb.readRaw(Math.min(chunkBytes, total - offset));
        const [bytes] = await Promise.all([incoming, consumed]);
        signal.throwIfAborted();
        consumed = consume(bytes, offset);
      }

      await consumed;
      signal.throwIfAborted();
      await this.#finishRead(start, count);
    } catch (error) {
      // Neither a failed file write nor cancellation may leave a raw read active.
      const [closed] = await Promise.allSettled([this.#usb.close(), incoming, consumed]);
      if (closed.status === "rejected") {
        this.#log("error", "USB", `Bulk-read cleanup failed: ${describeError(closed.reason)}.`);
      }
      throw error;
    }
  }

  /** The protected boot prefix is writable only in explicitly enabled complete-boot mode. */
  async programSectors(
    name: WritePartitionName,
    offsetSectors: number,
    bytes: Uint8Array,
  ): Promise<void> {
    if (bytes.length > 1024 * 1024) {
      throw new Error("Program request is outside an explicitly enabled Android write region.");
    }

    await this.programSectorsFrom(name, offsetSectors, bytes.length / 512, async (offset, length) =>
      bytes.subarray(offset, offset + length),
    );
  }

  /** Stream one verified partition range without tying command size to buffer size. */
  async programSectorsFrom(
    name: WritePartitionName,
    offsetSectors: number,
    count: number,
    read: (offset: number, length: number) => Promise<Uint8Array>,
    signal?: AbortSignal,
    onProgress?: (bytes: number) => void,
  ): Promise<void> {
    signal?.throwIfAborted();
    const policy = partitionPolicy(name);
    const reserved =
      name === "boot" && this.#bootMode === "preserve-lk2nd" ? LK2ND_PREFIX_BYTES : 0;
    const capacitySectors = (policy.bytes - reserved) / 512;
    if (
      !this.#writesEnabled ||
      !this.#writePartitions.some((allowed) => allowed === name) ||
      this.#totalSectors === null ||
      !Number.isSafeInteger(offsetSectors) ||
      offsetSectors < 0 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      offsetSectors + count > capacitySectors
    ) {
      throw new Error("Program request is outside an explicitly enabled Android write region.");
    }

    const start = policy.firstLba + BigInt(reserved / 512 + offsetSectors);
    if (start + BigInt(count) > this.#totalSectors) {
      throw new Error("Program request exceeds live eMMC capacity.");
    }

    let sent: Promise<void> | undefined;
    let received: Promise<Reply> | undefined;

    try {
      const initial = await this.#command("program", {
        SECTOR_SIZE_IN_BYTES: "512",
        num_partition_sectors: String(count),
        physical_partition_number: "0",
        start_sector: String(start),
      });
      if (initial.response.getAttribute("rawmode") !== "true") {
        throw new Error("Firehose did not acknowledge entering raw write mode.");
      }

      const total = count * 512;
      for (let offset = 0; offset < total; offset += this.#writePayloadBytes) {
        signal?.throwIfAborted();
        const length = Math.min(this.#writePayloadBytes, total - offset);
        const bytes = await read(offset, length);
        signal?.throwIfAborted();
        if (bytes.length !== length) {
          throw new Error(`Staged ${name} returned an incomplete file chunk.`);
        }

        // Arm IN before the last payload, not for the entire multi-minute write:
        // the bounded USB read timeout must not run while no final ACK is due.
        if (offset + length === total) {
          received = this.#reply();
        }
        sent = (async () => {
          await this.#usb.writeRaw(bytes);
          await this.#usb.writeZlp();
        })();

        const [, final] = await Promise.all([sent, received]);
        if (final && final.response.getAttribute("rawmode") !== "false") {
          throw new Error("Firehose did not acknowledge completing the raw write.");
        }
        signal?.throwIfAborted();
        onProgress?.(offset + length);
      }
    } catch (error) {
      const [closed] = await Promise.allSettled([this.#usb.close(), sent, received]);
      if (closed.status === "rejected") {
        this.#log("error", "USB", `Raw-write cleanup failed: ${describeError(closed.reason)}.`);
      }
      throw error;
    }
  }

  /** The session allows this separate action only after acknowledged writes or no-write completion. */
  async reset(): Promise<void> {
    await this.#command("power", { value: "reset" });
  }
}
