/**
 * The one writer of `fsharp.db`: a thread of its own that takes each file's
 * facts from its queue in arrival order and writes what has queued up in one
 * transaction — the way `StoreWriter` owns `codegraph.db`. Nothing else opens
 * the store for writing, so no writer ever waits for another. Where the
 * compiled worker is not there (running from source), the main thread is the
 * writer, as it is for `codegraph.db`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { terminateOnceStarted, workerStarted } from '../../worker-teardown';
import { openStoreForWriting, writeFileFacts, type FileFacts } from './fsharp-store';

/** What the owner is sent: a file's facts, or the request to finish and close. */
export type FsharpStoreMessage = { type: 'facts'; file: string; facts: FileFacts } | { type: 'close' };

/** What the owner's thread answers. */
export type FsharpStoreReply = { type: 'closed' } | { type: 'error'; message: string };

export interface FsharpStoreOwner {
  /** Queue `facts` as what `file` holds now. */
  send(file: string, facts: FileFacts): void;
  /** Wait until everything queued is written, then close the store. */
  close(): Promise<void>;
}

/** The owner of `fsharp.db` of the project at `root`. */
export function startFsharpStoreOwner(root: string): FsharpStoreOwner {
  const script = path.join(__dirname, 'fsharp-store-worker.js');
  return fs.existsSync(script) ? new ThreadOwner(script, root) : new MainThreadOwner(root);
}

class MainThreadOwner implements FsharpStoreOwner {
  private readonly db;

  constructor(root: string) {
    this.db = openStoreForWriting(root);
  }

  send(file: string, facts: FileFacts): void {
    writeFileFacts(this.db, [{ file, facts }]);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class ThreadOwner implements FsharpStoreOwner {
  private readonly worker: Worker;
  private readonly started: Promise<void>;
  private readonly closed: Promise<void>;
  private failure: Error | null = null;

  constructor(script: string, root: string) {
    this.worker = new Worker(script, { workerData: { root } });
    this.started = workerStarted(this.worker);
    let onClosed!: () => void;
    let onFailed!: (err: Error) => void;
    this.closed = new Promise<void>((resolve, reject) => {
      onClosed = resolve;
      onFailed = reject;
    });
    this.worker.on('message', (reply: FsharpStoreReply) => {
      if (reply.type === 'closed') onClosed();
      else this.failure ??= new Error(`fsharp.db: ${reply.message}`);
    });
    this.worker.on('error', (err) => onFailed(err));
    this.worker.on('exit', (code) => onFailed(new Error(`fsharp.db owner exited with code ${code} before it closed`)));
  }

  send(file: string, facts: FileFacts): void {
    this.worker.postMessage({ type: 'facts', file, facts } satisfies FsharpStoreMessage);
  }

  async close(): Promise<void> {
    this.worker.postMessage({ type: 'close' } satisfies FsharpStoreMessage);
    try {
      await this.closed;
    } finally {
      await terminateOnceStarted(this.worker, this.started);
    }
    if (this.failure) throw this.failure;
  }
}
