/**
 * The thread that owns `fsharp.db` (see fsharp-store-owner.ts): it takes the
 * messages from its queue in order and writes the facts that have queued up
 * together, in one transaction.
 */
import { parentPort, workerData } from 'worker_threads';
import { openStoreForWriting, writeFileFacts, type FileFacts } from './fsharp-store';
import type { FsharpStoreMessage, FsharpStoreReply } from './fsharp-store-owner';

const port = parentPort!;
const reply = (message: FsharpStoreReply): void => port.postMessage(message);

let db: ReturnType<typeof openStoreForWriting> | null = null;
try {
  db = openStoreForWriting((workerData as { root: string }).root);
} catch (err) {
  reply({ type: 'error', message: err instanceof Error ? err.message : String(err) });
}

/** The files whose facts arrived since the last write. */
let queued: Array<{ file: string; facts: FileFacts }> = [];
let flushing = false;

function flush(): void {
  flushing = false;
  const batch = queued;
  queued = [];
  if (!db || batch.length === 0) return;
  try {
    writeFileFacts(db, batch);
  } catch (err) {
    reply({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

port.on('message', (message: FsharpStoreMessage) => {
  switch (message.type) {
    case 'facts':
      queued.push({ file: message.file, facts: message.facts });
      // What else is already queued arrives before this runs: it all goes in one transaction.
      if (!flushing) {
        flushing = true;
        setImmediate(flush);
      }
      return;
    case 'close':
      flush();
      db?.close();
      db = null;
      reply({ type: 'closed' });
      return;
  }
});
