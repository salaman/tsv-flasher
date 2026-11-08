export function size(bytes: number | bigint): string {
  const value = Number(bytes);
  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  }
  if (value >= 1024 ** 2) {
    return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${value} B`;
}
