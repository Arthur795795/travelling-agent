# 运行与故障手册

## 本地启动

要求 Node.js 22.6–24。

```bash
npm ci
cp .env.example .env.local
npm run dev
```

所有功能默认关闭。固定北京案例不需要 Key。要在本机生成一条真实自定义行程，在未提交的 `.env.local` 中至少配置：

```dotenv
FEATURE_CUSTOM_GENERATION=true
FEATURE_WEB_SEARCH=true
FEATURE_AMAP=true
AMAP_WEB_SERVICE_KEY=<产品方服务端 Key>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_HTTPS_PROXY=<可选的本机 HTTP(S) 代理>
DEEPSEEK_KEY_VALIDATION_TIMEOUT_MS=30000
```

访客 DeepSeek Key 不得写入 `.env.local`，只在 `/plan` 页面输入。验证使用 `POST https://api.deepseek.com/responses`、模型 `deepseek-v4-pro` 和最小流式响应；超时可在 1–120 秒间调整，非法配置回退到 30 秒。页面会分别显示 Key 无效、余额/权限、DeepSeek 限流、本项目验证限流、参数、网络、超时和上游异常，绝不显示上游原文。

Node.js 直连受本地网络环境影响时，可在 `.env.local` 设置非 `NEXT_PUBLIC_` 的 `DEEPSEEK_HTTPS_PROXY`。服务端使用局部 `undici` `ProxyAgent`，不设置全局 dispatcher，因此只有 Key 验证与正式 Responses 调用走代理，高德和其他请求不受影响。留空时保持原有直连。代理配置只允许 `http:`/`https:` URL，代理和目标 TLS 都显式使用 Node 内置受信任根证书并保持证书校验；代理凭据不得进入日志、错误或报告。

`FEATURE_AMAP` 关闭、`AMAP_WEB_SERVICE_KEY` 缺失或 `FEATURE_WEB_SEARCH` 关闭时，创建任务会在花费访客模型额度前明确拒绝。不要用语言模型补造地点、路线、天气或实时数据。`MODEL_REGRESSION_STATE_PATH` 为空表示不启用额外模型回归文件；一旦设置，文件缺失、损坏或状态非 `passed` 都会暂停自定义生成。

## 质量与评测

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:e2e
npm run test:security
npm run test:eval:fixtures
npm run test:eval:live
npm run test:operations
npm run build
npm run eval:fixtures
npm run eval:smoke
```

`test:eval:live` 使用本地模拟，不联网。`eval:live` 默认输出 no-go；真实运行必须在获授权的受控环境注入网络执行器、内部 Key、产品高德 Key、费用上限和报告目录。固定报告必须标为固定响应，不可描述为真实用户或实时数据结果。

## Docker 与受限部署

```bash
docker build -t travel-agent:local .
docker compose -f docker-compose.example.yml up -d
curl -fsS http://127.0.0.1:3000/api/health/live
curl -fsS http://127.0.0.1:3000/api/health/ready
```

容器以非 root 用户运行，根文件系统只读，`/app/data` 是唯一 SQLite 持久卷，`/tmp` 使用 tmpfs。liveness 只证明进程可响应；readiness 还检查数据库和迁移。HTTPS 必须由可信反向代理终止，并保留 `X-Forwarded-For` 的可信代理配置；不要让 CDN 缓存 `/sw.js`、API、SSE 或分享页面。

这份配置只支持本地/香港受限部署准备，不证明已部署，也不等同于 ICP、生成式 AI 登记或高德商业许可完成。

## 备份、日志与重启

```bash
npm run maintenance -- cleanup
npm run maintenance -- backup ./backups
npm run maintenance -- restore-verify ./backups/<file>.enc
```

备份需要 `BACKUP_ENCRYPTION_KEY_BASE64`，密钥应由外部秘密管理器保管，不进入镜像或仓库。恢复验证只写新数据库，不覆盖现有数据。日志只记录闭集错误码、阶段和耗时，不记录聊天、行程正文、IP、Key 或令牌。

重启后：已确认调用从调用日志重放且不重复计费；未确认调用停止；需要 DeepSeek 的任务进入等待凭据。检查 readiness、SQLite 卷挂载、磁盘权限和 `planning_jobs` 状态后，再让测试者重新输入 Key。

## 常见故障

- `KEY_REQUIRED`：让当前测试者在专用输入框重新提供 Key；不要从日志或磁盘寻找。
- `RATE_LIMITED` / `PRODUCT_BUDGET_STOP`：保持固定案例和已有行程可读，等待窗口/月份恢复或经负责人调整预算。
- `MODEL_REGRESSION_REQUIRED`：运行 5 案例冒烟；关键失败为 0 后仍需完整 36 次通过，才能更新回归状态。
- DeepSeek 429/超时/截断：公开显示失败或等待，不把部分文本当成功；从最后安全阶段恢复，不重发未确认调用。
- 高德额度/无路线：保留未知或阻塞状态，不猜坐标、路线或价格。
- 官网 404/结构变化/冲突：保留 failed/recheck/conflict 和查询时间，不继承旧核验。
- SQLite 写失败：停止写入并保持事务回滚；修复卷权限/空间后，从最后完整状态恢复。
- PDF 失败：返回稳定错误，不泄露 Python 或字体路径；ICS 与页面读取不受影响。

## 用户测试与发布

真实用户测试按 [TASKS.md](../user-study/TASKS.md) 和 [NOTICE.md](../user-study/NOTICE.md) 执行。将 5 名匿名结果写入仓库外文件后：

```bash
USER_STUDY_INPUT_PATH=/secure/path/results.json npm run user-study:report
PERFORMANCE_INPUT_PATH=/secure/path/performance.json npm run performance:report
npm run release:check
```

没有真实参与者、受控联网、性能、部署与合规证据时，发布闸门应输出 no-go。这是正确结果，不得手工改报告绕过。
