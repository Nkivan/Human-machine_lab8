export interface TokenBucket {
  take(n?: number): boolean;
}

// Token bucket: `burst` tokens max, refilled at `ratePerSec`. take() === false means "too fast".
export function createTokenBucket({
  ratePerSec,
  burst,
  now = () => performance.now(),
}: {
  ratePerSec: number;
  burst: number;
  now?: () => number;
}): TokenBucket {
  let tokens = burst;
  let last = now();
  return {
    take(n = 1) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSec);
      last = t;
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    },
  };
}
