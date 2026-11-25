// Asset pipeline: fetch + retry + abort + progress + validation. Everything that crosses the network is `unknown` until parsed.
import { z } from "zod";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

// manifest.json is a boundary like any other: it is parsed by a schema, not trusted.
const AssetSpec = z.object({ url: z.string(), optional: z.boolean().optional() });
export const Manifest = z.object({
  sprites: z.record(z.string(), AssetSpec).default({}),
  frames: z.record(z.string(), z.tuple([z.number(), z.number(), z.number(), z.number()])).default({}),
  sounds: z.record(z.string(), AssetSpec).default({}),
  json: z.record(z.string(), AssetSpec).default({}),
});
export type Manifest = z.infer<typeof Manifest>;

export interface LoadedAssets {
  readonly images: Record<string, ImageBitmap | null>;
  readonly sounds: Record<string, AudioBuffer | null>;
  readonly json: Record<string, unknown>;
  readonly frames: Manifest["frames"];
  readonly failures: { name: string; error: unknown }[];
}

const REQUEST_TIMEOUT_MS = 5000;
const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

// 4xx = our mistake (never retry). 5xx, network failures and timeouts are transient.
function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500;
  return err instanceof TypeError || (err instanceof Error && err.name === "TimeoutError");
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

// signal.reason is `any` (it can be anything abort() was given): reject with an Error, never with an arbitrary value.
// (Found by the type-checked lint rule prefer-promise-reject-errors in Lab 7.)
function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("This operation was aborted", "AbortError");
}

// Hand-wrapped callback API (setTimeout) -> promise, cancellable via AbortSignal.
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(id);
      reject(abortError(signal));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const withTimeout = (signal: AbortSignal | undefined, ms: number): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

async function request(
  url: string,
  { signal, timeoutMs = REQUEST_TIMEOUT_MS }: RequestOptions = {},
): Promise<Response> {
  const res = await fetch(url, { signal: withTimeout(signal, timeoutMs) });
  if (!res.ok) throw new HttpError(res.status, url); // fetch does NOT reject on 404/500
  return res;
}

export async function fetchJson(url: string, opts?: RequestOptions): Promise<unknown> {
  return (await request(url, opts)).json(); // rejects with SyntaxError on corrupt JSON
}

export async function loadImage(url: string, opts?: RequestOptions): Promise<ImageBitmap> {
  return createImageBitmap(await (await request(url, opts)).blob());
}

export async function loadAudio(ctx: AudioContext, url: string, opts?: RequestOptions): Promise<AudioBuffer> {
  return ctx.decodeAudioData(await (await request(url, opts)).arrayBuffer());
}

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseMs?: number;
  readonly signal?: AbortSignal;
}

// Exponential backoff + full jitter. Never retries aborts or 4xx.
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 300, signal }: RetryOptions = {},
): Promise<T> {
  for (let i = 0; ; i++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      if (isAbort(err) || !isRetryable(err) || i >= attempts - 1) throw err;
      await delay(baseMs * 2 ** i * (0.5 + Math.random()), signal);
    }
  }
}

export interface LoadAllOptions {
  readonly ctx: AudioContext;
  readonly onProgress?: (fraction: number, name: string) => void;
  readonly signal?: AbortSignal;
  readonly sequential?: boolean;
}

// Concurrent by default (Promise.all) with per-item progress.
// Optional assets (sounds) that fail are recorded in `failures` instead of blocking the game.
export async function loadAll(
  manifest: Manifest,
  { ctx, onProgress = () => {}, signal, sequential = false }: LoadAllOptions,
): Promise<LoadedAssets> {
  const inner = new AbortController(); // lets us cancel siblings when a REQUIRED asset fails
  signal?.addEventListener("abort", () => inner.abort(signal.reason), { once: true });
  const s = inner.signal;

  const out: LoadedAssets = { images: {}, sounds: {}, json: {}, frames: manifest.frames, failures: [] };
  const tasks: (() => Promise<void>)[] = [];
  let done = 0;
  const total =
    Object.keys(manifest.sprites).length + Object.keys(manifest.sounds).length + Object.keys(manifest.json).length;

  // Generic over the asset type T: `store` knows where a T goes, so no casts are needed anywhere.
  function add<T>(name: string, optional: boolean, load: () => Promise<T>, store: (value: T | null) => void): void {
    tasks.push(async () => {
      try {
        store(await withRetry(load, { signal: s }));
      } catch (err) {
        if (isAbort(err) || !optional) throw err;
        out.failures.push({ name, error: err });
        store(null);
      }
      onProgress(++done / total, name);
    });
  }

  for (const [name, spec] of Object.entries(manifest.sprites))
    add(
      name,
      spec.optional ?? false,
      () => loadImage(spec.url, { signal: s }),
      (v) => {
        out.images[name] = v;
      },
    );
  for (const [name, spec] of Object.entries(manifest.sounds))
    add(
      name,
      spec.optional ?? false,
      () => loadAudio(ctx, spec.url, { signal: s }),
      (v) => {
        out.sounds[name] = v;
      },
    );
  for (const [name, spec] of Object.entries(manifest.json))
    add(
      name,
      spec.optional ?? false,
      () => fetchJson(spec.url, { signal: s }),
      (v) => {
        out.json[name] = v;
      },
    );

  try {
    if (sequential) for (const task of tasks) await task();
    else await Promise.all(tasks.map((task) => task()));
  } catch (err) {
    inner.abort(err); // stop the siblings; Promise.all alone would let them keep running
    throw err;
  }
  return out;
}
