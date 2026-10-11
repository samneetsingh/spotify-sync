// A small zip reader over random-access storage (R2 range reads): the central directory gives each
// entry's sizes and offset, so one entry can be inflated at a time without loading the whole
// archive. Only what Spotify's exports need: stored or deflated entries, no zip64, no encryption.

import { isAudioHistoryFile } from "./parse";

/** Uncompressed size cap per export file (Spotify's are about 13 MB). Also caps inflation (zip bombs). */
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
/** Entries in one archive (Spotify's extended history has about 25). */
export const MAX_ZIP_ENTRIES = 200;
const MAX_CENTRAL_DIRECTORY = 1024 * 1024;
const EOCD_SIZE = 22;
const EOCD_SEARCH = EOCD_SIZE + 0xffff; // the record plus the longest possible comment

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

/** A problem with the uploaded export, in words for the owner. Never retried. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export const NOT_EXTENDED_HISTORY =
  "This looks like the regular Account data export, which has no track IDs. Request \"Extended streaming history\" at spotify.com/account/privacy and upload that.";

/** Random access to one stored object. */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  stream(offset: number, length: number): Promise<ReadableStream<Uint8Array>>;
}

/** An R2 object as a ByteSource; a missing object is the owner's problem (expired upload). */
export function r2Source(bucket: R2Bucket, key: string, size: number): ByteSource {
  const get = async (offset: number, length: number) => {
    const obj = await bucket.get(key, { range: { offset, length } });
    if (!obj) throw new ImportError("The uploaded file is gone (uploads are kept for 7 days at most). Start a new import.");
    return obj;
  };
  return {
    size,
    read: async (offset, length) => (length ? new Uint8Array(await (await get(offset, length)).arrayBuffer()) : new Uint8Array()),
    stream: async (offset, length) => (length ? (await get(offset, length)).body : new Blob([]).stream()),
  };
}

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflate (others are rejected when read). */
  method: number;
  encrypted: boolean;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

const unreadable = (why: string) => new ImportError(`That zip can't be read (${why}). Upload the zip from Spotify as it came, or the JSON files inside it.`);

/** Every file entry in the archive's central directory (directories skipped). */
export async function listZipEntries(src: ByteSource): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, src.size - EOCD_SEARCH);
  const tail = await src.read(tailStart, src.size - tailStart);
  let at = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw unreadable("no zip directory found");
  if (at >= 20 && u32(tail, at - 20) === SIG_ZIP64_LOCATOR) throw unreadable("zip64 archives aren't supported");
  if (u16(tail, at + 4) !== 0 || u16(tail, at + 6) !== 0) throw unreadable("split archives aren't supported");
  const count = u16(tail, at + 10);
  const cdSize = u32(tail, at + 12);
  const cdOffset = u32(tail, at + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw unreadable("zip64 archives aren't supported");
  if (count > MAX_ZIP_ENTRIES) throw unreadable(`more than ${MAX_ZIP_ENTRIES} files inside`);
  if (cdSize > MAX_CENTRAL_DIRECTORY || cdOffset + cdSize > tailStart + at) throw unreadable("damaged directory");

  const cd = await src.read(cdOffset, cdSize);
  const names = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || u32(cd, p) !== SIG_CENTRAL) throw unreadable("damaged directory");
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const compressedSize = u32(cd, p + 20);
    const size = u32(cd, p + 24);
    const nameLength = u16(cd, p + 28);
    const extraLength = u16(cd, p + 30);
    const commentLength = u16(cd, p + 32);
    const offset = u32(cd, p + 42);
    if (p + 46 + nameLength > cd.length) throw unreadable("damaged directory");
    const name = names.decode(cd.subarray(p + 46, p + 46 + nameLength));
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw unreadable("zip64 archives aren't supported");
    if (!name.endsWith("/")) entries.push({ name, method, encrypted: (flags & 1) !== 0, compressedSize, size, offset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * The archive's audio history files (see isAudioHistoryFile), checked so each can be read:
 * not encrypted, stored or deflated, at most MAX_ENTRY_BYTES. None at all means the wrong export.
 */
export function audioEntries(entries: ZipEntry[]): ZipEntry[] {
  const audio = entries.filter((e) => isAudioHistoryFile(e.name));
  if (!audio.length) throw new ImportError(NOT_EXTENDED_HISTORY);
  for (const e of audio) {
    const base = e.name.split("/").pop();
    if (e.encrypted) throw new ImportError(`${base} is password-protected; upload the zip from Spotify as it came.`);
    if (e.method !== 0 && e.method !== 8) throw unreadable(`${base} uses an unsupported compression method`);
    if (e.size > MAX_ENTRY_BYTES) throw new ImportError(`${base} is larger than ${MAX_ENTRY_BYTES / 1024 / 1024} MB uncompressed; that isn't a Spotify history file.`);
  }
  return audio;
}

/** One entry's uncompressed bytes, as a stream. */
export async function zipEntryStream(src: ByteSource, entry: Pick<ZipEntry, "name" | "method" | "compressedSize" | "offset">): Promise<ReadableStream<Uint8Array>> {
  const header = await src.read(entry.offset, 30);
  if (header.length < 30 || u32(header, 0) !== SIG_LOCAL) throw unreadable(`damaged entry ${entry.name}`);
  const start = entry.offset + 30 + u16(header, 26) + u16(header, 28);
  if (start + entry.compressedSize > src.size) throw unreadable(`damaged entry ${entry.name}`);
  const raw = await src.stream(start, entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipeThrough(new DecompressionStream("deflate-raw"));
  throw unreadable(`${entry.name} uses an unsupported compression method`);
}

/** Decodes a stream as UTF-8, failing once it passes `maxBytes` (so a zip bomb stops early). */
export async function readTextLimited(stream: ReadableStream<Uint8Array>, maxBytes: number, what: string): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ImportError(`${what} is larger than ${maxBytes / 1024 / 1024} MB; that isn't a Spotify history file.`);
      parts.push(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    // DecompressionStream rejects corrupt data with a TypeError; anything else (storage) may be transient.
    if (err instanceof TypeError) throw unreadable(`${what} is damaged`);
    throw err;
  }
  parts.push(decoder.decode());
  return parts.join("");
}
