/**
 * A concurrency limit: at most `max` calls of the returned runner are in progress at once; the rest
 * wait in arrival order. Used to bound exact re-reads of incomplete bodies and `ssh-keygen`
 * verifications, either of which a large window could otherwise start by the hundred.
 */
export type Limit = <T>(fn: () => Promise<T>) => Promise<T>;

export function limit(max: number): Limit {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('a limit needs a positive count');
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter, so `active` never dips and lets a newcomer in.
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}
