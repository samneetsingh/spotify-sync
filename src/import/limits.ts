// Upload limits, shared by the routes (enforced) and the Import page (passed to public/import.js,
// which checks them before uploading).

import { isAudioHistoryFile } from "./parse";
import { MAX_ENTRY_BYTES } from "./zip";

export const MiB = 1024 * 1024;
/** R2 needs equal parts (except the last); 10 MiB stays far below the 100 MB request body limit. */
export const PART_SIZE = 10 * MiB;

export const LIMITS = {
  zipBytes: 300 * MiB,
  /** A loose JSON file is read whole, like one zip entry. */
  jsonBytes: MAX_ENTRY_BYTES,
  files: 40,
  totalBytes: 600 * MiB,
} as const;

/** Owner-facing check of one file: the export's zip, or one of its audio history JSON files, within the size limits. */
export function checkFile(name: string, size: number): string | null {
  const lower = name.toLowerCase();
  if (!Number.isSafeInteger(size) || size <= 0) return `${name} is empty.`;
  if (lower.endsWith(".zip")) return size > LIMITS.zipBytes ? `${name} is larger than ${LIMITS.zipBytes / MiB} MB.` : null;
  if (lower.endsWith(".json")) {
    if (!isAudioHistoryFile(name)) return `${name} isn't a listening history file: pick the Streaming_History_Audio_… files (or the whole zip).`;
    return size > LIMITS.jsonBytes ? `${name} is larger than ${LIMITS.jsonBytes / MiB} MB.` : null;
  }
  return `${name}: only the export's .zip or its .json files can be imported.`;
}
