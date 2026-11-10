// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import type { WorkerRequest, WorkerResult } from './worker-types';

// One disposable worker per operation: cancellation and timeouts stop parsing, not just the UI.
export function parseInWorker(
  request: WorkerRequest,
  signal: AbortSignal,
  onPartial?: (result: WorkerResult) => void,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./preview.worker.ts', import.meta.url), {
      type: 'module',
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timeout =
      Math.max(request.bytes.byteLength, request.entry?.size ?? 0) > 512 * 1024
        ? 120_000
        : 10_000;
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Parsing exceeded ${timeout / 1000} seconds and was stopped. You can switch to the file information preview.`,
        ),
      );
    }, timeout);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event) => {
      if (event.data.type === 'partial-result') {
        onPartial?.(event.data.result);
        return;
      }
      cleanup();
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
    };
    worker.onerror = () => {
      cleanup();
      reject(
        new Error('Parsing failed; the file may be corrupt or its format may be unsupported.'),
      );
    };
    worker.postMessage(request, [request.bytes.buffer as ArrayBuffer]);
  });
}
