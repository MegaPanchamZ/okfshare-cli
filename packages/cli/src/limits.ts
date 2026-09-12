/**
 * Local ceilings applied before any network call.
 *
 * These are the Free-tier defaults and act only as a floor: `resolveLimits`
 * widens them from the workspace entitlements the server returns on
 * `/api/workspace`, so a Pro workspace is not blocked client-side by caps its
 * plan has already raised. When the server is unreachable or the response omits
 * limits, these safe defaults apply rather than allowing an unbounded upload.
 */
export const LIMITS = {
  maxFiles: 25,
  maxFileBytes: 100_000,
  maxBundleBytes: 1_000_000,
  maxPathBytes: 240,
} as const;

export type BundleLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxBundleBytes: number;
  maxPathBytes: number;
};

/**
 * Widen the local ceilings with the caller's real entitlements.
 *
 * Only raises limits, never lowers them: the server is authoritative on the
 * write path, and a stale cached entitlement should not make a bundle that the
 * account can legitimately publish fail locally. Unknown or non-finite values
 * are ignored so a malformed response cannot open the caps.
 */
export function resolveLimits(
  entitlements: Record<string, unknown> | null | undefined,
): BundleLimits {
  if (!entitlements) return { ...LIMITS };
  return {
    maxFiles: wider(LIMITS.maxFiles, entitlements.maxFiles),
    maxFileBytes: wider(LIMITS.maxFileBytes, entitlements.maxFileBytes),
    maxBundleBytes: wider(LIMITS.maxBundleBytes, entitlements.maxBundleBytes),
    maxPathBytes: LIMITS.maxPathBytes,
  };
}

function wider(base: number, candidate: unknown): number {
  return typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate > base
    ? candidate
    : base;
}

/**
 * Hard absolute ceilings for retrieval, distinct from plan limits.
 *
 * A pull can originate from any publisher's workspace, so the reader's own
 * entitlements cannot bound it: a Free user must still pull a Pro-published
 * bundle. These mirror the server's read-path ceilings in
 * `worker/services/retrieval.ts` (the most permissive tier), and the server
 * write path guarantees nothing larger than this was ever stored.
 */
export const SAFE_MAX_LIMITS: BundleLimits = {
  maxFiles: 250,
  maxFileBytes: 500_000,
  maxBundleBytes: 10_000_000,
  maxPathBytes: 240,
};
