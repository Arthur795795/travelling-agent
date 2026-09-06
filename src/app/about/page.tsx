import { modelInfo } from "../../config/model-info.ts";
export const dynamic = "force-dynamic";
export default function AboutPage() {
  const info = modelInfo();
  return (
    <main className="shell" id="main-content" tabIndex={-1}>
      <h1>关于旅行 Agent</h1>
      <p>
        帮助你整理可核验的中国城市旅行行程。AI
        辅助生成，具体开放规则、费用和预订请重新确认。
      </p>
      <p>
        模型：{info.model} · 服务提供方：{info.provider}
      </p>
      <p>
        模型备案信息：{info.registration} · 应用上线编号：{info.launch}
      </p>
      <p>
        Key
        仅临时用于请求，不写入浏览器存储、数据库或日志。普通行程保存在当前浏览器约
        30 天；临时任务 24 小时、分享 30 天、加密备份轮换 7 天。
      </p>
      <p>
        不绑定平台账户、不代订、不支付、不保证库存。关键事实出发前须复核。北京案例是固定模拟数据，人工出行核验待完成。
      </p>
    </main>
  );
}
