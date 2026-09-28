export { CheckoutSizes, type CheckoutSizesOptions } from "./checkout-sizes";
export { CleanupStore, diskUsage, planWorktreeCleanup, sweepLogs } from "./cleanup";
export { retireAgentReport, retireAgentStore, sweepReport, sweepSpoolAndLooms } from "./decommission-sweep";
export { checkoutRootsOf, DIRECTORY_CATEGORIES, measureDirectory, measureStore, withCheckouts } from "./measure";
export { reapNodeModules, reapReport, type ReapCandidate } from "./node-modules-reap";
export { detectCacheDedup, type CacheDedupVerdict } from "./package-caches";
