import { sha256 } from "@noble/hashes/sha2.js";
import {
  deviceProfile,
  LK2ND_PREFIX_BYTES,
  installPartitionNames,
  selectedPartitionNames,
  matchingBackupPartitions,
  validateBootMode,
  partitionsWithoutBackup,
  wipePartitionNames,
  partitionPolicy,
  wipeImagesAvailable,
  type InstallMode,
  type BootMode,
  type WritePartitionName,
} from "../../shared/profile";
import { wipeAssets, type Catalog, type FirmwareBuild } from "../../shared/catalog";
import { describeError, hex, type LogEntry, type Logger } from "./diagnostics";
import { Firehose, type StorageInfo } from "./firehose";
import {
  createStaging,
  hashFile,
  removeStaging,
  stageAsset,
  writeFile,
  writeJson,
  type StagingDirectory,
} from "./files";
import {
  composeBoot,
  extractBootPayload,
  installPartitions,
  validateLk2nd,
  inspectOemFilesystem,
  validateWipeImage,
  type InstallTarget,
} from "./install";
import { gptBackupRanges, inspectGpt, type GptInfo } from "./gpt";
import { Sahara, type SaharaIdentity } from "./sahara";
import { UsbTransport, type UsbInfo } from "./usb";
import { expandSparseWipe } from "./sparse";

function sameGpt(left: GptInfo, right: GptInfo): boolean {
  // Include CRCs, GUIDs, extents, attributes, and capacity, not only partition names.
  const encode = (value: GptInfo) =>
    JSON.stringify(value, (_key, field: unknown) =>
      typeof field === "bigint" ? field.toString() : field,
    );
  return encode(left) === encode(right);
}

export type Phase =
  | "idle"
  | "preparing"
  | "ready"
  | "choosing"
  | "opening"
  | "identity"
  | "uploading"
  | "storage"
  | "gpt"
  | "inspected"
  | "backing-up"
  | "staging"
  | "install-ready"
  | "flashing"
  | "verifying"
  | "complete"
  | "unchanged"
  | "restarting"
  | "finished"
  | "closing"
  | "cancelled"
  | "failed";

export type Stage = "connection" | "backup" | "flash" | "finish";

export interface OperationProgress {
  label: string;
  completedBytes: number;
  totalBytes: number | null;
  partition: WritePartitionName | "gpt" | null;
}

export interface BackupRecord {
  name: string;
  bytes: number;
  sha256: string;
  androidWindowSha256?: string;
  lk2ndValidated?: boolean;
}

export interface GptBackupRecord extends BackupRecord {
  fileName: string;
  startLba: bigint;
  sectorCount: number;
}

export interface WriteRecord {
  name: WritePartitionName;
  startLba: bigint;
  imageBytes: number;
  imageSha256: string;
  sentSha256: string | null;
  writeBytes: number;
  writtenBytes: number;
  status: "pending" | "writing" | "written";
}

export interface SessionSnapshot {
  build: FirmwareBuild | null;
  phase: Phase;
  failedPhase: Phase | null;
  stage: Stage;
  installMode: InstallMode | null;
  bootMode: BootMode;
  selectionLocked: boolean;
  autoSkippedPartitions: readonly WritePartitionName[];
  busy: boolean;
  prepared: boolean;
  connected: boolean;
  uploadedBytes: number;
  programmerUploaded: boolean;
  error: string | null;
  usb: UsbInfo | null;
  identity: SaharaIdentity | null;
  storage: StorageInfo | null;
  gpt: GptInfo | null;
  oemFilesystemVerified: boolean;
  capturedAt: string | null;
  logs: readonly LogEntry[];
  progress: OperationProgress | null;
  backupDecision: "pending" | "complete" | "skipped";
  backupPath: string | null;
  backups: readonly BackupRecord[];
  backupGpt: boolean;
  gptBackups: readonly GptBackupRecord[];
  flashPartitions: readonly WritePartitionName[];
  backupPartitions: readonly WritePartitionName[];
  confirmations: {
    acceptsOverwrite: boolean;
  } | null;
  preparedImages: readonly BackupRecord[] | null;
  imageProgress: readonly OperationProgress[];
  prefixSha256: string | null;
  writesStarted: boolean;
  writes: readonly WriteRecord[];
}

function initialSnapshot(): SessionSnapshot {
  return {
    build: null,
    phase: "idle",
    failedPhase: null,
    stage: "connection",
    installMode: null,
    bootMode: "complete",
    selectionLocked: false,
    autoSkippedPartitions: [],
    busy: false,
    prepared: false,
    connected: false,
    uploadedBytes: 0,
    programmerUploaded: false,
    error: null,
    usb: null,
    identity: null,
    storage: null,
    gpt: null,
    oemFilesystemVerified: false,
    capturedAt: null,
    logs: [],
    progress: null,
    backupDecision: "pending",
    backupPath: null,
    backups: [],
    backupGpt: true,
    gptBackups: [],
    flashPartitions: [],
    backupPartitions: [],
    confirmations: null,
    preparedImages: null,
    imageProgress: [],
    prefixSha256: null,
    writesStarted: false,
    writes: [],
  };
}

class InstallerSession {
  #snapshot = initialSnapshot();

  #listeners = new Set<() => void>();
  #programmerAsset: Catalog["programmer"] | null = null;
  #programmer: Uint8Array | null = null;
  #device: USBDevice | null = null;
  #usb: UsbTransport | null = null;
  #firehose: Firehose | null = null;
  #controller: AbortController | null = null;
  #closing: Promise<void> | null = null;
  #nextLogId = 1;
  #activeUsesUsb = false;
  #operationPhase: Phase | null = null;
  #staging: StagingDirectory | null = null;
  #targets: InstallTarget[] = [];
  #prefixHash: string | null = null;
  #backupDirectory: FileSystemDirectoryHandle | null = null;
  #pendingLogs: LogEntry[] = [];
  #pendingDebugLogs: LogEntry[] = [];
  #logTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    if ("usb" in navigator) {
      navigator.usb.addEventListener("disconnect", this.#onDisconnect);
    }
    window.addEventListener("beforeunload", this.#onBeforeUnload);
  }

  getSnapshot = (): SessionSnapshot => this.#snapshot;

  getReport = () => this.#report();

  selectBuild(catalog: Catalog, id: string): void {
    if (
      this.#snapshot.busy ||
      this.#snapshot.connected ||
      this.#snapshot.writesStarted ||
      this.#staging
    ) {
      throw new Error("Disconnect and discard prepared images before selecting another build.");
    }
    const build = catalog.builds.find((entry) => entry.id === id);
    if (!build) {
      throw new Error("The selected build is no longer available.");
    }
    this.#flushLogs();
    this.#programmerAsset = catalog.programmer;
    this.#update({
      ...initialSnapshot(),
      build,
      phase: this.#programmer ? "ready" : "idle",
      prepared: this.#programmer !== null,
    });
  }

  #build(): FirmwareBuild {
    if (!this.#snapshot.build) {
      throw new Error("Return to image selection and choose a build.");
    }
    return this.#snapshot.build;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  // Each notification publishes a new snapshot; React never owns protocol state.
  #update(update: Partial<SessionSnapshot>) {
    if (this.#controller && update.phase && update.phase !== "closing") {
      this.#operationPhase = update.phase;
    }
    this.#snapshot = { ...this.#snapshot, ...update };

    for (const listener of this.#listeners) {
      listener();
    }
  }

  #log: Logger = (level, source, message) => {
    const entry: LogEntry = {
      id: this.#nextLogId++,
      time: new Date().toISOString(),
      level,
      source,
      message: message.slice(0, 8192),
    };

    if (level === "debug") {
      this.#pendingDebugLogs = [...this.#pendingDebugLogs.slice(-499), entry];
    } else {
      this.#pendingLogs = [...this.#pendingLogs.slice(-499), entry];
    }

    // Raw USB diagnostics can arrive thousands of times per second. Batch them
    // without delaying protocol execution; errors and warnings publish immediately.
    if (level === "error" || level === "warning") {
      this.#flushLogs();
    } else {
      this.#logTimer ??= setTimeout(this.#flushLogs, 100);
    }
  };

  #flushLogs = (): void => {
    clearTimeout(this.#logTimer);
    this.#logTimer = undefined;
    if (this.#pendingLogs.length || this.#pendingDebugLogs.length) {
      // Retain operation messages independently so USB traffic cannot empty the filtered log.
      const operations = [
        ...this.#snapshot.logs.filter((entry) => entry.level !== "debug"),
        ...this.#pendingLogs,
      ].slice(-500);
      const diagnostics = [
        ...this.#snapshot.logs.filter((entry) => entry.level === "debug"),
        ...this.#pendingDebugLogs,
      ].slice(-500);
      this.#pendingLogs = [];
      this.#pendingDebugLogs = [];
      this.#update({ logs: [...operations, ...diagnostics].sort((a, b) => a.id - b.id) });
    }
  };

  #progress(
    label: string,
    completedBytes: number,
    totalBytes: number | null,
    partition: OperationProgress["partition"] = null,
  ) {
    const progress = { label, completedBytes, totalBytes, partition };
    this.#update({
      progress,
      ...(this.#snapshot.phase === "staging" && partition
        ? {
            imageProgress: [
              ...this.#snapshot.imageProgress.filter((entry) => entry.partition !== partition),
              progress,
            ],
          }
        : {}),
    });
  }

  /** Share cleanup across cancellation, unplug, timeout, and the operation's catch. */
  #close(): Promise<void> {
    if (this.#closing) {
      return this.#closing;
    }

    // An in-flight open cannot be cancelled by close until it returns a handle.
    // Keep the device reference so the operation's catch can close it afterwards.
    if (!this.#usb && !this.#device?.opened) {
      return Promise.resolve();
    }

    this.#closing = (async () => {
      try {
        if (this.#usb) {
          await this.#usb.close();
        } else if (this.#device?.opened) {
          await this.#device.close();
        }
      } finally {
        this.#usb = null;
        this.#firehose = null;
        this.#device = null;
        this.#update({ connected: false });
      }
    })();

    return this.#closing;
  }

  /** Hold the operation lock until cancellation and USB cleanup have both settled. */
  #run(
    operation: (signal: AbortSignal) => Promise<void>,
    options: { budgetMs?: number; usesUsb?: boolean } = {},
  ) {
    if (this.#controller) {
      this.#log(
        "warning",
        "Session",
        "An operation is already active; the new request was refused.",
      );
      return;
    }

    const controller = new AbortController();
    this.#controller = controller;
    this.#operationPhase = this.#snapshot.phase;
    this.#activeUsesUsb = options.usesUsb ?? false;
    this.#closing = null;
    this.#update({ busy: true, error: null, failedPhase: null });

    // A bounded wall-clock budget also catches endless but individually valid
    // device responses. Closing USB cancels reads; nothing is replayed.
    const deadline = setTimeout(() => {
      controller.abort(
        new Error("Operation exceeded its time budget. No automatic reconnect or command replay."),
      );
      this.#update({ phase: "closing" });
      if (this.#activeUsesUsb) {
        void this.#close().catch((error: unknown) =>
          this.#log("error", "USB cleanup", describeError(error)),
        );
      }
    }, options.budgetMs ?? 180000);

    return (async () => {
      try {
        await operation(controller.signal);
        controller.signal.throwIfAborted();
      } catch (error: unknown) {
        const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
        const cancelled = reason instanceof DOMException && reason.name === "AbortError";
        const message = describeError(reason);
        // Closing/cancellation must not hide which check actually failed.
        const failedPhase = this.#operationPhase;

        this.#update({ phase: "closing" });
        this.#log(cancelled ? "warning" : "error", "Session", message);

        let cleanupError: string | null = null;
        try {
          if (this.#activeUsesUsb) {
            await this.#close();
          }
        } catch (closeError: unknown) {
          cleanupError = `USB cleanup failed: ${describeError(closeError)}. Unplug the USB cable.`;
          this.#log("error", "USB cleanup", cleanupError);
        }

        const finalPhase: Phase = cleanupError || !cancelled ? "failed" : "cancelled";
        let finalError: string | null = cancelled && !this.#snapshot.writesStarted ? null : message;

        if (cleanupError) {
          finalError = `${message} ${cleanupError}`;
        }

        this.#update({ phase: finalPhase, error: finalError });
        if (this.#snapshot.writesStarted && this.#staging) {
          try {
            await this.#writeJournal();
          } catch (journalError) {
            const journalMessage = `Could not save the failure report: ${describeError(journalError)}.`;
            this.#log("error", "Files", journalMessage);
            finalError = `${finalError ?? message} ${journalMessage}`;
          }
        }

        this.#update({
          phase: finalPhase,
          error: finalError,
          failedPhase: finalError || finalPhase === "failed" ? failedPhase : null,
        });
      } finally {
        clearTimeout(deadline);

        // A cancelled chooser can return an unopened device. It has no USB
        // handle to close, but its reference must not survive the operation.
        if (!this.#device?.opened) {
          this.#device = null;
          this.#usb = null;
          this.#firehose = null;
        }

        this.#controller = null;
        this.#activeUsesUsb = false;
        this.#flushLogs();
        this.#update({ busy: false });
      }
    })();
  }

  /** Fetch and hash the small programmer before a Connect click requests USB permission. */
  prepare = (): void => {
    if (this.#snapshot.connected) {
      this.#log("warning", "Session", "Disconnect before preparing a new programmer.");
      return;
    }

    this.#run(async (signal) => {
      this.#build();
      const programmer = this.#programmerAsset;
      if (!programmer) {
        throw new Error("The selected build has no verified programmer.");
      }
      this.#programmer = null;
      this.#update({ phase: "preparing", prepared: false });
      this.#log(
        "info",
        "Assets",
        "Fetching the pinned programmer; Android images will not be downloaded.",
      );

      const response = await fetch(programmer.url, {
        signal,
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok || !response.body) {
        throw new Error(`Programmer unavailable (HTTP ${response.status}).`);
      }

      // Allocate only the pinned size; even a bad server response cannot turn
      // this preparation step into an unbounded firmware download.
      const reader = response.body.getReader();
      const bytes = new Uint8Array(programmer.bytes);
      let received = 0;
      this.#progress("Downloading programmer", 0, bytes.length);

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          if (received + value.length > bytes.length) {
            throw new Error("Programmer exceeds its pinned size.");
          }

          bytes.set(value, received);
          received += value.length;
          this.#progress("Downloading programmer", received, bytes.length);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }

      if (received !== bytes.length) {
        throw new Error("Programmer size does not match the pinned profile.");
      }

      const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)));
      signal.throwIfAborted();

      if (digest !== programmer.sha256) {
        throw new Error("Programmer SHA-256 mismatch. Connection remains disabled.");
      }

      this.#programmer = bytes;
      this.#update({ phase: "ready", prepared: true });
      this.#log("info", "Assets", `Programmer length and SHA-256 verified (${received} bytes).`);
    });
  };

  /** A single explicit action runs identity → RAM upload → read-only storage/GPT inspection. */
  connect = (): void => {
    const programmer = this.#programmer;
    if (
      !programmer ||
      !window.isSecureContext ||
      !("usb" in navigator) ||
      this.#snapshot.connected ||
      this.#staging !== null
    ) {
      this.#log(
        "error",
        "Session",
        "Connect refused: prepare the programmer, use a WebUSB browser on localhost/HTTPS, and disconnect any previous session.",
      );
      return;
    }

    this.#run(
      async (signal) => {
        this.#backupDirectory = null;
        this.#prefixHash = null;
        this.#targets = [];
        this.#update({
          stage: "connection",
          installMode: null,
          bootMode: "complete",
          selectionLocked: false,
          autoSkippedPartitions: [],
          phase: "choosing",
          usb: null,
          identity: null,
          storage: null,
          gpt: null,
          oemFilesystemVerified: false,
          capturedAt: null,
          uploadedBytes: 0,
          programmerUploaded: false,
          progress: null,
          backupDecision: "pending",
          backupPath: null,
          backups: [],
          backupGpt: true,
          gptBackups: [],
          flashPartitions: [],
          backupPartitions: [],
          confirmations: null,
          preparedImages: null,
          imageProgress: [],
          prefixSha256: null,
          writesStarted: false,
          writes: [],
        });

        // Must run synchronously within the Connect click's transient user activation.
        let device: USBDevice;
        try {
          device = await navigator.usb.requestDevice({
            filters: [{ vendorId: deviceProfile.vendorId, productId: deviceProfile.productId }],
          });
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === "NotFoundError") {
            throw new DOMException(
              "Device chooser dismissed without selecting a device.",
              "AbortError",
            );
          }

          throw error;
        }

        this.#device = device;
        signal.throwIfAborted();

        if (
          device.vendorId !== deviceProfile.vendorId ||
          device.productId !== deviceProfile.productId
        ) {
          throw new Error("Selected USB device is not Qualcomm EDL 05c6:9008.");
        }

        this.#update({ phase: "opening" });
        this.#usb = await UsbTransport.open(device, this.#log, signal);
        signal.throwIfAborted();
        this.#update({ phase: "identity", usb: this.#usb.info, connected: true });

        // Identity is a hard gate: no loader bytes may be sent until both fields
        // match the device policy, regardless of the selected USB VID/PID.
        const sahara = new Sahara(this.#usb, this.#log);
        const identity = await sahara.identify();
        signal.throwIfAborted();

        this.#update({ identity, phase: "uploading" });
        await sahara.upload(programmer, (uploadedBytes) => {
          this.#update({ uploadedBytes });
          this.#progress("Uploading programmer to RAM", uploadedBytes, null);
        });
        signal.throwIfAborted();

        this.#update({ phase: "storage", programmerUploaded: true });
        const firehose = new Firehose(this.#usb, this.#log);
        this.#firehose = firehose;
        await firehose.configure();
        const storage = await firehose.storageInfo();
        signal.throwIfAborted();

        this.#update({ storage, phase: "gpt" });
        let readBytes = 0;
        const reader = {
          readSectors: async (start: bigint, count: number) => {
            const bytes = await firehose.readSectors(start, count, (completed) =>
              this.#progress("Reading partition tables", readBytes + completed, null),
            );
            readBytes += bytes.length;
            return bytes;
          },
        };
        const gpt = await inspectGpt(reader, storage, this.#log);
        signal.throwIfAborted();
        this.#update({ gpt });
        if (gpt.layoutMatches && gpt.capacityConfirmed) {
          const oemFilesystemVerified = await inspectOemFilesystem(firehose, gpt);
          signal.throwIfAborted();
          this.#update({ oemFilesystemVerified });
          this.#log(
            oemFilesystemVerified ? "info" : "warning",
            "Metadata",
            oemFilesystemVerified
              ? "OEM ext4 verified for /metadata."
              : "OEM is not ext4. Android requires a metadata wipe for initial installation.",
          );
        }

        this.#update({
          gpt,
          phase: "inspected",
          progress: null,
          capturedAt: new Date().toISOString(),
        });
        this.#log(
          "info",
          "Session",
          "Read-only inspection complete. Boot prefix and image installability have not been checked.",
        );
      },
      { usesUsb: true },
    );
  };

  #verifiedDevice() {
    const { gpt, storage, identity } = this.#snapshot;
    if (
      !this.#snapshot.connected ||
      !this.#device?.opened ||
      !this.#firehose ||
      !gpt ||
      !storage ||
      !identity
    ) {
      throw new Error("A live hardware-verified EDL session and valid GPT are required.");
    }
    installPartitions(gpt, "clean");
    return { firehose: this.#firehose, gpt, storage, identity };
  }

  #installMode(): InstallMode {
    const { installMode, flashPartitions } = this.#snapshot;

    if (!installMode) {
      throw new Error("Continue device inspection before selecting images.");
    }

    installPartitionNames(installMode);

    const mode = flashPartitions.some((name) => wipePartitionNames.some((wipe) => wipe === name))
      ? "clean"
      : "update";

    if (mode === "clean" && !wipeImagesAvailable(this.#build())) {
      throw new Error("Selected wipes require pinned data, cache and metadata images.");
    }

    return mode;
  }

  continue = (): void => {
    if (this.#snapshot.busy) {
      this.#log("warning", "Session", "Wait for the current operation before continuing.");
      return;
    }

    this.#run(async () => {
      this.#verifiedDevice();

      if (this.#snapshot.stage === "connection") {
        this.#update({
          stage: "backup",
          ...(this.#snapshot.installMode === null
            ? {
                installMode: "update" as const,
                flashPartitions: [...installPartitionNames("update")],
                backupPartitions: [...installPartitionNames("clean")],
              }
            : {}),
          progress: null,
        });
      } else if (
        this.#snapshot.stage === "flash" &&
        this.#snapshot.backupDecision !== "pending" &&
        this.#snapshot.flashPartitions.length === 0 &&
        !this.#staging
      ) {
        this.#update({ stage: "finish", phase: "unchanged", progress: null });
      } else if (
        this.#snapshot.stage === "backup" &&
        this.#snapshot.backupDecision === "complete"
      ) {
        this.#installMode();
        this.#update({ stage: "flash", phase: "inspected", progress: null });
      } else {
        throw new Error("The current step is not complete.");
      }
    });
  };

  /** Presets only toggle wipe selections; individual choices remain overridable. */
  chooseInstallMode = (mode: InstallMode): void => {
    this.#run(async () => {
      const { gpt } = this.#verifiedDevice();
      if (this.#snapshot.stage !== "flash" || this.#staging || this.#snapshot.writesStarted) {
        throw new Error("Wipe presets cannot change after preparation starts.");
      }
      installPartitions(gpt, mode);

      if (mode === "clean" && !wipeImagesAvailable(this.#build())) {
        throw new Error("The clean preset requires pinned data, cache and metadata images.");
      }
      const withoutWipes = (names: readonly WritePartitionName[]) =>
        names.filter((name) => !wipePartitionNames.some((wipe) => wipe === name));
      const wipes = mode === "clean" ? [...wipePartitionNames] : [];

      this.#update({
        installMode: mode,
        flashPartitions: selectedPartitionNames(
          "clean",
          [...withoutWipes(this.#snapshot.flashPartitions), ...wipes],
          true,
        ),
        autoSkippedPartitions: this.#snapshot.autoSkippedPartitions.filter(
          (name) => !wipePartitionNames.some((wipe) => wipe === name),
        ),
        confirmations: null,
        progress: null,
      });

      this.#log(
        mode === "clean" ? "warning" : "info",
        "Data & cache",
        mode === "clean"
          ? "Clean preset selected data, cache and metadata wipes. Individual choices can be changed."
          : "Update preset unchecked data, cache and metadata wipes. Individual choices can be changed.",
      );
    });
  };

  /** Backup scope freezes when saving starts; flash choices remain editable until staging. */
  selectPartition = (
    kind: "flash" | "backup",
    name: WritePartitionName,
    selected: boolean,
  ): void => {
    this.#run(async () => {
      const { gpt } = this.#verifiedDevice();
      this.#installMode();

      if (
        this.#snapshot.stage !== (kind === "flash" ? "flash" : "backup") ||
        (kind === "backup" &&
          (this.#snapshot.backupDecision !== "pending" || this.#snapshot.backupPath !== null)) ||
        this.#staging ||
        this.#snapshot.writesStarted ||
        (kind !== "flash" && kind !== "backup")
      ) {
        throw new Error(
          "Backup choices lock when saving starts; flash choices lock during staging.",
        );
      }

      const scope = "clean";
      installPartitions(gpt, scope, [name]);
      const previous =
        kind === "flash" ? this.#snapshot.flashPartitions : this.#snapshot.backupPartitions;
      const next = selected ? [...previous, name] : previous.filter((entry) => entry !== name);
      const names = selectedPartitionNames(scope, next, true);

      if (kind === "flash") {
        this.#update({
          flashPartitions: names,
          autoSkippedPartitions: this.#snapshot.autoSkippedPartitions.filter(
            (entry) => entry !== name,
          ),
          confirmations: null,
        });
      } else {
        this.#update({ backupPartitions: names, confirmations: null });
      }

      this.#log(
        "info",
        "Selection",
        `${name} ${selected ? "selected" : "skipped"} for ${kind === "flash" ? "flashing" : "backup"}.`,
      );
    });
  };

  selectBootMode = (mode: BootMode): void => {
    this.#run(async () => {
      this.#verifiedDevice();
      validateBootMode(mode);

      if (this.#snapshot.stage !== "flash" || this.#staging || this.#snapshot.writesStarted) {
        throw new Error("Boot handling cannot change after image staging starts.");
      }

      const matches = matchingBackupPartitions(this.#build(), mode, this.#snapshot.backups);
      const wasAutoSkipped = this.#snapshot.autoSkippedPartitions.includes("boot");
      const candidates = wasAutoSkipped
        ? [...this.#snapshot.flashPartitions, "boot" as const]
        : [...this.#snapshot.flashPartitions];
      const skip = candidates.includes("boot") && matches.includes("boot");

      this.#update({
        bootMode: mode,
        flashPartitions: selectedPartitionNames(
          "clean",
          skip ? candidates.filter((name) => name !== "boot") : candidates,
          true,
        ),
        autoSkippedPartitions: [
          ...this.#snapshot.autoSkippedPartitions.filter((name) => name !== "boot"),
          ...(skip ? ["boot" as const] : []),
        ],
        confirmations: null,
      });

      this.#log(
        "info",
        "Boot",
        mode === "complete"
          ? "Complete bundled boot selected, including lk2nd."
          : "Installed lk2nd will be preserved.",
      );
    });
  };

  selectGptBackup = (selected: boolean): void => {
    this.#run(async () => {
      this.#verifiedDevice();
      if (
        this.#snapshot.stage !== "backup" ||
        this.#snapshot.backupDecision !== "pending" ||
        this.#snapshot.backupPath !== null ||
        this.#snapshot.writesStarted
      ) {
        throw new Error("GPT backup choice locks when saving starts.");
      }
      this.#update({ backupGpt: selected });
      this.#log("info", "Selection", `GPT ${selected ? "selected" : "skipped"} for backup.`);
    });
  };

  back = (stage?: Stage): void => {
    this.#run(async () => {
      this.#verifiedDevice();
      const stages: readonly Stage[] = ["connection", "backup", "flash", "finish"];
      const current = stages.indexOf(this.#snapshot.stage);
      const target = stage ?? stages[current - 1];

      if (this.#snapshot.writesStarted) {
        throw new Error("Steps cannot change after a partition write starts.");
      }
      if (!target || stages.indexOf(target) < 0 || stages.indexOf(target) >= current) {
        throw new Error("Only previous steps can be opened.");
      }

      await this.#clearStaging();
      this.#prefixHash = null;
      this.#update({
        stage: target,
        ...(target !== "flash" && this.#snapshot.backupDecision === "skipped"
          ? { backupDecision: "pending" as const }
          : {}),
        phase: "inspected",
        prefixSha256: null,
        progress: null,
        confirmations: null,
      });
    });
  };

  skipBackup = (): void => {
    if (
      this.#snapshot.busy ||
      !this.#snapshot.connected ||
      !this.#snapshot.gpt ||
      !this.#snapshot.installMode ||
      this.#snapshot.stage !== "backup" ||
      this.#snapshot.backupDecision !== "pending" ||
      this.#snapshot.backupPath !== null ||
      this.#snapshot.writesStarted
    ) {
      this.#log("error", "Backup", "Backup cannot be skipped in the current state.");
      return;
    }

    this.#log(
      this.#snapshot.flashPartitions.length ? "warning" : "info",
      "Backup",
      this.#snapshot.flashPartitions.length
        ? "Backup explicitly skipped. Existing backups are needed for rollback."
        : "Backup skipped; ending without any partition writes.",
    );

    this.#update({
      backupDecision: "skipped",
      stage: "flash",
      phase: "inspected",
      progress: null,
    });
  };

  /** Save the selected complete physical partitions, independently of the flash selection. */
  backup = (): void => {
    this.#run(
      async (signal) => {
        const { firehose, gpt, identity, storage } = this.#verifiedDevice();
        const mode = this.#installMode();

        if (
          this.#snapshot.stage !== "backup" ||
          this.#snapshot.backupDecision !== "pending" ||
          this.#snapshot.backupPath !== null ||
          this.#snapshot.writesStarted
        ) {
          throw new Error("Backup is not available in the current installation state.");
        }

        const names = selectedPartitionNames(
          "clean",
          this.#snapshot.backupPartitions,
          this.#snapshot.backupGpt,
        );
        const gptRanges = this.#snapshot.backupGpt ? gptBackupRanges(gpt) : [];
        const flashSelectionAtBackup = [...this.#snapshot.flashPartitions];

        if (typeof window.showDirectoryPicker !== "function") {
          throw new Error(
            "Saving backups requires the File System Access API in desktop Chrome or Edge.",
          );
        }

        // Request permission before the first await so the Backup click owns activation.
        const root = await window.showDirectoryPicker({
          id: "thinksmart-backup",
          mode: "readwrite",
        });

        signal.throwIfAborted();

        const directoryName = `thinksmart-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(directoryName, { create: true });
        this.#backupDirectory = directory;
        this.#activeUsesUsb = true;

        this.#update({
          phase: "backing-up",
          backups: [],
          gptBackups: [],
          backupDecision: "pending",
          backupPath: `${root.name}/${directoryName}`,
        });

        const manifest = () => ({
          formatVersion: 3,
          status: this.#snapshot.backupDecision === "complete" ? "complete" : "incomplete",
          build: this.#build().id,
          installMode: mode,
          wipePreset: this.#snapshot.installMode,
          flashSelectionAtBackup,
          bootModeAtBackup: this.#snapshot.bootMode,
          requestedBackupPartitions: names,
          omittedBackupPartitions: installPartitionNames("clean").filter(
            (entry) => !names.includes(entry),
          ),
          identity,
          gpt,
          sectorBytes: 512,
          gptBackupRequested: this.#snapshot.backupGpt,
          gptBackups: this.#snapshot.gptBackups,
          backups: this.#snapshot.backups,
          matchingImagePartitions: matchingBackupPartitions(
            this.#build(),
            this.#snapshot.bootMode,
            this.#snapshot.backups,
          ),
        });

        await writeJson(directory, "backup.json", manifest());

        const partitions = names.length ? installPartitions(gpt, "clean", names) : [];

        if (gptRanges.length) {
          const fresh = await inspectGpt(firehose, storage, this.#log);
          if (!sameGpt(fresh, gpt)) {
            throw new Error("Live GPT changed before backup.");
          }

          for (const range of gptRanges) {
            signal.throwIfAborted();
            const total = range.sectorCount * 512;
            const fileName = `${range.name}.bin`;
            this.#progress("Backing up GPT", 0, total, "gpt");
            const bytes = await firehose.readSectors(range.startLba, range.sectorCount);
            if (bytes.length !== total) {
              throw new Error(`Incomplete ${range.name} read.`);
            }
            const expected = hex(sha256(bytes));
            const handle = await directory.getFileHandle(fileName, { create: true });
            const file = await writeFile(handle, async (writer) => {
              signal.throwIfAborted();
              await writer.write(bytes.slice().buffer);
              signal.throwIfAborted();
            });
            const saved = await hashFile(file, signal, (done, length) =>
              this.#progress("Verifying GPT backup", done, length, "gpt"),
            );
            if (file.size !== total || saved !== expected) {
              throw new Error(`Saved ${range.name} backup differs from the device read.`);
            }

            this.#update({
              gptBackups: [
                ...this.#snapshot.gptBackups,
                { ...range, fileName, bytes: total, sha256: saved },
              ],
            });
            await writeJson(directory, "backup.json", manifest());
            this.#log("info", "Backup", `${fileName}: raw GPT bytes saved and hash-verified.`);
          }
        }

        for (const partition of partitions) {
          signal.throwIfAborted();

          const total = Number(partition.bytes);
          const digest = sha256.create();
          const windowDigest = partition.name === "boot" ? sha256.create() : null;
          this.#progress("Backing up", 0, total, partition.name);
          const handle = await directory.getFileHandle(`${partition.name}.img`, { create: true });

          this.#log(
            "info",
            "Backup",
            `Reading the full ${partition.name} partition (${total} bytes).`,
          );
          const file = await writeFile(handle, async (writer) => {
            await firehose.readSectorsTo(
              partition.firstLba,
              total / 512,
              async (bytes, offset) => {
                signal.throwIfAborted();
                digest.update(bytes);
                windowDigest?.update(offset === 0 ? bytes.subarray(LK2ND_PREFIX_BYTES) : bytes);

                await writer.write(bytes);
                this.#progress("Backing up", offset + bytes.length, total, partition.name);
              },
              signal,
            );
            signal.throwIfAborted();
          });

          const expected = hex(digest.digest());
          const saved = await hashFile(file, signal, (done, bytes) =>
            this.#progress("Verifying backup", done, bytes, partition.name),
          );
          if (file.size !== total || saved !== expected) {
            throw new Error(`Saved ${partition.name} backup differs from the device read.`);
          }

          let lk2ndValidated: boolean | undefined;

          if (partition.name === "boot") {
            const prefix = new Uint8Array(await file.slice(0, LK2ND_PREFIX_BYTES).arrayBuffer());

            try {
              validateLk2nd(prefix);
              lk2ndValidated = true;
            } catch (error) {
              lk2ndValidated = false;
              this.#log(
                "debug",
                "Boot",
                `Backup saved; preserve mode does not support this loader: ${describeError(error)}`,
              );
            }
          }
          this.#update({
            backups: [
              ...this.#snapshot.backups,
              {
                name: partition.name,
                bytes: total,
                sha256: saved,
                ...(windowDigest
                  ? { androidWindowSha256: hex(windowDigest.digest()), lk2ndValidated }
                  : {}),
              },
            ],
          });

          await writeJson(directory, "backup.json", manifest());
        }

        // Only the final committed manifest marks a usable backup set.
        await writeJson(directory, "backup.json", { ...manifest(), status: "complete" });
        signal.throwIfAborted();

        const matching = matchingBackupPartitions(
          this.#build(),
          this.#snapshot.bootMode,
          this.#snapshot.backups,
        );
        const autoSkipped = this.#snapshot.flashPartitions.filter((name) =>
          matching.includes(name),
        );

        this.#update({
          phase: "inspected",
          backupDecision: "complete",
          progress: null,
          flashPartitions: this.#snapshot.flashPartitions.filter(
            (name) => !matching.includes(name),
          ),
          autoSkippedPartitions: autoSkipped,
        });

        if (autoSkipped.length) {
          this.#log(
            "info",
            "Images",
            `Automatically skipped matching images: ${autoSkipped.join(", ")}. No extra device reads.`,
          );
        }

        this.#log(
          "info",
          "Backup",
          `All ${partitions.length} partition backups and ${gptRanges.length} GPT regions were saved and hash-verified.`,
        );
      },
      { budgetMs: 3 * 60 * 60 * 1000 },
    );
  };

  /** Validate the chosen boot handling and stage only selected, pinned images. */
  async #prepareImages(signal: AbortSignal): Promise<void> {
    const { firehose, gpt } = this.#verifiedDevice();
    const mode = this.#installMode();
    const names = selectedPartitionNames(mode, this.#snapshot.flashPartitions);
    const completeBoot = names.includes("boot") && this.#snapshot.bootMode === "complete";
    const preserveBoot = names.includes("boot") && this.#snapshot.bootMode === "preserve-lk2nd";

    if (
      this.#snapshot.backupDecision === "pending" ||
      this.#snapshot.writesStarted ||
      this.#snapshot.stage !== "flash"
    ) {
      throw new Error("Complete or explicitly skip backup before preparing images.");
    }

    this.#update({ phase: "staging", preparedImages: null, imageProgress: [] });
    await this.#clearStaging();
    this.#update({ selectionLocked: true });
    signal.throwIfAborted();

    const partitions = installPartitions(gpt, mode, names);
    const boot = installPartitions(gpt).find((partition) => partition.name === "boot");

    if (!boot) {
      throw new Error("Verified boot partition is missing.");
    }

    this.#progress(
      "Checking loader",
      0,
      LK2ND_PREFIX_BYTES,
      names.includes("boot") ? "boot" : null,
    );
    this.#activeUsesUsb = true;

    const prefix = await firehose.readSectors(boot.firstLba, LK2ND_PREFIX_BYTES / 512);
    this.#prefixHash = preserveBoot ? validateLk2nd(prefix) : hex(sha256(prefix));

    this.#update({ prefixSha256: this.#prefixHash });
    this.#log(
      "info",
      "Boot",
      completeBoot
        ? "Original boot prefix recorded; using the bundled boot image."
        : preserveBoot
          ? "Live lk2nd prefix validated; it will not be rewritten."
          : "Original boot prefix recorded; boot will not be written.",
    );

    this.#activeUsesUsb = false;

    const build = this.#build();
    const assets = Object.values(build.images).filter((asset) =>
      names.some((name) => name === asset.id),
    );
    const expandedBytes = wipeAssets(build)
      .filter((asset) => names.includes(asset.id))
      .reduce((sum, asset) => sum + partitionPolicy(asset.id).bytes, 0);

    this.#staging = await createStaging(
      assets.reduce((sum, asset) => sum + asset.bytes, 0) +
        expandedBytes +
        (names.includes("boot") && !completeBoot ? Number(boot.bytes) : 0),
    );

    const files = new Map<string, File>();
    const hashes = new Map<string, string>();
    const prepared: BackupRecord[] = [];
    const queue = assets.values();
    const controller = new AbortController();
    const preparationSignal = AbortSignal.any([signal, controller.signal]);
    const directory = this.#staging.directory;

    // Two workers overlap downloads with disk verification/expansion without
    // unbounded network queues or whole-image memory buffers.
    const prepareNext = async () => {
      for (const asset of queue) {
        preparationSignal.throwIfAborted();
        const name = names.find((entry) => entry === asset.id);

        if (!name) {
          throw new Error(`Unexpected image asset: ${asset.id}.`);
        }

        let file = await stageAsset(
          directory,
          asset,
          preparationSignal,
          (done, total) => this.#progress("Downloading", done, total, name),
          (done, total) => this.#progress("Verifying image", done, total, name),
        );

        let hash = asset.sha256;
        const wipe = asset.format === "android-sparse" ? asset : null;

        if (wipe) {
          file = await expandSparseWipe(
            directory,
            wipe,
            file,
            preparationSignal,
            (done, total) => this.#progress("Expanding sparse image", done, total, name),
            (done, total) => this.#progress("Verifying expanded image", done, total, name),
          );

          await validateWipeImage(file, wipe.id, preparationSignal);
          hash = wipe.partitionSha256;
        } else if (asset.id === "boot") {
          const payload = await extractBootPayload(file, build, preparationSignal);

          if (completeBoot) {
            validateLk2nd(new Uint8Array(await file.slice(0, LK2ND_PREFIX_BYTES).arrayBuffer()));
          } else {
            const composed = await composeBoot(
              directory,
              prefix,
              payload,
              build,
              preparationSignal,
              (done, total) => this.#progress("Preparing boot", done, total, name),
            );

            file = composed.file;
            hash = composed.sha256;
          }
        }

        files.set(asset.id, file);
        hashes.set(asset.id, hash);
        prepared.push({ name, bytes: file.size, sha256: hash });

        this.#update({
          preparedImages: [...prepared],
          imageProgress: this.#snapshot.imageProgress.filter((entry) => entry.partition !== name),
          ...(this.#snapshot.progress?.partition === name ? { progress: null } : {}),
        });
        this.#log("info", "Images", `${asset.name}: saved length and SHA-256 verified.`);
      }
    };

    await Promise.allSettled(
      Array.from({ length: Math.min(2, assets.length) }, async () => {
        try {
          await prepareNext();
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      }),
    );
    preparationSignal.throwIfAborted();

    this.#targets = names.map((name) => {
      const partition = partitions.find((entry) => entry.name === name);
      const file = files.get(name);
      const hash = hashes.get(name);

      if (!partition || !file || !hash || BigInt(file.size) !== partition.bytes) {
        throw new Error(`Prepared ${name} does not fit its exact live partition.`);
      }

      return { name, partition, file, sha256: hash };
    });

    this.#update({
      phase: "install-ready",
      stage: "flash",
      progress: null,
      imageProgress: [],
      preparedImages: this.#targets.map((target) => ({
        name: target.name,
        bytes: target.file.size,
        sha256: target.sha256,
      })),
    });

    this.#log(
      "info",
      "Images",
      "All images staged and verified. No partition writes have occurred.",
    );
  }

  /** One confirmation covers the selected writes, including the bundled loader and wipes. */
  flash = (acceptsOverwrite: boolean): void => {
    this.#run(
      async (signal) => {
        const { firehose, gpt, storage } = this.#verifiedDevice();
        const mode = this.#installMode();
        const names = selectedPartitionNames(mode, this.#snapshot.flashPartitions);
        const completeBoot = names.includes("boot") && this.#snapshot.bootMode === "complete";
        const preserveBoot = names.includes("boot") && this.#snapshot.bootMode === "preserve-lk2nd";

        if (
          !acceptsOverwrite ||
          this.#snapshot.backupDecision === "pending" ||
          this.#snapshot.stage !== "flash" ||
          this.#snapshot.writesStarted
        ) {
          throw new Error("Confirm overwriting the selected partitions before flashing.");
        }

        this.#update({
          stage: "flash",
          confirmations: { acceptsOverwrite },
        });

        await this.#prepareImages(signal);

        if (
          this.#targets.map((target) => target.name).join(",") !== names.join(",") ||
          !this.#snapshot.preparedImages ||
          !this.#prefixHash
        ) {
          throw new Error("Prepared images do not match the confirmed selection.");
        }

        this.#update({ phase: "verifying", progress: null });
        this.#activeUsesUsb = true;

        // Recheck the device geometry, not gigabytes of already-verified image files.
        const fresh = await inspectGpt(firehose, storage, this.#log);
        installPartitions(fresh, mode, names);

        if (!sameGpt(fresh, gpt)) {
          throw new Error("Live GPT changed after inspection.");
        }

        const oemFilesystemVerified = await inspectOemFilesystem(firehose, fresh);
        this.#update({ oemFilesystemVerified });

        if (!oemFilesystemVerified && !names.includes("oem")) {
          this.#log(
            "warning",
            "Metadata",
            "OEM is not ext4 and is not selected for formatting. Android may not boot.",
          );
        }

        const boot = installPartitions(fresh, mode).find((entry) => entry.name === "boot");

        if (!boot) {
          throw new Error("Verified live boot partition is missing.");
        }

        const prefix = await firehose.readSectors(boot.firstLba, LK2ND_PREFIX_BYTES / 512);
        if ((preserveBoot ? validateLk2nd(prefix) : hex(sha256(prefix))) !== this.#prefixHash) {
          throw new Error("Installed lk2nd changed after boot composition.");
        }

        this.#update({
          writes: this.#targets.map((target) => ({
            name: target.name,
            startLba:
              target.partition.firstLba +
              (target.name === "boot" && !completeBoot ? BigInt(LK2ND_PREFIX_BYTES / 512) : 0n),
            imageBytes: target.file.size,
            imageSha256: target.sha256,
            sentSha256: null,
            writeBytes:
              target.file.size - (target.name === "boot" && !completeBoot ? LK2ND_PREFIX_BYTES : 0),
            writtenBytes: 0,
            status: "pending",
          })),
        });

        await this.#writeJournal();
        signal.throwIfAborted();

        // No write permissions are granted until every selected image and live range passes.
        await firehose.enableWrites(mode, names, this.#snapshot.bootMode);

        for (const target of this.#targets) {
          const reserved = target.name === "boot" && !completeBoot ? LK2ND_PREFIX_BYTES : 0;
          const digest = sha256.create();

          // Preserve mode compares the logical full image, including the untouched live prefix.
          if (reserved) {
            digest.update(prefix);
          }

          this.#update({ phase: "flashing", writesStarted: true });
          this.#writeStatus(target.name, { status: "writing" });
          this.#progress("Flashing", 0, target.file.size - reserved, target.name);
          await this.#writeJournal();

          this.#log(
            "warning",
            "Flash",
            `Writing ${target.name}. Do not unplug or close this page.`,
          );

          await firehose.programSectorsFrom(
            target.name,
            0,
            (target.file.size - reserved) / 512,
            async (offset, length) => {
              const bytes = new Uint8Array(
                await target.file
                  .slice(reserved + offset, reserved + offset + length)
                  .arrayBuffer(),
              );
              signal.throwIfAborted();
              digest.update(bytes);
              return bytes;
            },
            signal,
            (written) => {
              this.#writeStatus(target.name, { writtenBytes: written });
              this.#progress("Flashing", written, target.file.size - reserved, target.name);
            },
          );

          const sentHash = hex(digest.digest());
          this.#writeStatus(target.name, { sentSha256: sentHash });

          if (sentHash !== target.sha256) {
            throw new Error(
              `${target.name} transmitted image SHA-256 mismatch. Installation stopped; do not reboot.`,
            );
          }

          this.#writeStatus(target.name, { status: "written" });
          await this.#writeJournal();

          this.#log(
            "info",
            "Flash",
            `${target.name}: image hash matched; every program command acknowledged.`,
          );
        }

        await firehose.configure();

        const after = await inspectGpt(firehose, storage, this.#log);

        if (!sameGpt(after, fresh)) {
          throw new Error("GPT changed during flashing. Do not reboot.");
        }

        signal.throwIfAborted();
        await this.#writeJournal("complete");

        if (this.#backupDirectory) {
          await writeJson(this.#backupDirectory, "flash-report.json", this.#report("complete"));
        }

        signal.throwIfAborted();
        this.#update({ phase: "complete", stage: "finish", progress: null });

        this.#log(
          "info",
          "Flash",
          `Flashed ${names.length} partitions. Firehose acknowledged every write; transmitted image hashes matched. Full readback was not performed.`,
        );
      },
      { budgetMs: 3 * 60 * 60 * 1000 },
    );
  };

  #writeStatus(name: WritePartitionName, update: Partial<WriteRecord>) {
    this.#update({
      writes: this.#snapshot.writes.map((entry) =>
        entry.name === name ? { ...entry, ...update } : entry,
      ),
    });
  }

  #report(phase = this.#snapshot.phase) {
    return {
      formatVersion: 3,
      verification: "source-sha256-and-firehose-ack",
      readbackPerformed: false,
      build: this.#snapshot.build?.id ?? null,
      installMode: this.#snapshot.installMode === null ? null : this.#installMode(),
      wipePreset: this.#snapshot.installMode,
      bootMode: this.#snapshot.bootMode,
      flashPartitions: this.#snapshot.flashPartitions,
      backupPartitions: this.#snapshot.backupPartitions,
      autoSkippedPartitions: this.#snapshot.autoSkippedPartitions,
      matchingImagePartitions: matchingBackupPartitions(
        this.#snapshot.build,
        this.#snapshot.bootMode,
        this.#snapshot.backups,
      ),
      skippedFlashPartitions: installPartitionNames("clean").filter(
        (name) => !this.#snapshot.flashPartitions.includes(name),
      ),
      unbackedFlashPartitions: partitionsWithoutBackup(
        this.#snapshot.flashPartitions,
        this.#snapshot.backups,
      ),
      confirmations: this.#snapshot.confirmations,
      backups: this.#snapshot.backups,
      gptBackupRequested: this.#snapshot.backupGpt,
      gptBackups: this.#snapshot.gptBackups,
      oemFilesystemVerified: this.#snapshot.oemFilesystemVerified,
      phase,
      error: this.#snapshot.error,
      capturedAt: new Date().toISOString(),
      identity: this.#snapshot.identity,
      diskGuid: this.#snapshot.gpt?.primary.diskGuid,
      backupDecision: this.#snapshot.backupDecision,
      prefixSha256: this.#prefixHash,
      lk2ndAction:
        this.#snapshot.flashPartitions.includes("boot") && this.#snapshot.bootMode === "complete"
          ? "replace"
          : "preserve",
      images: this.#snapshot.preparedImages,
      writesStarted: this.#snapshot.writesStarted,
      writes: this.#snapshot.writes,
    };
  }

  async #writeJournal(phase = this.#snapshot.phase) {
    if (!this.#staging) {
      throw new Error("The private installation staging directory is unavailable.");
    }
    await writeJson(this.#staging.directory, "flash-report.json", this.#report(phase));
  }

  async #clearStaging() {
    if (this.#staging) {
      await removeStaging(this.#staging);
      this.#staging = null;
    }
    this.#targets = [];
    this.#update({ preparedImages: null, imageProgress: [], selectionLocked: false });
  }

  restart = (): void => {
    this.#run(
      async (signal) => {
        const { firehose } = this.#verifiedDevice();
        if (
          !(
            (this.#snapshot.phase === "complete" &&
              this.#snapshot.writes.length > 0 &&
              this.#snapshot.writes.length === this.#snapshot.flashPartitions.length &&
              this.#snapshot.writes.every((entry) => entry.status === "written")) ||
            (this.#snapshot.phase === "unchanged" &&
              !this.#snapshot.writesStarted &&
              this.#snapshot.flashPartitions.length === 0)
          )
        ) {
          throw new Error("Restart requires a completed installation or no-write session.");
        }
        this.#update({ phase: "restarting" });
        await firehose.reset();
        signal.throwIfAborted();
        await this.#close();
        await this.#clearStaging();
        this.#update({ phase: "finished", progress: null });
        this.#log("info", "Device", "Restart acknowledged. Check Android startup on the device.");
      },
      { usesUsb: true },
    );
  };

  /** Cancel the active operation; a partial write is never described as a safe rollback. */
  disconnect = (): Promise<void> | void => {
    if (this.#controller) {
      this.#controller.abort(new DOMException("Operation cancelled by the user.", "AbortError"));
      this.#update({ phase: "closing" });
      if (this.#activeUsesUsb) {
        void this.#close().catch((error: unknown) =>
          this.#log("error", "USB cleanup", describeError(error)),
        );
      }
    } else {
      return this.#run(async () => {
        this.#update({ phase: "closing" });
        await this.#close();
        await this.#clearStaging();
        this.#update({
          phase: this.#programmer ? "ready" : "idle",
          stage: "connection",
          progress: null,
        });
        this.#log(
          "info",
          "Session",
          "USB handle closed. Programmer may remain in device RAM; re-enter EDL before connecting again.",
        );
      });
    }
  };

  #onDisconnect = (event: USBConnectionEvent): void => {
    if (event.device !== this.#device || ["closing", "restarting"].includes(this.#snapshot.phase)) {
      return;
    }

    const error = new Error("USB device disconnected. Re-enter EDL before a new inspection.");

    if (this.#controller) {
      this.#controller.abort(error);
      void this.#close().catch((closeError: unknown) =>
        this.#log("error", "USB cleanup", describeError(closeError)),
      );
    } else {
      // An idle inspected session still owns USB. Use the same operation lock
      // while disposing it so a new Connect cannot race with this cleanup.
      this.#update({ connected: false, phase: "closing" });
      this.#run(
        async () => {
          throw error;
        },
        { usesUsb: true },
      );
    }
  };

  #onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.#snapshot.busy || this.#snapshot.connected) {
      event.preventDefault();
      event.returnValue = "";
    }
  };

  dispose(): void {
    window.removeEventListener("beforeunload", this.#onBeforeUnload);
    this.#flushLogs();
    if ("usb" in navigator) {
      navigator.usb.removeEventListener("disconnect", this.#onDisconnect);
    }

    if (this.#controller || this.#device) {
      this.disconnect();
      void this.#close().catch((error: unknown) =>
        this.#log("error", "USB cleanup", describeError(error)),
      );
    }
  }
}

export const inspector = new InstallerSession();

// Hot reload must close the old session, never silently preserve or reconnect it.
if (import.meta.hot) {
  import.meta.hot.dispose(() => inspector.dispose());
}
