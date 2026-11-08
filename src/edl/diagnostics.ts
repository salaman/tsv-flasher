export type LogLevel = "debug" | "info" | "warning" | "error";
export type Logger = (level: LogLevel, source: string, message: string) => void;

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  source: string;
  message: string;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
