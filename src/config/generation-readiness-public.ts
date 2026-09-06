export type GenerationReadinessCode =
  | "GENERATION_DISABLED"
  | "AMAP_DISABLED"
  | "AMAP_KEY_MISSING"
  | "WEB_SEARCH_DISABLED";

export const GENERATION_READINESS_MESSAGES: Record<
  GenerationReadinessCode,
  string
> = {
  GENERATION_DISABLED: "自定义生成尚未启用，固定北京案例仍可使用。",
  AMAP_DISABLED: "高德地点、路线和天气能力尚未启用，当前不能开始真实规划。",
  AMAP_KEY_MISSING: "服务端尚未配置高德 Key，当前不能开始真实规划。",
  WEB_SEARCH_DISABLED: "联网事实核验尚未启用，当前不能开始真实规划。",
};
