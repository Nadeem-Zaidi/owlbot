import { FileEntry, IFileStore } from "./ifilestore";

type ProcessFile<T> = (
  key: string,
  stream: AsyncIterable<Buffer>
) => AsyncGenerator<T>;

interface ProcessOptions {
  workerCount?: number;
  highWaterMark?: number;
  signal?: AbortSignal;
}

/**
 * List -> N-worker pool -> backpressured async generator.
 *
 * This is the exact concurrency pattern your S3Reader.read_txt_files already
 * had (list pump filling a queue, workers draining it, a bounded out-buffer
 * with wakers for back-pressure) — just decoupled from S3 and from
 * txt/md-specific parsing. `processFile` is the only format-specific piece,
 * and `store` is the only backend-specific piece.
 */
export async function* processFiles<T>(
  store: IFileStore,
  prefix: string,
  extension: string,
  processFile: ProcessFile<T>,
  opts: ProcessOptions = {}
): AsyncGenerator<T> {
  const workerCount = opts.workerCount ?? 4;
  const highWaterMark = opts.highWaterMark ?? 100;

  const fileQueue: FileEntry[] = [];
  const outBuffer: T[] = [];
  let listDone = false;
  let workersDone = false;
  let workerError: unknown = null;
  let buffered = 0;

  let consumerWaker: (() => void) | null = null;
  let producerWakers: (() => void)[] = [];
  const wakeConsumer = () => {
    consumerWaker?.();
    consumerWaker = null;
  };
  const wakeProducers = () => {
    producerWakers.forEach((fn) => fn());
    producerWakers = [];
  };

  const push = async (item: T): Promise<void> => {
    while (buffered >= highWaterMark) {
      await new Promise<void>((r) => producerWakers.push(r));
      if (workerError) return; // abort if consumer threw
    }
    outBuffer.push(item);
    buffered++;
    wakeConsumer();
  };

  // ── Listing pump: paginates store.list(), feeds fileQueue ────────────────
  const listPump = async (): Promise<void> => {
    let token: string | undefined;
    try {
      do {
        const page = await store.list(prefix, token);
        for (const f of page.files) {
          if (f.key?.endsWith(extension)) fileQueue.push(f);
        }
        token = page.nextToken;
      } while (token);
    } finally {
      listDone = true;
    }
  };

  // ── Worker: dequeues files, streams them through processFile ─────────────
  const worker = async (): Promise<void> => {
    while (true) {
      const file = fileQueue.shift();
      if (!file) {
        if (listDone) break; // listing finished and queue empty
        await new Promise<void>((r) => setTimeout(r, 0)); // let listPump fill more
        continue;
      }
      if (opts.signal?.aborted) return;

      const stream = await store.readStream(file.key);
      for await (const item of processFile(file.key, stream)) {
        if (opts.signal?.aborted) return;
        await push(item);
      }
    }
  };

  const pipeline = Promise.all([
    listPump(),
    ...Array.from({ length: workerCount }, worker),
  ])
    .then(() => {
      workersDone = true;
      wakeConsumer();
    })
    .catch((err) => {
      workerError = err;
      workersDone = true;
      wakeConsumer();
    });

  // ── Consumer loop ──────────────────────────────────────────────────────
  try {
    while (!workersDone || outBuffer.length) {
      if (workerError) throw workerError;
      if (outBuffer.length) {
        const item = outBuffer.shift()!;
        buffered--;
        wakeProducers(); // unblock any back-pressured worker
        yield item;
      } else {
        await new Promise<void>((r) => (consumerWaker = r));
      }
    }
    if (workerError) throw workerError;
  } finally {
    await pipeline;
  }
}