/** Compares SHA-256 digests so timing depends on neither input's content nor length (/sync-full auth). */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [dA, dB] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const vA = new Uint8Array(dA);
  const vB = new Uint8Array(dB);
  let diff = 0;
  for (let i = 0; i < vA.length; i++) diff |= vA[i]! ^ vB[i]!;
  return diff === 0;
}

/** `bytes` random bytes as lowercase hex. */
export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
