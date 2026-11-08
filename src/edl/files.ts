import { sha256 } from "@noble/hashes/sha2.js";
import type { Asset } from "../../shared/profile";
import { describeError, hex } from "./diagnostics";

export const FILE_CHUNK_BYTES = 1024 * 1024;
export type ByteProgress = (completed: number, total: number) => void;

/** Commit only after the entire producer succeeds; abort partial filesystem writes. */
export async function writeFile(
  handle: FileSystemFileHandle,
  produce: (writer: FileSystemWritableFileStream) => Promise<void>,
): Promise<File> {
  const writer = await handle.createWritable();

  try {
    await produce(writer);
    await writer.close();
  } catch (error) {
    try {
      await writer.abort(error);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${describeError(error)} File cleanup also failed: ${describeError(cleanupError)}.`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
  return handle.getFile();
}

/** Hash disk-backed files in bounded chunks, including files just committed by the browser. */
export async function hashFile(
  file: File,
  signal: AbortSignal,
  onProgress?: ByteProgress,
): Promise<string> {
  const digest = sha256.create();

  for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer());
    signal.throwIfAborted();
    digest.update(bytes);
    onProgress?.(offset + bytes.length, file.size);
  }

  return hex(digest.digest());
}

export async function writeJson(
  directory: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  await writeFile(handle, async (writer) => {
    await writer.write(
      JSON.stringify(value, (_key, entry: unknown) =>
        typeof entry === "bigint" ? entry.toString() : entry,
      ),
    );
  });
}

export interface StagingDirectory {
  root: FileSystemDirectoryHandle;
  directory: FileSystemDirectoryHandle;
  name: string;
}

/** Allocate an isolated temporary directory, never an unbounded in-memory image cache. */
export async function createStaging(requiredBytes: number): Promise<StagingDirectory> {
  if (typeof navigator.storage?.getDirectory !== "function") {
    throw new Error("Private browser file storage is unavailable. Use desktop Chrome or Edge.");
  }

  const estimate = await navigator.storage.estimate();
  if (
    estimate.quota === undefined ||
    estimate.usage === undefined ||
    estimate.quota - estimate.usage < requiredBytes + 64 * 1024 * 1024
  ) {
    throw new Error("Insufficient browser storage quota for verified, disk-backed images.");
  }

  const root = await navigator.storage.getDirectory();
  const name = `thinksmart-staging-${crypto.randomUUID()}`;
  const directory = await root.getDirectoryHandle(name, { create: true });
  return { root, directory, name };
}

export async function removeStaging(staging: StagingDirectory): Promise<void> {
  await staging.root.removeEntry(staging.name, { recursive: true });
}

/** Verify both the download and its saved copy before publishing a staged image. */
export async function stageAsset(
  directory: FileSystemDirectoryHandle,
  asset: Asset,
  signal: AbortSignal,
  onProgress: ByteProgress,
  onSavedProgress: ByteProgress,
): Promise<File> {
  const response = await fetch(asset.url, {
    signal,
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok || !response.body) {
    throw new Error(`${asset.name} is unavailable (HTTP ${response.status}).`);
  }

  const length = response.headers.get("Content-Length");
  if (length !== null && Number(length) !== asset.bytes) {
    await response.body.cancel();
    throw new Error(`${asset.name} has an unexpected Content-Length.`);
  }

  const reader = response.body.getReader();
  const digest = sha256.create();
  let received = 0;
  let file: File;

  try {
    const handle = await directory.getFileHandle(`${asset.id}.img`, { create: true });
    file = await writeFile(handle, async (writer) => {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (received + value.length > asset.bytes) {
          throw new Error(`${asset.name} exceeds its pinned length.`);
        }

        // The network owns its chunk size; bound each hash/file operation ourselves.
        for (let offset = 0; offset < value.length; offset += FILE_CHUNK_BYTES) {
          signal.throwIfAborted();
          const chunk = value.slice(offset, offset + FILE_CHUNK_BYTES);
          digest.update(chunk);
          await writer.write(chunk.buffer);
          received += chunk.length;
          onProgress(received, asset.bytes);
        }
      }

      if (received !== asset.bytes || hex(digest.digest()) !== asset.sha256) {
        throw new Error(`${asset.name} length or SHA-256 does not match the pinned build.`);
      }
      signal.throwIfAborted();
    });

    const savedHash = await hashFile(file, signal, onSavedProgress);
    if (file.size !== asset.bytes || savedHash !== asset.sha256) {
      throw new Error(`${asset.name} saved-file verification failed.`);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${describeError(error)} Download cleanup failed: ${describeError(cleanupError)}.`,
        { cause: cleanupError },
      );
    } finally {
      reader.releaseLock();
    }
    throw error;
  }

  try {
    await reader.cancel();
  } finally {
    reader.releaseLock();
  }
  return file;
}
