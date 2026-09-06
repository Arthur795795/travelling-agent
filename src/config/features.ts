export const FEATURE_NAMES = [
  "customGeneration",
  "webSearch",
  "amap",
  "sharing",
  "export",
  // Offline read-only viewing is a secondary capability: it must be removable
  // without touching the planning loop, so it is a flag like any other.
  "offlineReadonly",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureFlags = Record<FeatureName, boolean>;

const ENV_NAMES: Record<FeatureName, string> = {
  customGeneration: "FEATURE_CUSTOM_GENERATION",
  webSearch: "FEATURE_WEB_SEARCH",
  amap: "FEATURE_AMAP",
  sharing: "FEATURE_SHARING",
  export: "FEATURE_EXPORT",
  offlineReadonly: "FEATURE_OFFLINE_READONLY",
};

export function loadFeatureFlags(
  environment: Record<string, string | undefined> = process.env,
): FeatureFlags {
  return Object.fromEntries(
    FEATURE_NAMES.map((feature) => [
      feature,
      environment[ENV_NAMES[feature]]?.toLowerCase() === "true",
    ]),
  ) as FeatureFlags;
}

export function requireFeature(
  flags: FeatureFlags,
  feature: FeatureName,
): { enabled: true } | { enabled: false; code: "FEATURE_DISABLED" } {
  return flags[feature]
    ? { enabled: true }
    : { enabled: false, code: "FEATURE_DISABLED" };
}

export function canOpenExperience(
  flags: FeatureFlags,
  experience: "existing_trip" | "fixed_demo" | "new_generation",
): { allowed: true } | { allowed: false; code: "FEATURE_DISABLED" } {
  if (experience !== "new_generation") return { allowed: true };
  return flags.customGeneration
    ? { allowed: true }
    : { allowed: false, code: "FEATURE_DISABLED" };
}
