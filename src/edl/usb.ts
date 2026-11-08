import type { Logger } from "./diagnostics";

const MAX_BUFFER_BYTES = 1024 * 1024;
const TRANSFER_BYTES = 64 * 1024;
const OUTPUT_CHUNK_BYTES = 16 * 1024;
const MAX_XML_BYTES = 256 * 1024;
const TIMEOUT_MS = 10000;

export interface UsbInfo {
  vendorId: number;
  productId: number;
  manufacturer: string | null;
  product: string | null;
  serial: string | null;
  configuration: number;
  interface: number;
  alternate: number;
  inputEndpoint: number;
  outputEndpoint: number;
  packetBytes: number;
}

/** Owns the claimed interface and preserves bytes across protocol message boundaries. */
export class UsbTransport {
  readonly info: UsbInfo;

  #device: USBDevice;
  #log: Logger;
  #buffer: Uint8Array = new Uint8Array();
  #closed = false;
  #busy = { in: false, out: false };
  #closePromise: Promise<void> | null = null;

  private constructor(device: USBDevice, info: UsbInfo, log: Logger) {
    this.#device = device;
    this.info = info;
    this.#log = log;
  }

  /** Discover one unambiguous EDL interface rather than assuming endpoint numbers. */
  static async open(device: USBDevice, log: Logger, signal: AbortSignal): Promise<UsbTransport> {
    signal.throwIfAborted();
    await device.open();
    signal.throwIfAborted();

    const candidates = device.configurations.flatMap((configuration) =>
      configuration.interfaces.flatMap((usbInterface) =>
        usbInterface.alternates.flatMap((alternate) => {
          const input = alternate.endpoints.filter(
            (endpoint) => endpoint.type === "bulk" && endpoint.direction === "in",
          );
          const output = alternate.endpoints.filter(
            (endpoint) => endpoint.type === "bulk" && endpoint.direction === "out",
          );
          const inputEndpoint = input[0];
          const outputEndpoint = output[0];

          if (
            alternate.interfaceClass !== 0xff ||
            input.length !== 1 ||
            output.length !== 1 ||
            !inputEndpoint ||
            !outputEndpoint
          ) {
            return [];
          }

          return [
            {
              configuration,
              usbInterface,
              alternate,
              input: inputEndpoint,
              output: outputEndpoint,
            },
          ];
        }),
      ),
    );

    const candidate = candidates[0];
    if (candidates.length !== 1 || !candidate) {
      throw new Error("Expected exactly one vendor-specific interface with a bulk IN/OUT pair.");
    }

    if (device.configuration?.configurationValue !== candidate.configuration.configurationValue) {
      await device.selectConfiguration(candidate.configuration.configurationValue);
      signal.throwIfAborted();
    }

    await device.claimInterface(candidate.usbInterface.interfaceNumber);
    signal.throwIfAborted();
    const claimedInterface = device.configuration?.interfaces.find(
      (usbInterface) => usbInterface.interfaceNumber === candidate.usbInterface.interfaceNumber,
    );
    if (!claimedInterface) {
      throw new Error("The claimed EDL interface is missing from the active configuration.");
    }

    // SET_INTERFACE can reset endpoint state and discard a queued ROM HELLO.
    // Preserve the current alternate when it already has the required endpoints.
    if (claimedInterface.alternate.alternateSetting !== candidate.alternate.alternateSetting) {
      await device.selectAlternateInterface(
        candidate.usbInterface.interfaceNumber,
        candidate.alternate.alternateSetting,
      );
    }
    signal.throwIfAborted();

    const info: UsbInfo = {
      vendorId: device.vendorId,
      productId: device.productId,
      manufacturer: device.manufacturerName,
      product: device.productName,
      serial: device.serialNumber,
      configuration: candidate.configuration.configurationValue,
      interface: candidate.usbInterface.interfaceNumber,
      alternate: candidate.alternate.alternateSetting,
      inputEndpoint: candidate.input.endpointNumber,
      outputEndpoint: candidate.output.endpointNumber,
      packetBytes: candidate.input.packetSize,
    };

    if (info.packetBytes < 1 || info.packetBytes > 1024) {
      throw new Error(`Unexpected bulk packet size: ${info.packetBytes}.`);
    }

    log(
      "info",
      "USB",
      `Claimed interface ${info.interface}, bulk IN ${info.inputEndpoint}, OUT ${info.outputEndpoint}.`,
    );

    return new UsbTransport(device, info, log);
  }

  /** A timeout poisons the session: cleanup must close USB before any new work. */
  async #transfer<T>(
    direction: "in" | "out",
    operation: () => Promise<T>,
    description: string,
  ): Promise<T> {
    if (this.#closed) {
      throw new Error("The USB session is closed.");
    }

    if (this.#busy[direction]) {
      throw new Error(`Concurrent USB ${direction.toUpperCase()} transfers are not permitted.`);
    }

    // The endpoints are independent. Keep one reader and one writer at most,
    // so Firehose can flush logs while the next command's OUT is pending.
    this.#busy[direction] = true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.#closed = true;
        reject(
          new Error(
            `${description} timed out. Disconnect and re-enter EDL; no command will be replayed.`,
          ),
        );
      }, TIMEOUT_MS);
    });

    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      clearTimeout(timer);
      this.#busy[direction] = false;
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.#write(bytes, OUTPUT_CHUNK_BYTES);
  }

  /** Raw Firehose payloads have a known length and need not use small protocol writes. */
  async writeRaw(bytes: Uint8Array): Promise<void> {
    if (bytes.length > MAX_BUFFER_BYTES) {
      throw new Error("Raw USB writes must not exceed 1 MiB.");
    }
    await this.#write(bytes, MAX_BUFFER_BYTES);
  }

  async #write(bytes: Uint8Array, transferBytes: number): Promise<void> {
    if (bytes.length === 0) {
      throw new Error("Refusing an empty protocol write.");
    }

    for (let offset = 0; offset < bytes.length; offset += transferBytes) {
      const chunk = bytes.slice(offset, offset + transferBytes);
      const result = await this.#transfer(
        "out",
        () => this.#device.transferOut(this.info.outputEndpoint, chunk.buffer),
        "USB OUT",
      );

      if (result.status !== "ok" || result.bytesWritten !== chunk.length) {
        throw new Error(
          `USB OUT failed: ${result.status}, ${result.bytesWritten}/${chunk.length} bytes.`,
        );
      }
    }

    this.#log(
      "debug",
      "USB",
      `OUT ${bytes.length} bytes; USB completion only, not a protocol acknowledgment.`,
    );
  }

  /** Firehose terminates each negotiated raw payload with a real empty OUT packet. */
  async writeZlp(): Promise<void> {
    const result = await this.#transfer(
      "out",
      () => this.#device.transferOut(this.info.outputEndpoint, new ArrayBuffer(0)),
      "USB OUT zero-length packet",
    );
    if (result.status !== "ok" || result.bytesWritten !== 0) {
      throw new Error("USB OUT zero-length packet failed.");
    }
  }

  async #receive(wanted: number, context: string, transferBytes = TRANSFER_BYTES): Promise<void> {
    // Round the host request to a USB packet boundary, but preserve surplus
    // bytes for the next Sahara packet, XML document, or raw read.
    const length = Math.min(
      transferBytes,
      Math.ceil(Math.max(wanted, 1) / this.info.packetBytes) * this.info.packetBytes,
    );

    this.#log("debug", "USB", `Requesting IN ${length} bytes while awaiting ${context}.`);

    const result = await this.#transfer(
      "in",
      () => this.#device.transferIn(this.info.inputEndpoint, length),
      `USB IN while awaiting ${context} (${length} bytes requested)`,
    );

    if (result.status !== "ok" || !result.data) {
      throw new Error(`USB IN failed: ${result.status}.`);
    }

    const incoming = new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    );

    if (this.#buffer.length + incoming.length > MAX_BUFFER_BYTES) {
      throw new Error("Device response exceeded the bounded USB receive buffer.");
    }

    if (this.#buffer.length === 0) {
      this.#buffer = incoming;
    } else {
      const combined = new Uint8Array(this.#buffer.length + incoming.length);
      combined.set(this.#buffer);
      combined.set(incoming, this.#buffer.length);
      this.#buffer = combined;
    }
    this.#log("debug", "USB", `IN ${incoming.length} bytes.`);
  }

  #take(length: number): Uint8Array {
    const bytes = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return bytes;
  }

  async readExact(length: number, context = "binary protocol data"): Promise<Uint8Array> {
    return this.#readExact(length, context, TRANSFER_BYTES);
  }

  /** Only known-length raw Firehose data may use large host requests, never XML replies. */
  async readRaw(length: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.#readExact(length, "raw Firehose data", MAX_BUFFER_BYTES);
  }

  async #readExact(
    length: number,
    context: string,
    transferBytes: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BUFFER_BYTES) {
      throw new Error(`Invalid bounded read length: ${length}.`);
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    let emptyReads = 0;
    while (offset < length) {
      if (this.#buffer.length === 0) {
        await this.#receive(length - offset, context, transferBytes);
        if (this.#buffer.length === 0) {
          if (++emptyReads > 32) {
            throw new Error("Device returned too many empty USB packets.");
          }
          continue;
        }
        emptyReads = 0;
      }

      const count = Math.min(this.#buffer.length, length - offset);
      bytes.set(this.#take(count), offset);
      offset += count;
    }

    return bytes;
  }

  /** Consume one XML document, leaving any following raw bytes buffered. */
  async readXml(): Promise<string> {
    const marker = new TextEncoder().encode("</data>");

    for (let packets = 0; packets <= 512; packets++) {
      const end = this.#buffer.findIndex((_byte, index) =>
        marker.every((byte, offset) => this.#buffer[index + offset] === byte),
      );

      if (end !== -1) {
        if (end + marker.length > MAX_XML_BYTES) {
          throw new Error("Firehose XML response exceeded 256 KiB.");
        }

        const document = this.#take(end + marker.length);

        // XML's optional line terminator is not part of the subsequent raw payload.
        if (this.#buffer[0] === 13 && this.#buffer[1] === 10) {
          this.#take(2);
        } else if (this.#buffer[0] === 10) {
          this.#take(1);
        }

        return new TextDecoder("utf-8", { fatal: true }).decode(document).replace(/^[\0\s]+/, "");
      }

      if (this.#buffer.length >= MAX_XML_BYTES) {
        throw new Error("Firehose XML response exceeded 256 KiB.");
      }

      // Control replies can end on a full USB packet without a ZLP. Asking for
      // 64 KiB would then wait for bytes the programmer will never send.
      await this.#receive(this.info.packetBytes, "Firehose XML");
    }

    throw new Error("Firehose response did not contain a complete XML document.");
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#buffer = new Uint8Array();

    // Closing the device also cancels outstanding WebUSB transfers.
    this.#closePromise ??= this.#device.opened ? this.#device.close() : Promise.resolve();
    return this.#closePromise;
  }
}
