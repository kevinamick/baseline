// Run `fn` over `items` with at most `limit` in flight, returning results in input order. A
// rejection from any call propagates (the caller fails fast) and the first rejection stops every
// surviving runner from pulling new items, so a failed run does not keep executing (and metering)
// the rest of the queue; only the calls already in flight when the failure occurs settle.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function runner(): Promise<void> {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(runners);
  return results;
}
