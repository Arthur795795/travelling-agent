export const DEEPSEEK_KEY_FAILURE_MESSAGES = {
  invalid_key: "Key 无效，请检查后重新输入。",
  quota_or_permission: "Key 所属账户余额不足，或没有使用当前模型的权限。",
  rate_limited: "DeepSeek 当前限流，请稍后再试。",
  RATE_LIMITED: "本项目的 Key 验证次数已达上限，请按提示稍后再试。",
  invalid_request: "DeepSeek 不接受当前验证参数，请更新项目后重试。",
  timeout: "DeepSeek 验证超时，请检查网络后重试。",
  network_error: "无法连接 DeepSeek，请检查网络或代理设置后重试。",
  upstream_error: "DeepSeek 服务暂时异常，请稍后再试。",
} as const;

export type DeepSeekKeyPublicFailureCode =
  keyof typeof DEEPSEEK_KEY_FAILURE_MESSAGES;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Converts only stable public codes to UI text. Raw upstream response bodies,
 * exception strings and credentials are never accepted as display content.
 */
export function describeDeepSeekKeyFailure(
  status: number,
  payload: unknown,
): { code: DeepSeekKeyPublicFailureCode; message: string } {
  const candidate = isObject(payload) ? payload.code : undefined;
  if (
    typeof candidate === "string" &&
    Object.hasOwn(DEEPSEEK_KEY_FAILURE_MESSAGES, candidate)
  ) {
    const code = candidate as DeepSeekKeyPublicFailureCode;
    return { code, message: DEEPSEEK_KEY_FAILURE_MESSAGES[code] };
  }
  const code: DeepSeekKeyPublicFailureCode =
    status === 429
      ? "RATE_LIMITED"
      : status === 401
        ? "invalid_key"
        : status === 402 || status === 403
          ? "quota_or_permission"
          : status === 400 || status === 422
            ? "invalid_request"
            : status === 408 || status === 504
              ? "timeout"
              : status >= 500
                ? "upstream_error"
                : "network_error";
  return { code, message: DEEPSEEK_KEY_FAILURE_MESSAGES[code] };
}
