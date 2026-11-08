import { deviceProfile } from "../../shared/profile";
import { dataView, hex, type Logger } from "./diagnostics";
import type { UsbTransport } from "./usb";

const commands = {
  helloRequest: 0x01,
  helloResponse: 0x02,
  readData: 0x03,
  endTransfer: 0x04,
  doneRequest: 0x05,
  doneResponse: 0x06,
  commandReady: 0x0b,
  switchMode: 0x0c,
  executeRequest: 0x0d,
  executeResponse: 0x0e,
  executeData: 0x0f,
  readData64: 0x12,
} as const;

const modes = {
  imagePending: 0,
  imageComplete: 1,
  command: 3,
} as const;

const identityCommands = {
  serial: 1,
  hardwareId: 2,
  oemKeyHash: 3,
} as const;

export interface SaharaIdentity {
  version: number;
  serial: string;
  hardwareId: string;
  oemKeyHash: string;
}

interface Packet {
  command: number;
  bytes: Uint8Array;
  view: DataView;
}

/** Sahara packets use a little-endian command/length header followed by u32 fields. */
function buildPacket(id: number, ...values: number[]): Uint8Array {
  const bytes = new Uint8Array((values.length + 2) * 4);
  const view = dataView(bytes);

  [id, bytes.length, ...values].forEach((value, index) => view.setUint32(index * 4, value, true));

  return bytes;
}

export class Sahara {
  #usb: UsbTransport;
  #log: Logger;
  #version = 2;

  constructor(usb: UsbTransport, log: Logger) {
    this.#usb = usb;
    this.#log = log;
  }

  /** Validate the wire length before allocating or interpreting a device packet. */
  async #readPacket(expected?: number, length?: number): Promise<Packet> {
    const context =
      expected === commands.helloRequest
        ? "Sahara HELLO"
        : `Sahara ${expected === undefined ? "packet" : `command 0x${expected.toString(16)}`}`;
    const header = await this.#usb.readExact(8, context);
    const headerView = dataView(header);
    const id = headerView.getUint32(0, true);
    const size = headerView.getUint32(4, true);

    if (size < 8 || size > 4096 || size % 4 !== 0) {
      throw new Error(
        "Invalid Sahara packet header. Start a fresh EDL session, not a running Firehose session.",
      );
    }

    const bytes = new Uint8Array(size);
    bytes.set(header);
    if (size > 8) {
      bytes.set(await this.#usb.readExact(size - 8, `${context} body`), 8);
    }

    const packet = { command: id, bytes, view: dataView(bytes) };
    this.#log("debug", "Sahara", `Received command 0x${id.toString(16)}, ${size} bytes.`);

    if (id === commands.endTransfer) {
      const status = size >= 16 ? packet.view.getUint32(12, true) : undefined;
      if (status !== 0) {
        throw new Error(`Sahara rejected the operation (status ${status ?? "missing"}).`);
      }
    }

    if ((expected !== undefined && id !== expected) || (length !== undefined && size !== length)) {
      throw new Error(`Unexpected Sahara packet: command 0x${id.toString(16)}, length ${size}.`);
    }

    return packet;
  }

  #respondHello(packet: Packet, mode: number): Promise<void> {
    if (packet.command !== commands.helloRequest || packet.bytes.length !== 48) {
      throw new Error("Expected a fresh Sahara HELLO packet.");
    }

    const version = packet.view.getUint32(8, true);
    const minimum = packet.view.getUint32(12, true);

    if (version < 2 || minimum > 2) {
      throw new Error(
        `Unsupported Sahara version ${version} (minimum ${minimum}); only version 2 is implemented.`,
      );
    }

    this.#version = 2;

    // HELLO_RSP carries version, minimum version, success status, requested
    // mode, and six reserved fields. Identity must use command mode first.
    return this.#usb.write(buildPacket(commands.helloResponse, 2, 1, 0, mode, 0, 0, 0, 0, 0, 0));
  }

  /** An execute response announces the length; EXECUTE_DATA requests its raw payload. */
  async #execute(id: 1 | 2 | 3): Promise<Uint8Array> {
    await this.#usb.write(buildPacket(commands.executeRequest, id));

    const response = await this.#readPacket(commands.executeResponse, 16);
    if (response.view.getUint32(8, true) !== id) {
      throw new Error("Sahara execute response does not match the requested identity field.");
    }

    const length = response.view.getUint32(12, true);
    if (length < 4 || length > 256) {
      throw new Error("Invalid Sahara identity response length.");
    }

    await this.#usb.write(buildPacket(commands.executeData, id));

    return this.#usb.readExact(length);
  }

  /** Verify ROM-reported identity before granting permission to upload executable code. */
  async identify(): Promise<SaharaIdentity> {
    this.#log("info", "Sahara", "Waiting for the ROM HELLO; no programmer has been uploaded.");
    const hello = await this.#readPacket(commands.helloRequest, 48);
    await this.#respondHello(hello, modes.command);
    await this.#readPacket(commands.commandReady, 8);

    const serial = await this.#execute(identityCommands.serial);
    const hardware = await this.#execute(identityCommands.hardwareId);
    const key = await this.#execute(identityCommands.oemKeyHash);

    if (hardware.length < 8 || key.length < 32 || key.length % 32 !== 0) {
      throw new Error("Incomplete Sahara hardware identity or OEM key hash.");
    }

    // Some ROMs repeat the same 32-byte OEM hash. Accept only exact repeats,
    // rather than truncating an unexplained payload into a matching identity.
    if (!key.every((byte, index) => byte === key[index % 32])) {
      throw new Error("Unexpected OEM key-hash payload; refusing to guess its format.");
    }

    const identity: SaharaIdentity = {
      version: this.#version,
      serial: dataView(serial).getUint32(0, true).toString(16).padStart(8, "0"),
      hardwareId: dataView(hardware).getBigUint64(0, true).toString(16).padStart(16, "0"),
      oemKeyHash: hex(key.slice(0, 32)),
    };

    if (
      identity.hardwareId !== deviceProfile.hardwareId ||
      identity.oemKeyHash !== deviceProfile.oemKeyHash
    ) {
      throw new Error(
        `Device identity mismatch: HWID ${identity.hardwareId}, OEM key ${identity.oemKeyHash}. No programmer was uploaded.`,
      );
    }

    this.#log(
      "info",
      "Sahara",
      `ThinkSmart HWID and OEM key verified; chip serial ${identity.serial}.`,
    );

    return identity;
  }

  /** Serve ROM-requested slices of the verified programmer; never pad or swap images. */
  async upload(programmer: Uint8Array, onProgress: (bytes: number) => void): Promise<void> {
    // Re-enter command mode to obtain another HELLO, then select image transfer
    // in HELLO_RSP. This is the sequence used by the existing native EDL client.
    await this.#usb.write(buildPacket(commands.switchMode, modes.command));

    const hello = await this.#readPacket(commands.helloRequest, 48);
    await this.#respondHello(hello, modes.imagePending);

    let transferred = 0;
    let imageId: bigint | null = null;

    for (let requests = 0; requests < 4096; requests++) {
      const packet = await this.#readPacket();

      // END_TRANSFER acknowledges image acceptance; DONE completes the Sahara
      // session. Do not mistake completed USB writes for either device ACK.
      if (packet.command === commands.endTransfer) {
        if (packet.bytes.length !== 16 || imageId === null) {
          throw new Error("Unexpected Sahara end-of-image packet.");
        }

        if (BigInt(packet.view.getUint32(8, true)) !== imageId) {
          throw new Error("Sahara completion refers to a different image.");
        }

        await this.#usb.write(buildPacket(commands.doneRequest));
        const done = await this.#readPacket(commands.doneResponse, 12);

        const completionMode = done.view.getUint32(8, true);
        if (completionMode !== modes.imageComplete && completionMode !== modes.imagePending) {
          throw new Error(
            `Unknown Sahara completion mode ${completionMode}; no additional images will be sent.`,
          );
        }

        // Existing clients accept DONE_RSP even when it reports pending mode.
        // Do not assume Firehose is ready: its configure ACK is the next gate.
        if (completionMode === modes.imagePending) {
          this.#log(
            "warning",
            "Sahara",
            "DONE acknowledged in pending mode; Firehose initialization must still be confirmed.",
          );
        }

        this.#log(
          "info",
          "Sahara",
          `Programmer accepted in RAM (${transferred} bytes transferred).`,
        );
        return;
      }

      // Keep offsets as BigInt until they are bounded by this small local image.
      const wide = packet.command === commands.readData64 && packet.bytes.length === 32;
      if (!wide && !(packet.command === commands.readData && packet.bytes.length === 20)) {
        throw new Error(`Unexpected Sahara upload command 0x${packet.command.toString(16)}.`);
      }

      const requestedImage = wide
        ? packet.view.getBigUint64(8, true)
        : BigInt(packet.view.getUint32(8, true));
      const offset = wide
        ? packet.view.getBigUint64(16, true)
        : BigInt(packet.view.getUint32(12, true));
      const length = wide
        ? packet.view.getBigUint64(24, true)
        : BigInt(packet.view.getUint32(16, true));

      if (
        (requestedImage !== 0xcn && requestedImage !== 0xdn) ||
        (imageId !== null && requestedImage !== imageId) ||
        length === 0n ||
        offset + length > BigInt(programmer.length) ||
        transferred + Number(length) > 16 * 1024 * 1024
      ) {
        throw new Error(
          "Programmer request is outside the verified image or upload budget; no padding or alternate loader will be sent.",
        );
      }

      imageId = requestedImage;
      await this.#usb.write(programmer.subarray(Number(offset), Number(offset + length)));
      transferred += Number(length);
      onProgress(transferred);
    }

    throw new Error("Sahara exceeded the maximum number of programmer requests.");
  }
}
