export function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

export function nowMs(): number {
  return Date.now();
}
