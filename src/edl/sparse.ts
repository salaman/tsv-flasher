import { sha256 } from "@noble/hashes/sha2.js";
import { partitionPolicy, type WipeAsset } from "../../shared/profile";
import { dataView, hex } from "./diagnostics";
import { FILE_CHUNK_BYTES, hashFile, writeFile, type ByteProgress } from "./files";

/** Expand only the pinned sparse format, explicitly writing holes and final partition slack. */
export async function expandSparseWipe(
  directory: FileSystemDirectoryHandle,
  asset: WipeAsset,
  source: File,
  signal: AbortSignal,
  onProgress: ByteProgress,
  onSavedProgress: ByteProgress,
): Promise<File> {
  if (
    source.size !== asset.bytes ||
    (await hashFile(source, signal)) !== asset.sha256 ||
    source.size < 28
  ) {
    throw new Error(`The ${asset.id} sparse source does not match its pinned length and hash.`);
  }
  const header = dataView(new Uint8Array(await source.slice(0, 28).arrayBuffer()));
  const blockBytes = header.getUint32(12, true);
  const chunks = header.getUint32(20, true);
  const total = partitionPolicy(asset.id).bytes;
  if (
    header.getUint32(0, true) !== 0xed26ff3a ||
    header.getUint16(4, true) !== 1 ||
    header.getUint16(6, true) !== 0 ||
    header.getUint16(8, true) !== 28 ||
    header.getUint16(10, true) !== 12 ||
    blockBytes !== 4096 ||
    header.getUint32(16, true) * blockBytes !== asset.expandedBytes ||
    !chunks ||
    chunks > Math.floor((source.size - 28) / 12) ||
    header.getUint32(24, true) !== 0 ||
    asset.expandedBytes > total ||
    total - asset.expandedBytes >= blockBytes
  ) {
    throw new Error(`Unsupported ${asset.id} sparse header or expanded partition geometry.`);
  }

  const handle = await directory.getFileHandle(`${asset.id}-expanded.img`, { create: true });
  const digest = sha256.create();
  const fill = new Uint8Array(FILE_CHUNK_BYTES);
  const file = await writeFile(handle, async (writer) => {
    let cursor = 28;
    let written = 0;
    const write = async (bytes: Uint8Array) => {
      signal.throwIfAborted();
      digest.update(bytes);
      await writer.write(bytes.slice().buffer);
      written += bytes.length;
      onProgress(written, total);
    };

    for (let chunk = 0; chunk < chunks; chunk++) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await source.slice(cursor, cursor + 12).arrayBuffer());
      if (bytes.length !== 12) {
        throw new Error(`Truncated ${asset.id} sparse chunk header.`);
      }
      const info = dataView(bytes);
      const kind = info.getUint16(0, true);
      const expanded = info.getUint32(4, true) * blockBytes;
      const stored = info.getUint32(8, true);
      const expected = kind === 0xcac1 ? 12 + expanded : kind === 0xcac2 ? 16 : 12;
      if (
        ![0xcac1, 0xcac2, 0xcac3].includes(kind) ||
        info.getUint16(2, true) !== 0 ||
        expanded === 0 ||
        written + expanded > asset.expandedBytes ||
        stored !== expected ||
        cursor + stored > source.size
      ) {
        throw new Error(`Invalid or unsupported ${asset.id} sparse chunk.`);
      }

      if (kind === 0xcac2) {
        fill.set(new Uint8Array(await source.slice(cursor + 12, cursor + 16).arrayBuffer()), 0);
        for (let length = 4; length < fill.length; length *= 2) {
          fill.copyWithin(length, 0, length);
        }
      } else if (kind === 0xcac3) {
        fill.fill(0);
      }
      for (let offset = 0; offset < expanded; offset += FILE_CHUNK_BYTES) {
        const count = Math.min(FILE_CHUNK_BYTES, expanded - offset);
        const data =
          kind === 0xcac1
            ? new Uint8Array(
                await source
                  .slice(cursor + 12 + offset, cursor + 12 + offset + count)
                  .arrayBuffer(),
              )
            : fill.subarray(0, count);
        if (data.length !== count) {
          throw new Error(`Truncated ${asset.id} sparse chunk data.`);
        }
        await write(data);
      }
      cursor += stored;
    }

    if (
      cursor !== source.size ||
      written !== asset.expandedBytes ||
      hex(digest.clone().digest()) !== asset.expandedSha256
    ) {
      throw new Error(`The expanded ${asset.id} image differs from its pinned native hash.`);
    }
    // Userdata has seven final sectors outside the sparse filesystem. Zero them
    // deliberately so programming covers the complete physical partition.
    fill.fill(0);
    if (written < total) {
      await write(fill.subarray(0, total - written));
    }
    if (hex(digest.digest()) !== asset.partitionSha256) {
      throw new Error(`The full-partition ${asset.id} wipe hash does not match its pin.`);
    }
    signal.throwIfAborted();
  });

  onSavedProgress(0, total);
  if (
    file.size !== total ||
    (await hashFile(file, signal, onSavedProgress)) !== asset.partitionSha256
  ) {
    throw new Error(`Saved expanded ${asset.id} wipe verification failed.`);
  }
  return file;
}
