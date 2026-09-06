# 旅行 Agent

一个面向中国境内城市自由行的旅行规划 Agent。它不以“生成一篇攻略”为目标，而是通过需求澄清、工具调用、事实核验、路线与预算计算、确定性校验和局部修复，生成一份结构化、可编辑、有证据且可执行的行程。

## 当前状态

项目已完成 Ticket 001–056 的本地实现，当前发布结论仍由 `npm run release:check` 生成。缺少真实联网评测、5 人真实用户测试、香港部署资源及合规材料时必须保持 **no-go**，不能把本地固定测试写成正式发布通过。

- D1–D160 产品与工程决策已经确认。
- Ticket 001–010 已实现：工程基线、领域 Schema、SQLite 仓储、浏览器匿名存储、安全原语、安全页面读取、费用护栏、任务生命周期、证据冲突规则和 DeepSeek Key 临时验证。
- Ticket 011–020 已实现服务层与固定响应测试：DeepSeek Responses 流式适配、受约束工具注册表、高德地点/路线/天气、搜索发现与官方页面取证、平台跳转、证据归一化、需求检查和行程骨架。
- Ticket 021–030 已实现：取证/路线/预算初稿、确定性校验、两轮有限修复、持久化任务执行、HTTP/SSE/轮询/恢复/取消，以及首页、旅行简报与临时 Key、进度页和只读时间线。
- Ticket 031–040 已实现：预算与证据状态呈现、版本化编辑/撤销、确认式局部重规划、北京固定案例与三个无 Key 场景、只读分享、PDF/ICS 导出、模型披露和本地维护/加密备份。
- Ticket 041–044 已实现：请求/产品费用护栏、最小化匿名分析与可删除反馈、可访问性矩阵和可裁剪只读离线查看。
- Ticket 045–056 已实现本地可确定部分：故障与安全回归、12 案例/36 次固定评测、受控联网门槛、性能/模型回归、公开案例页、Docker/健康检查、用户测试支持包、运行手册和 fail-closed 发布闸门。

完整需求见 [SPEC.md](./SPEC.md)，开发拆分见 [TICKETS.md](./TICKETS.md)。

## 产品目标

用户输入出发地、目的地、日期、人数、预算、偏好和已预订项目后，系统使用 DeepSeek 调用地图、搜索和官方信息源，生成：

- 3–5 日结构化行程；
- 每日时间线、交通段和安全缓冲；
- 住宿区域、景点、餐饮和预算建议；
- 预约、开放时间等事实的来源与核验状态；
- 锁定项目、局部重规划和备选方案；
- 只读分享页、PDF 和 `.ics` 日历。

产品的核心证明是完整 Agent 闭环：

```text
澄清需求 → 生成骨架 → 搜索取证 → 路线与预算计算
         → 硬门槛校验 → 有限修复 → 可编辑结果
```

## MVP 范围

- 地域：中国境内城市旅行。
- 完整支持城市：北京、上海、重庆、西安、杭州。
- 行程：3–5 天、1–6 人、一个主要住宿城市。
- 周边：最多一个单程约 2 小时以内的一日游。
- 城际交通：重点覆盖国内火车和航班。
- 模型：DeepSeek 官方 API，核心模型 `deepseek-v4-pro`。
- 密钥：访客自带 DeepSeek Key；产品方提供高德 Key。
- 无 Key 体验：北京固定案例和 2–3 个预设重规划场景。

## 明确不做

- 用户账户、订单绑定和多端账户同步；
- 代订、支付、退改或实时库存承诺；
- 国际游、签证和多城连续旅行；
- 主动后台监控与通知；
- 社区、管理后台、返佣和商业排序；
- 多模型动态切换或静默降级；
- 完整离线编辑；
- 未获许可的地图嵌入、缓存或数据再利用；
- 任意网页抓取、验证码绕过或原始思维链展示。

## 建议技术形态

- Next.js + TypeScript；
- 单仓库、单 Docker 容器；
- Web/API 与任务执行器同容器、模块隔离；
- SQLite 保存任务、分享页和必要元数据；
- 浏览器保存普通匿名行程；
- SSE 推送任务进度，轮询作为后备；
- 固定响应评测与少量真实联网评测并行。

这些是已经确认的目标架构。具体依赖将在对应 ticket 中选择和验证。

## 运行与测试

要求 Node.js 22.6–24。安装依赖并启动开发服务器：

```bash
npm install
npm run dev
```

质量脚本：

```bash
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run test:e2e
npm run test:eval:fixtures
npm run test:eval:live
npm run test:security
npm run test:operations
npm run build
```

默认测试使用临时数据库和模拟外部响应，不要求真实密钥或网络。`test:eval:live` 只验证联网运行器的启用、预算和脱敏边界，不会发起真实调用。固定 36 次报告使用 `npm run eval:fixtures`；真实联网验收必须显式设置 `LIVE_EVAL_ENABLED=true` 并提供内部测试凭据，禁止使用访客 Key。

本地生成一条真实自定义行程的最低服务端配置为：

```dotenv
FEATURE_CUSTOM_GENERATION=true
FEATURE_WEB_SEARCH=true
FEATURE_AMAP=true
AMAP_WEB_SERVICE_KEY=<只写入未提交的 .env.local>
AMAP_HTTPS_PROXY=<可选，只写入未提交的 .env.local>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_HTTPS_PROXY=<可选，只写入未提交的 .env.local>
DEEPSEEK_KEY_VALIDATION_TIMEOUT_MS=30000
DEEPSEEK_RESPONSE_TIMEOUT_MS=300000
PLANNING_TASK_TIMEOUT_MS=900000
```

不要把访客 DeepSeek Key 写入环境文件；在 `/plan` 页面专用密码框中输入。通过验证后，Key 只写入当前标签页的 `sessionStorage`，刷新和站内跳转会保留，关闭标签页后由浏览器清除；它不会写入 SQLite、`localStorage`、URL、日志、分析或报告。共享设备使用完应点击“清除 Key”。`DEEPSEEK_HTTPS_PROXY` 与 `AMAP_HTTPS_PROXY` 都只在 Node.js 服务端读取，分别只影响 DeepSeek 和高德请求；留空即直连，不需要 Clash TUN，也不得关闭 TLS 校验。如果代理 URL 包含账号或密码，只能保存在未提交的 `.env.local`。`DEEPSEEK_RESPONSE_TIMEOUT_MS` 控制单次正式模型响应，`PLANNING_TASK_TIMEOUT_MS` 控制完整七阶段任务；非法或越界值会回退到有限默认值。若高德开关或服务端 Key 缺失，任务会在调用访客模型前明确阻塞，不会用模型猜测地点、路线、天气或实时信息。联网搜索关闭时也不会把未核验内容包装成完整真实规划。若设置 `MODEL_REGRESSION_STATE_PATH`，文件必须存在且状态为 `passed`；空值表示尚未启用这个额外闸门。

运维与验收命令：

```bash
npm run eval:fixtures
npm run eval:live
npm run performance:report
npm run model:regression -- observe <model>
npm run user-study:report
npm run release:check
```

这些命令会如实输出失败或 `no-go`。缺失输入不会被替换成虚构的成功结果。

浏览器测试默认使用 macOS 的 Google Chrome；其他环境通过 `CHROME_PATH` 指定 Chrome/Chromium 可执行文件。

可访问性与视口回归（`tests/e2e/accessibility.test.mjs`）按浏览器矩阵运行：每个引擎的当前和前一个主要版本。Chromium 系列由环境变量指定并自动运行，未安装的条目自动跳过；矩阵形状本身由不需要浏览器的测试断言。

| 条目 | 环境变量 | 方式 |
| --- | --- | --- |
| chrome-current / chrome-previous | `CHROME_PATH` / `CHROME_PREVIOUS_PATH` | 自动 |
| edge-current / edge-previous | `EDGE_PATH` / `EDGE_PREVIOUS_PATH` | 自动 |
| firefox-current / firefox-previous | `FIREFOX_PATH` / `FIREFOX_PREVIOUS_PATH` | 手动 |
| safari-current / safari-previous | 无 | 手动 |

当前测试驱动只支持 CDP，Firefox 与 Safari 保留在矩阵中作为记录在案的手动回归：按同一条键盘路径（跳转链接 → 输入 → 查看 → 锁定 → 分享 → 导出）在桌面、平板和移动视口各走一遍。设置 `E2E_SCREENSHOT_DIR` 可保留各页面×视口的截图证据，否则截图在测试结束后删除。

### 离线只读查看（可整体关闭）

- 开关在构建期生效：`FEATURE_OFFLINE_READONLY` 同时决定 `experimental.useOffline` 和应用外壳的注册，改动它需要重新构建。关闭后 `/offline` 只显示未启用说明，已注册的 worker 会被注销、`travel-agent-shell-` 前缀的缓存会被删除，断网刷新恢复成普通的网络失败。
- 缓存范围只有打开一个已保存行程所需的最小集合：`/offline` 文档，以及该文档引用的 `/_next/static/` 构建产物。`/api/` 响应、非 GET 请求、跨源请求和 `/_next/image` 一律不进缓存，也不会被离线回放成新事实。`/sw.js` 由 `next.config.ts` 固定为不缓存并限制 CSP，部署时不要再让 CDN 缓存它。
- 离线打开 `/trips/<id>` 时读取的是当前浏览器里保存的行程，只读展示，并始终写明该副本的最后更新时间，不使用“已更新/最新/实时”这类说法。本机没有对应行程时给出明确的离线错误，而不是空白页或旧内容。
- 离线停用局部重规划、链接核验、只读分享和 PDF/ICS 导出，每个停用控件都指向说明原因的文字；备注与锁定等只写本机的编辑照旧可用。外部行动入口仍然列出，但不再是可点击链接。
- 不包含离线编辑冲突合并与多端同步。对应回归是 `tests/e2e/offline.test.mjs`，需要矩阵中的 Chrome/Edge 才会实际运行。

### Ticket 011–020 模块边界

- `src/providers/deepseek/responses-client.ts`：单次 Responses 调用；凭据调用结束即清除，公开事件不含原始 reasoning。费用为可注入费率下的估算值。
- `src/agent/tools/registry.ts`：按阶段校验与执行工具；实例内去重与执行器的持久化调用日志配合，重放已确认结果不重复产生费用事件。
- `src/providers/amap/`：服务端读取 `AMAP_WEB_SERVICE_KEY`；无原始响应持久化或跨用户缓存。路线理论时长与建议缓冲分开，天气仅在三日窗口内给出预报。
- `src/search/`、`src/platform/`、`src/evidence/`：来源发现、公开网页摘录、第三方搜索条件和按地点/日期/字段归一化的证据。失败证据保持可见；平台入口均要求用户再次确认。
- `src/requirements/`、`src/agent/skeleton.ts`：完整性/支持范围检查与待取证骨架，后续由 enrichment 和确定性校验处理。

这些模块使用模拟 HTTP、固定模型响应和冻结时间验证。DeepSeek/高德真实 API、平台深链可用性和高德许可仍需在明确的联网验收阶段核实。`test:eval:fixtures` 会运行五城 12 个固定案例、3 次重复（共 36 个样本）的确定性回归评测；它只能证明本地固定数据下的行为，不能替代受控真实联网验收。

### Ticket 021–030 运行与边界

- `src/agent/enrichment.ts`、`pipeline.ts`：七阶段编排，地点、规则、天气、路线和平台入口取证；没有可靠报价的费用保留 unknown。官网时间/票价仅支持明确格式，含季节、闭馆或节假日条件的页面保持待复核，不自动套用到未来日期。
- `src/validation/trip.ts`、`src/agent/repair.ts`：校验日期、范围、活动/交通、预订时间链、预算、证据和库存措辞；修复最多两轮，不能修改事实、费用、锁定项、简报或未受影响日期。未通过硬门槛的行程输出 blocked 和下一步选择。
- `src/jobs/`：SQLite 保存阶段、编号进度和已确认调用结果；每个任务有独立匿名令牌（服务端仅存哈希）。单 Node 进程内调度去重，完整任务默认 900 秒执行时限。重启后需要模型时等待重新输入 Key；结果未确认的外部调用停止，不自动重发以免重复计费。取消会中止请求且不启动后续调用，已被上游接受的请求费用仍取决于供应商。
- `/plan` → `/planning/[id]` → `/trips/[id]`：可编辑简报、当前标签页会话 Key、SSE/轮询进度、浏览器保存及只读时间线；不是账户同步。访问任务的 HttpOnly 会话 Cookie 只对当前浏览器有效。
- API：`POST /api/planning-jobs` 接收 `{input, apiKey}`；`GET /api/planning-jobs/[id]` 返回状态；`GET .../events` 接收 `Last-Event-ID`；`POST .../resume` 临时接收 `{apiKey}`；`POST .../cancel` 取消。除创建外均要求对应 Cookie 或 `Authorization: Bearer <accessToken>`。
- 默认所有功能开关关闭。真实自定义规划需要同时启用 `FEATURE_CUSTOM_GENERATION`、`FEATURE_WEB_SEARCH`、`FEATURE_AMAP` 并填写产品方高德 Key；任一地图/搜索前置条件缺失都会在调用访客模型前明确拒绝。访客 DeepSeek Key 只在页面专用入口输入，不写入环境文件。`OFFICIAL_SOURCE_HOSTS` 是经人工核实的官方域名列表，默认仅含故宫官网示例，并非五城完整覆盖。

本批验证使用固定模型/工具响应、本地 HTTP、临时 SQLite 和隔离 Chrome；覆盖恢复与取消、两轮修复、证据缺失、SSE 重放/轮询、Key 清除竞态及移动时间线。不能据此声称真实库存、真实线路质量或外部 API 兼容性已通过验收。

### Ticket 031–040 运行与边界

- 行程页支持备注、时间、重要性和锁定状态的直接编辑；跨日移动、总预算变化等重大变更必须先预览并明确确认，局部重规划只接收受影响日期并保留未受影响日期和锁定项。版本历史保存在当前浏览器，支持一步撤销，不是多端同步。
- `/demo` 是北京四日固定条件案例，明确标注为预置、非实时且未完成人工复核；雨天、预约失败和体力下降三个场景均使用本地预校验结果，不调用模型或外部网络。
- 分享默认隐藏预算、私人备注、约束偏好和详细论证；分享记录保存令牌哈希，读/删令牌分离，30 天到期，删除立即失效。创建前必须预览并确认。
- PDF/ICS 由服务端确定性生成。PDF 需要 `PDF_FONT_PATH`，建议同时设置 `PDF_PYTHON` 指向安装了 `requirements-pdf.txt` 的 Python；ICS 使用 `Asia/Shanghai`，无时间项目会跳过并计数。两种导出均带 AI 标识、模型名和出发前复核提示，不承诺实时库存。
- 生成结果只展示模型名 `deepseek-v4-pro`；服务提供方和合规信息只在 `/about` 展示。未通过环境配置人工确认的备案/登记信息显示“待核实”。
- `npm run maintenance -- cleanup` 清理过期任务/分享及 30 天前运行指标，不需要备份密钥。`backup [目录]` 和 `restore-verify <备份文件>` 需要 32 字节 Base64 的 `BACKUP_ENCRYPTION_KEY_BASE64`；备份使用 AES-256-GCM、默认保留 7 天，恢复只写入新的验证数据库，绝不覆盖现有文件。

北京案例、路线动作和平台跳转都是固定或查询入口，不代表读取了携程、飞猪等平台的实时订单或库存。生产备份密钥托管方案、云服务商及已核验合规编号仍需在发布前确认。

## 文档

- [开发 Spec](./SPEC.md)
- [开发 Tickets](./TICKETS.md)
- [架构与数据流](./docs/ARCHITECTURE.md)
- [运行与故障手册](./docs/RUNBOOK.md)
- [真实用户任务脚本](./user-study/TASKS.md)
- [参与者告知与删除](./user-study/NOTICE.md)

## 发布边界

当前“先公开”的含义是：案例研究和固定演示可公开，自定义生成仅面向定向测试者。受限演示计划部署在香港节点；完成 ICP、生成式 AI 应用登记核对及相关许可后，再迁移大陆节点并扩大开放。

DeepSeek 备案信息、高德展示与缓存许可、具体云服务商、域名和合规主体均需在对应发布 ticket 前完成事实核实。
