# 旅行 Agent 开发交接

最后更新：2026-09-05（Asia/Shanghai）

本文件用于把项目交接给新的开发 Agent。它是当前实现状态和已确认决策的摘要；产品需求的唯一完整来源仍是 `SPEC.md`，开发顺序和每张 Ticket 的唯一完整来源仍是 `TICKETS.md`。不要仅根据本文件重新推断或改写需求。

## 新 Agent 的起点

先按以下顺序阅读：

1. `AGENTS.md`：项目规则。此项目使用 Next.js 16；写代码前必须阅读与任务相关的 `node_modules/next/dist/docs/` 指南。
2. `SPEC.md`：D1–D160 均已由用户确认。不要重新进行需求访谈，也不要擅自改变其中的决策。
3. `TICKETS.md`：按依赖顺序继续。Ticket 001–030 已完成；下一张是 Ticket 031。
4. 本文件：理解当前实现、验证基线和已知边界。
5. `README.md`：运行方式、环境变量和已实现功能的公开说明。

## 已确认且不得回退的关键产品决策

- 产品是中国境内自由行规划 Agent，而非攻略文章生成器；完整支持城市为北京、上海、重庆、西安、杭州。
- 仅支持 3–5 天、1–6 人、单一主要住宿城市，最多一个单程约两小时的一日游；重点覆盖国内火车与航班。
- 模型固定为 DeepSeek 官方 Responses API 的 `deepseek-v4-pro`。用户 BYOK；Key 仅存在于页面内存和单次后端请求，不写入数据库、浏览器存储、日志或环境文件。
- 不绑定携程/飞猪账户、不读取订单或实时库存；只提供搜索/预订跳转，标注查询时间且要求用户二次确认。用户可以手输已订酒店、车次和航班，并支持后续分享/导出。
- 不代订、不支付、不承诺价格/余票/库存/房态；没有可靠证据时必须显示 unknown、recheck 或 blocked，绝不能补零或编造事实。
- 用户界面的生成区域只显示模型名称和“AI 辅助生成”；服务提供方及备案信息在关于/产品详情页处理，未核实前不得伪造编号。
- 不做账户、多端同步、国际游、签证、主动监控、通用网页爬取、验证码绕过、地图瓦片嵌入或原始 reasoning 展示。

完整表述及所有 D 编号以 `SPEC.md` 为准。

## 当前完成范围：Ticket 001–030

### 领域、安全和基础设施（001–020）

- Zod 领域 Schema、SQLite 仓储、浏览器匿名行程存储、版本/证据/费用领域模型已就绪。
- 敏感信息拦截、Key 临时使用与清除、公开事件脱敏、安全页面读取、DeepSeek Responses、高德地点/路线/天气、搜索取证、平台链接、Evidence/Claim 归一化均已实现。
- 搜索仅用于发现候选；官网/专用 API 才能成为 verified 证据。未验证来源不得升级为事实。
- 需求检查和行程骨架已实现；骨架不会声称库存、价格、开放时间等未核验事实。

### 规划闭环（021–026）

- `src/agent/pipeline.ts` 串联七个阶段：`requirements_check` → `skeleton_planning` → `evidence_collection` → `route_and_budget` → `hard_validation` → `repair` → `finalization`。
- `src/agent/enrichment.ts` 负责地点、官网规则、天气、路线、预算和平台搜索入口的初稿补全。工具失败、歧义、无路线或未知价格会保留显式风险，不伪造零值。
- `src/validation/trip.ts` 确定性检查日期/范围/密度、营业窗口、活动和交通时间链、锁定预订、预算、证据、禁止库存措辞。费用 unknown 不能被已知总额掩盖。
- `src/agent/repair.ts` 最多两轮修复；修复不得改变 brief、锁定项、evidence、claims、费用或不受影响日期。无法修复的结果为 `blocked` 并提供 1–2 个选择。
- `src/jobs/` 实现 SQLite 持久化阶段状态、编号事件、调用日志、单进程并发去重、180 秒超时、取消、重启恢复和 Key 丢失等待。已确认调用结果会重放；结果未确认的外部调用会停止并报 `CALL_INTERRUPTED`，防止重复计费。
- API 已提供：
  - `POST /api/planning-jobs`
  - `GET /api/planning-jobs/[id]`
  - `GET /api/planning-jobs/[id]/events`（`Last-Event-ID` 重连）
  - `POST /api/planning-jobs/[id]/resume`
  - `POST /api/planning-jobs/[id]/cancel`
  - 创建返回匿名访问令牌；后续读取/恢复/取消需对应 HttpOnly Cookie 或 Bearer token。服务端仅保存 token 哈希。

### 页面（027–030）

- 首页、导航、`/plan` 的自然语言/结构化旅行简报、内存 Key 验证与清除、`/planning/[id]` 的 SSE/轮询进度、恢复/取消，以及 `/trips/[id]` 的只读时间线已实现。
- 时间线从同一个 `Trip` 读取，按时间渲染活动和交通，显示未知费用、缓冲、锁定、核心/可选/备选；桌面双栏、手机单栏；不嵌入地图瓦片。
- `/demo`、`/case-study`、`/about` 目前只是符合 Ticket 027 的入口占位，尚不是正式案例/关于内容。

## 当前重要文件与模块

| 目的 | 路径 |
| --- | --- |
| 产品决策和约束 | `SPEC.md` |
| Ticket 范围和验收标准 | `TICKETS.md` |
| 运行/配置说明 | `README.md`、`.env.example` |
| 领域模型 | `src/domain/schema.ts` |
| 需求与骨架 | `src/requirements/`、`src/agent/skeleton.ts` |
| 规划、取证、修复 | `src/agent/pipeline.ts`、`src/agent/enrichment.ts`、`src/agent/repair.ts` |
| 硬校验 | `src/validation/trip.ts` |
| 任务执行/API | `src/jobs/`、`src/app/api/planning-jobs/` |
| 页面组件 | `src/components/planning-form.tsx`、`src/components/job-progress.tsx`、`src/components/trip-timeline.tsx` |
| Provider/工具 | `src/providers/`、`src/search/`、`src/platform/`、`src/agent/tools/` |
| 测试 | `tests/unit/`、`tests/integration/`、`tests/e2e/`、`tests/security/`、`tests/eval/` |

## 继续开发顺序

严格遵守 `TICKETS.md` 的依赖顺序。建议接手后首先实现：

1. Ticket 031：预算、证据、状态和阻塞提醒界面。
2. Ticket 032：直接编辑、锁定与本地版本记录。
3. Ticket 033：重大修改预览和局部重规划。
4. Ticket 034：北京四日规范案例数据。
5. Ticket 035：无 Key 的预设重规划场景。

随后按 Ticket 036–056 的既定顺序继续分享、导出、AI 标识、数据清理、限流、评测、部署与发布门槛。不要为了“让 demo 看起来完整”跳过 Ticket 031–035，或将其需求提前塞进 Ticket 030。

## 验证基线（2026-09-05）

以下命令在本地、无真实外部凭据条件下通过：

```bash
npm run lint
npm run typecheck
npm test                 # 60 passed
npm run test:integration # 46 passed
npm run test:e2e         # 2 passed
npm run test:security    # 4 passed
npm run test:eval:fixtures # 1 passed（仅入口）
npm run test:eval:live     # 1 passed（确认默认关闭）
npm run build
```

浏览器 E2E 在 macOS 默认使用 Google Chrome；其他系统可设置 `CHROME_PATH`。测试使用固定模型/工具响应、临时 SQLite 和本地 HTTP；它们不构成真实 DeepSeek、高德、第三方平台、合规或数据许可验收。

## 环境与运行

```bash
cd "/Users/a48472/Desktop/vibecoding/旅行agent"
npm install
npm run dev
```

默认访问 `http://localhost:3000/`。默认 feature flags 全部关闭，因此可浏览页面但不会真实发起生成。仅在用户明确要求真实本地联调、且合法持有相应 Key 与许可时，才在本地环境文件中配置：

- `FEATURE_CUSTOM_GENERATION=true`
- `FEATURE_WEB_SEARCH=true`
- `FEATURE_AMAP=true`
- `AMAP_WEB_SERVICE_KEY=...`
- 经人工核验的 `OFFICIAL_SOURCE_HOSTS=...`

不要把访客 DeepSeek Key 写入 `.env`、测试 fixture、数据库或 README。`OFFICIAL_SOURCE_HOSTS` 当前默认只含故宫域名示例，不能被当作五城官方来源白名单。

## 已知限制与注意事项

- 尚未跑真实 DeepSeek/高德/平台的联网验收；不要声称真实行程、实时库存、真实路线质量或外部 API 兼容性已经验证。
- 官方页面中带“周一闭馆”、季节、节假日或暂停等条件的营业规则必须保留为待复核，不能直接填入未来日期。
- 当前执行器的运行中去重是单 Node 进程范围；跨多副本部署、任务队列和分布式锁属于后续部署设计，不要在无需求的 Ticket 中擅自引入。
- 取消可阻止后续调用，但无法撤销供应商已接受请求的潜在费用。
- 当前共享/导出、编辑、证据抽屉、预算面板、正式北京案例、预设场景、限流及生产部署尚未实现；不要把现有占位页误认为完成。
- 该目录没有可依赖的完整对话逐字稿。交接时应把 `SPEC.md` 与本文件提供给新 Agent；若需保留新的用户决定，请追加到 `SPEC.md` 或在本文件的“交接更新”中记录，并标明用户已确认。

## 交接更新

- 2026-09-05：Ticket 001–030 完成并通过上述本地基线。下一步为 Ticket 031。
