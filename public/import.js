// The Import page's uploader (the dashboard's only JavaScript; src/import/page.ts, routes.ts).
// Sends each chosen file to R2 through the Worker as a multipart upload in fixed-size parts,
// retrying each part, then starts the import. If the tab closes, choosing the files again starts
// over (R2 drops abandoned multipart uploads after 7 days). The helpers are exported for tests.

/** Byte ranges of each part: every part is `partSize` bytes except the last (R2 requires equal parts). */
export function partRanges(size, partSize) {
  const count = Math.max(1, Math.ceil(size / partSize));
  const parts = [];
  for (let i = 0; i < count; i++) parts.push({ partNumber: i + 1, start: i * partSize, end: Math.min(size, (i + 1) * partSize) });
  return parts;
}

/** Wait before retry `attempt` (1, 2, ...): 1 s, 2 s, 4 s ... capped at 10 s. */
export function backoffMs(attempt) {
  return Math.min(10_000, 1000 * 2 ** (attempt - 1));
}

export function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const AUDIO = /^(?:Streaming_History_Audio_.*|endsong_.*)\.json$/i;

/**
 * The same checks as the server (src/import/limits.ts), before anything is sent: the export's zip
 * or its audio history JSON files, within the limits. Returns an error message or null.
 */
export function checkFiles(files, limits) {
  if (!files.length) return "Choose the zip from Spotify, or the JSON files inside it.";
  if (files.length > limits.files) return `At most ${limits.files} files per import.`;
  let total = 0;
  for (const f of files) {
    const name = f.name.toLowerCase();
    total += f.size;
    if (!f.size) return `${f.name} is empty.`;
    if (name.endsWith(".zip")) {
      if (f.size > limits.zipBytes) return `${f.name} is larger than ${formatBytes(limits.zipBytes)}.`;
    } else if (name.endsWith(".json")) {
      if (!AUDIO.test(f.name)) return `${f.name} isn't a listening history file: pick the Streaming_History_Audio_… files (or the whole zip).`;
      if (f.size > limits.jsonBytes) return `${f.name} is larger than ${formatBytes(limits.jsonBytes)}.`;
    } else {
      return `${f.name}: only the export's .zip or its .json files can be imported.`;
    }
  }
  if (total > limits.totalBytes) return `At most ${formatBytes(limits.totalBytes)} per import.`;
  return null;
}

/** Runs `fn` up to `tries` times, waiting backoffMs between attempts; `sleep` is injectable for tests. */
export async function withRetry(fn, tries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || (err && err.final)) throw err;
      await sleep(backoffMs(attempt));
    }
  }
}

/** A same-origin JSON call; 4xx answers are final (no retry), with the server's message. */
async function call(method, path, body) {
  const init = { method, credentials: "same-origin", headers: {} };
  if (body instanceof Blob) init.body = body;
  else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const err = new Error(data.error || (res.status === 401 ? "Your session has ended. Log in again and retry." : `Upload failed (${res.status}).`));
  err.final = res.status < 500;
  throw err;
}

/** Uploads `files` and starts the import; `progress(sent, total, label)` reports bytes sent. */
export async function upload(files, progress) {
  const total = files.reduce((s, f) => s + f.size, 0);
  let sent = 0;
  const { id } = await withRetry(() => call("POST", "/import/new"));
  for (const [i, file] of files.entries()) {
    const label = files.length > 1 ? `Uploading file ${i + 1} of ${files.length}` : "Uploading";
    const { n, uploadId, partSize } = await withRetry(() => call("POST", `/import/${id}/file`, { name: file.name, size: file.size }));
    const parts = [];
    for (const r of partRanges(file.size, partSize)) {
      const path = `/import/${id}/file/${n}/part/${r.partNumber}?u=${encodeURIComponent(uploadId)}`;
      parts.push(await withRetry(() => call("PUT", path, file.slice(r.start, r.end))));
      sent += r.end - r.start;
      progress(sent, total, label);
    }
    await withRetry(() => call("POST", `/import/${id}/file/${n}/complete`, { uploadId, parts }));
  }
  progress(total, total, "Starting the import");
  await withRetry(() => call("POST", `/import/${id}/start`));
}

function attach(form) {
  const input = form.querySelector('input[type="file"]');
  const button = form.querySelector("[data-import-submit]");
  const bar = form.querySelector("[data-import-progress]");
  const status = form.querySelector("[data-import-status]");
  const limits = {
    files: Number(form.dataset.maxFiles),
    zipBytes: Number(form.dataset.maxZip),
    jsonBytes: Number(form.dataset.maxJson),
    totalBytes: Number(form.dataset.maxTotal),
  };
  let busy = false;
  const say = (text) => (status.textContent = text);
  window.addEventListener("beforeunload", (e) => {
    if (busy) e.preventDefault();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const files = [...input.files];
    const problem = checkFiles(files, limits);
    if (problem) return say(problem);
    busy = true;
    button.disabled = input.disabled = true;
    bar.hidden = false;
    bar.value = 0;
    say("Uploading. Keep this tab open.");
    try {
      await upload(files, (done, total, label) => {
        const pct = Math.floor((done / total) * 100);
        bar.value = pct;
        bar.textContent = `${pct}%`;
        say(`${label}: ${formatBytes(done)} of ${formatBytes(total)} (${pct}%)`);
      });
      busy = false;
      location.assign("/import?ok=started");
    } catch (err) {
      busy = false;
      button.disabled = input.disabled = false;
      say(`${err.message} Nothing was imported; choose the files and try again.`);
    }
  });
}

if (typeof document !== "undefined") {
  const form = document.querySelector("[data-import-upload]");
  if (form) attach(form);
}
