import { detectSensitiveText, type SensitiveDataKind } from "./redaction.ts";

export type SensitiveInputKind = SensitiveDataKind;

export type SensitiveInputResult =
  | { accepted: true }
  | { accepted: false; kind: SensitiveInputKind; message: string };

const messages: Record<SensitiveInputKind, string> = {
  api_key: "请不要在聊天中粘贴 API Key，请使用专用密钥输入框。",
  identity: "请移除完整证件号码后再发送。",
  phone: "请移除完整手机号后再发送。",
  passport: "请移除完整护照号码后再发送。",
  payment: "请移除完整支付卡号后再发送。",
  order: "请移除完整订单号，仅保留行程所需信息。",
  name: "请移除真实姓名后再发送。",
  home_address: "请移除家庭住址后再发送。",
};

export function validateChatInput(text: string): SensitiveInputResult {
  const kind = detectSensitiveText(text);
  return kind
    ? { accepted: false, kind, message: messages[kind] }
    : { accepted: true };
}
