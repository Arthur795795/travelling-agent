# 架构与数据流

## 系统边界

本项目是单仓库、单 Next.js 进程/容器的受限演示。Web、Route Handlers 和进程内任务执行器共享代码但保持模块边界；SQLite 仅保存临时任务、调用日志、分享、最小化分析/反馈和运行元数据，普通行程主要保存在浏览器。没有用户账户、订单绑定或多端同步。

```text
浏览器（匿名行程、临时 BYOK Key）
  │ HTTPS / SSE（轮询后备）
  ▼
Next.js 页面与 Route Handlers
  ├─ 请求/功能/费用护栏
  ├─ 七阶段 Agent 执行器 ── DeepSeek（访客 BYOK）
  │                    ├─ 高德服务端 Key
  │                    ├─ 搜索发现与安全官网读取
  │                    └─ 平台搜索/预订跳转
  ├─ 确定性 Schema、证据、时间空间、预算与锁定校验
  └─ SQLite 持久化 / PDF、ICS、只读分享
```

## 七阶段与职责

1. `requirements_check`：验证 3–5 天、单城市、1–6 人等支持范围。
2. `skeleton_planning`：模型只生成待取证骨架。
3. `evidence_collection`：查询地点、天气、搜索候选和官网摘录；搜索摘要不是核验。
4. `route_and_budget`：补充路线、缓冲、分类预算和平台行动入口。
5. `hard_validation`：确定性检查日期、可达性、锁定、证据、预算和库存措辞。
6. `repair`：最多两轮，只改受影响日期，不改事实、锁定项或硬约束。
7. `finalization`：输出 `executable`、`checked` 或 `blocked`，保留失败与冲突。

模型输出必须经过 `src/domain/schema.ts` 与 `src/validation/trip.ts`。模型不直接获得数据库或任意 HTTP 权限；工具注册表按阶段、Schema、开关、次数和幂等键约束。公开输出不包含原始 reasoning。

## Key 与信任边界

- DeepSeek Key 只进入专用表单和当次服务器请求，包装为 `TransientSecret`，调用后清除；不进入 localStorage、SQLite、日志、分析、URL、错误、分享或导出。
- 高德 Key 只从服务端 `AMAP_WEB_SERVICE_KEY` 读取，不加 `NEXT_PUBLIC_` 前缀。
- 外部官网读取先校验协议、DNS、公网地址、每次重定向、内容类型、大小和总超时，阻断 SSRF 与凭据 URL。
- 分享读令牌和删除令牌分离，服务端只存哈希；页面与响应使用 noindex/no-referrer 边界。

## 状态、恢复与保留

- 任务阶段、确认过的外部调用结果和费用写入 SQLite。进程重启会从最后安全阶段恢复；未确认的调用不自动重发，避免重复收费。
- 需要模型但 Key 已丢失时进入 `waiting_for_credentials`。用户必须重新输入，Key 不会从磁盘恢复。
- 普通浏览器行程约 30 天；临时任务 24 小时；分享与反馈 30 天；运行指标 30 天；加密备份默认轮换 7 天。
- 离线能力只缓存 `/offline` 外壳和所需 `/_next/static/` 资源，不缓存 API、外部请求或地图数据；只读副本显示最后更新时间。

## 评测与发布

- 固定评测：12 案例 × 3 次，记录 seed 与 fixture response version；关键失败不得由软分抵消。
- 联网评测：默认禁用，只能使用内部 DeepSeek 测试 Key和产品高德 Key，并受案例、步骤与费用硬上限控制。
- 模型变化：5 个冒烟案例；关键失败关闭自定义生成。只有完整 36 次通过后才能更新通过状态。
- 发布闸门：聚合静态、单元、集成、E2E、安全、固定评测、性能、联网、真实用户和外部材料。证据缺失即 no-go。

完整范围与不做项以 [SPEC.md](../SPEC.md) 为准，执行切片以 [TICKETS.md](../TICKETS.md) 为准。
