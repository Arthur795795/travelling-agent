export const MODEL_NAME = "deepseek-v4-pro";
export function modelInfo(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    model: MODEL_NAME,
    provider: "DeepSeek（深度求索）",
    registration:
      env.MODEL_REGISTRATION_VERIFIED === "true" &&
      env.MODEL_REGISTRATION_ID?.trim()
        ? env.MODEL_REGISTRATION_ID.trim()
        : "待核实",
    launch:
      env.MODEL_LAUNCH_VERIFIED === "true" && env.MODEL_LAUNCH_ID?.trim()
        ? env.MODEL_LAUNCH_ID.trim()
        : "待核实",
  };
}
