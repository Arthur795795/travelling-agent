import type { FeatureFlags } from "./features.ts";
import {
  GENERATION_READINESS_MESSAGES,
  type GenerationReadinessCode,
} from "./generation-readiness-public.ts";

export type { GenerationReadinessCode } from "./generation-readiness-public.ts";

export type GenerationReadiness =
  | { ready: true }
  | { ready: false; code: GenerationReadinessCode; message: string };

/** Required product-side inputs before spending a visitor's model balance. */
export function localGenerationReadiness(
  flags: FeatureFlags,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GenerationReadiness {
  const unavailable = (code: GenerationReadinessCode): GenerationReadiness => ({
    ready: false,
    code,
    message: GENERATION_READINESS_MESSAGES[code],
  });
  if (!flags.customGeneration) return unavailable("GENERATION_DISABLED");
  if (!flags.amap) return unavailable("AMAP_DISABLED");
  if (!environment.AMAP_WEB_SERVICE_KEY?.trim())
    return unavailable("AMAP_KEY_MISSING");
  if (!flags.webSearch) return unavailable("WEB_SEARCH_DISABLED");
  return { ready: true };
}
