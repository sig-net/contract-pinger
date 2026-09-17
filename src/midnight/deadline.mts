/** Bound the caller's wait without releasing ownership of unfinished work. */
export function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  label: string
): Promise<T> {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    const abort = () => controller.abort(signal.reason);
    const timeout = () =>
      controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
    const timer = setTimeout(timeout, Math.max(0, timeoutMs));
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    controller.signal.addEventListener(
      'abort',
      () => {
        cleanup();
        reject(controller.signal.reason);
      },
      { once: true }
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    if (timeoutMs <= 0) timeout();
    if (controller.signal.aborted) return;
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .then(
        value => {
          if (Date.now() >= deadline) timeout();
          cleanup();
          if (!controller.signal.aborted) resolve(value);
        },
        error => {
          cleanup();
          reject(error);
        }
      );
  });
}
