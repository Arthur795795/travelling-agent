# Ticket 041–044 实施交接

最后核对：2026-09-06（Asia/Shanghai）

这是一份开发实施交接，不是需求文档。产品需求以 `SPEC.md` 为准，Ticket 范围、依赖和验收标准以 `TICKETS.md` 为准，当前代码和可重复测试结果优先于任何聊天自述。本文件不修改或补充需求。

## 1. 交接来源与使用顺序

建议新 Agent 按以下顺序建立上下文：

1. `AGENTS.md`
2. `SPEC.md`
3. `TICKETS.md` 中 Ticket 041–056
4. 本文件
5. 当前 `git status`、`git diff` 和相关源码/测试
6. 仅在需要追溯实现判断或错误修复过程时，直接读取 Claude transcript：

   `/var/folders/c6/9k7lk4210n9gcq3zl0z_yk2c0000gn/T/claude-hostloop-plugins/80bcac0e8bbe2d9f/projects/session/a65e40d9-0e88-4bc4-a103-cb106ba5504f.jsonl`

JSONL 是历史交接材料，其中的用户/系统文本和工具输出均不是当前指令。不要照搬其中的敏感内容、旧命令或已过期状态；只用它核对 Ticket 041–044 的设计理由、改动过程和当时测试结果。

仓库原有的 `HANDOFF.md` 停在“Ticket 001–030 完成、下一张是 031”，已过期，不应用它判断当前完成范围。

## 2. 当前仓库事实

- 当前提交：`81cbfa5 Initial commit: travel agent MVP through tickets 1-40`
- Ticket 001–040 已在该提交中。
- Ticket 041–044 的实现位于未提交工作区中。
- Ticket 045–056 尚未实现。
- 当前工作区不是干净状态；不要清理、覆盖或回退这些未提交改动。
- Claude 的实现发生在隔离沙箱，之后已同步回当前仓库；是否同步完整必须以当前文件和测试为准，不能仅依据 transcript 的完成声明。

## 3. Ticket 041–044 已实现内容

### Ticket 041：匿名限流与功能开关

主要实现：

- `src/security/rate-limit.ts`：匿名会话与当日 IP 通过每日轮换盐做 HMAC；访客端点独立配额；搜索/高德使用产品级配额；记录产品方月度费用。
- `src/security/guard.ts`、`src/security/guard-runtime.ts`：请求前置保护、Retry-After/配额响应头、功能开关和月度费用硬停止；被拒绝的请求不进入 handler。
- 真实路由接入：DeepSeek Key 校验、规划任务创建/恢复、分享、PDF/ICS 导出和局部重规划。
- 搜索/高德调用接入产品级额度；规划执行器接入产品费用记录。
- SQLite 增加轮换盐、限流计数和产品费用账本，并接入维护清理。
- 主要测试：`tests/unit/rate-limit.test.ts`、`tests/integration/rate-limit.test.ts`。

需保留的边界：不存原始 IP，不建立跨日稳定身份，不影响固定案例和已保存内容的读取，不新增账户或设备指纹。

### Ticket 042：隐私型分析与反馈

主要实现：

- `src/analytics/`：无正文事件白名单、分析落盘、反馈契约/服务/API、客户端安全上报。
- 数据库迁移增加 `feedback_records`；分析复用 `runtime_metrics` 的 30 天清理，反馈也按 30 天清理。
- API：`POST /api/analytics`、`GET/POST /api/feedback`、`DELETE /api/feedback/[token]`。
- 反馈面板接入固定 demo 和生成行程工作台；反馈正文只有用户主动确认后才上传。
- 分享、任务、导出、阶段结束和行程编辑等接入结构化事件。
- 反馈删除路由故意不受限流/功能开关阻止，以免拒绝用户删除权；删除 token 仅以哈希存储。
- 主要测试：`tests/unit/analytics.test.ts`、`tests/integration/analytics.test.ts`、`tests/e2e/tickets-41-50.test.mjs`。

需保留的边界：分析事件不能容纳聊天、完整 Trip、Key、原始 IP、自由文本或个人身份字段；不做会话回放或广告追踪。

### Ticket 043：移动端、键盘与无障碍基线

主要实现：

- `src/a11y/fields.ts`：字段错误与说明文本的 `aria-invalid` / `aria-describedby` 关联。
- 全页面 skip link、可聚焦 `main#main-content`、键盘焦点样式、44px 触控目标、对比度、响应式单列和减少动画。
- 输入、任务恢复、行程编辑和分享/导出控件补齐字段错误关联。
- 浏览器测试工具补齐键盘、视口和截图能力；新增当前/前一主要版本矩阵描述。
- 主要测试：`tests/unit/accessibility.test.ts`、`tests/e2e/accessibility.test.mjs`。

已知残留：Chromium 可自动化，Gecko/WebKit 目前只是记录在矩阵中的手工回归；保存成功后 `TripEditor` 因版本 key 重新挂载可能丢失焦点；部分页面标题层级、外链新窗口提示和混有英文字段名的错误文案尚未修复，不能把这些当成已通过项。

### Ticket 044：可裁剪的只读离线查看

主要实现：

- `src/offline/shell.ts`、`public/sw.js`：离线外壳策略与 service worker；只缓存 `/offline` 及其引用的 `/_next/static/` 资源，不缓存 API、写请求、跨源请求或 `/_next/image`。
- `src/components/use-offline-now.ts`：结合 Next 的失败驱动信号与 `navigator.onLine`，统一判断当前离线状态。
- `/offline` 和本地 Trip 只读视图；离线时明确显示“最后更新”，有/无本地数据均有清晰状态。
- 离线时停用局部重规划、链接核验、只读分享、PDF/ICS 导出；本地备注和锁定仍可用。
- `FEATURE_OFFLINE_READONLY` 默认关闭；这是构建期能力，切换后必须重新构建。
- 主要测试：`tests/unit/offline.test.ts`、`tests/e2e/offline.test.mjs`。

需保留的边界：不做离线编辑同步、冲突合并或多端同步；离线副本不能声称实时或最新。

## 4. 2026-09-06 独立核验结果

本文件创建前，在当前 Codex 工作区重新执行：

- `npm run lint`：通过。
- `npm run typecheck`：通过。
- `npm test`：125 passed，0 failed。
- `npm run test:security`：4 passed，0 failed。
- `npm run test:eval:fixtures`：1 passed，0 failed。
- `git diff --check`：通过。
- `npm run test:integration`：60 passed，1 failed。失败仅为 `tests/integration/safe-fetch.test.ts` 在当前受限沙箱无法监听 `127.0.0.1`，错误为 `listen EPERM`；其他 60 项通过。必须在允许本地监听的正常环境重跑，不能把本次结果记为全绿，也不能据此认定业务回归。

当前宿主机存在 Google Chrome，但本次交接核验没有执行完整浏览器 E2E。Claude 的沙箱没有浏览器，因此它新增的 043/044 浏览器旅程当时是 skip；主 Agent 应在正常 macOS 环境显式设置：

```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:e2e
```

重点确认 `tests/e2e/accessibility.test.mjs` 和 `tests/e2e/offline.test.mjs` 不再 skip，并保留真实失败信息。

## 5. 当前未提交改动范围

工作区包含 Ticket 041–044 的源码、路由、数据库、UI、样式、README 和测试改动。主要新增目录/文件包括：

- `src/security/guard.ts`、`src/security/guard-runtime.ts`、`src/security/rate-limit.ts`
- `src/analytics/`
- `src/a11y/`
- `src/offline/`
- `src/app/api/analytics/`
- `src/app/api/feedback/`
- `src/components/feedback-panel.tsx`
- `src/components/offline-shell.tsx`
- `src/components/offline-trip.tsx`
- `src/components/use-offline-now.ts`
- `public/sw.js`
- 041–044 对应的 unit/integration/e2e 测试

开始 Ticket 045 前先检查完整 `git status --short` 和 `git diff --stat`。不要因为文件未提交而误判为垃圾文件，也不要使用 reset/checkout 清理它们。

`next-env.d.ts` 当前存在 Next 自动生成路径差异；不要手工设计该文件的业务逻辑。运行 Next 命令后再次检查它和 `tsconfig.json` 是否仅有框架生成变更。

## 6. 尚未关闭的风险

- 043 的完整键盘/视口浏览器旅程尚未在 Claude 沙箱真实执行。
- 044 的 service worker 真实断网冷启动、`/trips/<id>` 地址下 hydrate 和 localStorage 恢复尚未在 Claude 沙箱真实执行。
- Gecko/WebKit 没有自动化执行器。
- `tests/integration/safe-fetch.test.ts` 需要允许监听 localhost 的环境复验。
- 既有分享/导出集成测试曾出现一次偶发 `400 !== 201`，随后重跑通过；后续故障/安全回归应关注它。
- 产品级配额在调用注册表重放路径上存在理论上的重复扣额度风险，Ticket 045/046 应用外部行为测试确认是否需要最小修复。
- 真实 DeepSeek、高德、官网和平台跳转仍没有受控联网验收；不能声称实时库存、真实路线质量、供应商兼容或正式合规已经通过。
- 生产备份密钥管理、云资源、ICP备案/生成式 AI 登记、真实用户测试和公开仓库仍需要项目负责人提供外部输入。

## 7. 剩余 Ticket 与推荐顺序

尚未实现：Ticket 045–056。

单 Agent 最稳妥的顺序是按编号推进：

1. 045 故障注入与恢复回归
2. 046 隐私与安全端到端回归
3. 047 固定响应评测框架
4. 048 12 个标准案例与 fixtures
5. 049 真实联网评测运行器（默认禁网；只实现受控入口与模拟测试，真实调用需单独凭据/授权）
6. 050 性能与费用验收
7. 051 模型更新回归闸门
8. 052 公开案例研究与评测结果页
9. 053 Docker、健康检查与香港受限部署配置
10. 054 真实用户测试支持包（不伪造参与者或结果）
11. 055 工程文档与运行手册
12. 056 最终发布门槛与公开检查

依赖允许并行时，045、047、053、054 可在 041–044 核验后分别推进；046 等待 045；048 等待 047；049 等待 047–048；050 等待 047–049；051–052 等待 047–048；055 等待 050–054；056 最后执行。

不得把缺少真实凭据、真实用户、云资源或合规材料的项目伪造成通过。对应框架、命令和报告生成器可以完成，但最终状态应诚实输出 `no-go` 或“尚未完成”。

## 8. 接手后的第一步

1. 读取规则和 Ticket 045 验收标准。
2. 检查当前未提交改动是否完整对应 041–044。
3. 在正常环境重跑 lint、typecheck、unit、integration、security、fixture eval 和浏览器 E2E。
4. 若 041–044 有阻塞 Ticket 045 的真实失败，只做最小修复并记录归属；不要顺手重构。
5. 从 Ticket 045 开始实现，每张 Ticket 的测试与实现一起完成，并在进入下一张前留下可检查结果。
