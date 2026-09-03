/**
 * Runs `worker` over `items` with at most `limit` calls in flight at once, preserving
 * result order. Used to bound fan-out against external providers (e.g. Schwab) instead
 * of either running fully sequentially or an unbounded Promise.all.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const currentIndex = nextIndex++;
    if (currentIndex >= items.length) {
      return;
    }
    results[currentIndex] = await worker(items[currentIndex], currentIndex);
    await runNext();
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}
