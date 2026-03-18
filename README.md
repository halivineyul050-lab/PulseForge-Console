# PulseForge Console (V2)

一个完整可运行的**电脑实时性能可视化监控台**：

- 后端采集真实系统指标（`systeminformation`）
- 前端实时图表渲染（`ECharts`）
- WebSocket 推送低延迟数据流
- 告警事件时间线
- CSV 导出（服务端实时历史 + 前端离线历史）
- 断线自动降级到模拟数据，恢复后自动重连
- SQLite 历史持久化 + 趋势回放
- 告警通知通道（Webhook/企业微信/钉钉）
- 多主机监控（Agent 上报 + 主控台主机切换）
- 事件级 AI 根因分析（可选接入 LLM，无 Key 时本地回退）
- 告警消息可附带 AI 诊断摘要，分析完成后自动补发“AI分析更新”通知

---

## 1. 功能总览

### 实时数据

- CPU：总占用、频率、每核心负载热力图
- 内存：RAM 占比、Swap 占比
- GPU：负载、显存占比（硬件支持时）
- 磁盘：读写吞吐、延迟（支持原生值时优先，缺失则估算）
- 磁盘分盘符：`C:/D:/...` 每盘读写速率与独立趋势曲线（Windows 下支持原生计数器回退）
- 网络：上/下行速率、连接数、丢包估计
- 网络分网卡：可切换指定网卡（以太网/Wi-Fi 等）查看独立上/下行曲线
- 温度：CPU/GPU 温度可用时优先，否则基于负载估算

### 可视化

- 顶栏控制：采样率、时间范围、主题切换、冻结画面、重连、导出
- KPI 卡片 + 5 大趋势图 + 进程 Top5 + 告警时间线 + 系统快照
- 响应式布局（桌面/平板/移动）

### 稳定性

- WebSocket 实时推送
- 自动重连（指数退避）
- 服务不可达时自动进入模拟模式（不中断展示）
- 心跳探测与数据新鲜度监控（超时自动重连）
- 健康诊断接口与采样性能统计

### 平台扩展

- 历史数据默认落盘到 SQLite（可关闭）
- `/api/history` 支持 `source=auto/sqlite/memory` 来源选择
- `/api/history/replay` 支持按步长抽样回放
- 告警支持 Webhook / 企业微信 / 钉钉机器人推送
- 支持多主机汇聚：每台 Agent 上报，前端下拉切换主机视图

---

## 2. 项目结构

- `server.js`：采集器 + API + WebSocket 服务
- `agent.js`：远端采集 Agent（上报主控台）
- `app.js`：前端数据层、图表渲染、告警与连接管理
- `sqlite-store.js`：SQLite 持久化存储层
- `notifier.js`：告警通知通道适配层
- `index.html`：页面结构
- `styles.css`：视觉主题与响应式布局
- `package.json`：依赖与脚本
- `smoke-test.js`：自动化冒烟验收脚本

---

## 3. 快速启动

## 前置环境

- Node.js 18+（推荐 LTS）
- 若需启用 SQLite 持久化，建议 Node.js 22+

## 安装依赖

```bash
npm install
```

## 启动服务

```bash
npm start
```

## 启动 Agent（多主机）

在远端主机执行：

```bash
set PF_MASTER_URL=http://<主控台IP>:4510 && set PF_AGENT_HOST_ID=agent:host-a && npm run agent
```

如主控台启用了鉴权，再追加：

```bash
set PF_AGENT_API_KEY=<your-key>
```

## 快速检查

```bash
npm run check
```

## 自动化验收（推荐每次改动后执行）

```bash
npm run smoke
```

默认监听：

- `http://localhost:4510`

打开浏览器访问上面的地址即可。

---

## 4. 配置项

通过环境变量可调整：

- `PORT`：服务端口（默认 `4510`）
- `SAMPLE_RATE_MS`：采样率（默认 `1000`，支持 `500/1000/2000`）
- `HISTORY_POINT_LIMIT`：服务端内存历史点数上限（默认 `20000`）
- `EVENT_POINT_LIMIT`：服务端事件数上限（默认 `600`）
- `WINDOWS_DISK_REFRESH_INTERVAL_MS`：Windows 磁盘计数器刷新间隔（默认 `2000`）
- `SQLITE_ENABLED`：是否启用 SQLite（默认 `1`，设为 `0` 可关闭）
- `SQLITE_STRICT_STARTUP`：SQLite 初始化失败时是否阻止服务启动（默认 `1`）
- `SQLITE_DB_PATH`：SQLite 文件路径（默认 `./data/pulseforge.db`）
- `SQLITE_RETENTION_DAYS`：历史保留天数（默认 `7`）
- `SQLITE_BUSY_TIMEOUT_MS`：SQLite 锁等待超时（默认 `4000`）
- `STORAGE_WRITE_RETRY_MAX_ATTEMPTS`：持久化写入重试次数（默认 `4`）
- `STORAGE_WRITE_RETRY_BASE_DELAY_MS`：写入重试基础延迟（默认 `80`）
- `STORAGE_WRITE_RETRY_MAX_DELAY_MS`：写入重试最大延迟（默认 `1200`）
- `HISTORY_QUERY_LIMIT_MAX`：历史查询最大返回点数（默认 `500000`）
- `AGENT_API_KEY`：Agent 上报鉴权密钥（默认空，空表示不鉴权）
- `AGENT_BODY_LIMIT`：Agent 接口请求体上限（默认 `2mb`）
- `AGENT_BATCH_LIMIT`：Agent 批量上报最大样本数（默认 `120`）
- `HOST_ONLINE_TIMEOUT_MS`：主机在线判定超时（默认 `15000`）
- `ALERT_WEBHOOK_URL`：通用 webhook 地址
- `WECHAT_WEBHOOK_URL`：企业微信机器人 webhook
- `DINGTALK_WEBHOOK_URL`：钉钉机器人 webhook
- `DINGTALK_SECRET`：钉钉加签 secret（可选）
- `NOTIFIER_TIMEOUT_MS`：通知通道请求超时（默认 `5000`）
- `NOTIFIER_RETRY_MAX_ATTEMPTS`：通知发送最大重试次数（默认 `3`）
- `NOTIFIER_RETRY_BASE_DELAY_MS`：通知重试基础延迟（默认 `250`）
- `NOTIFIER_RETRY_MAX_DELAY_MS`：通知重试最大延迟（默认 `2000`）
- `AI_ANALYZER_ENABLED`：是否启用 AI 分析（默认 `1`）
- `AI_ANALYZER_API_KEY`：AI Provider API Key（可用 `OPENAI_API_KEY` 兼容）
- `AI_ANALYZER_BASE_URL`：AI API 地址（默认 `https://api.openai.com/v1`）
- `AI_ANALYZER_MODEL`：模型名（默认 `gpt-4o-mini`）
- `AI_ANALYZER_TIMEOUT_MS`：AI 请求超时（默认 `8000`）
- `AI_ANALYZER_MAX_INPUT_CHARS`：AI 输入裁剪上限（默认 `12000`）
- `AI_ANALYZER_MAX_CONCURRENCY`：AI 分析并发上限（默认 `2`）
- `AI_ANALYZER_QUEUE_LIMIT`：AI 分析队列上限（默认 `1200`）

Agent 端常用环境变量：

- `PF_MASTER_URL`：主控台地址（默认 `http://127.0.0.1:4510`）
- `PF_AGENT_HOST_ID`：Agent 主机 ID（默认 `agent:<hostname>`）
- `PF_AGENT_HOST_NAME`：Agent 主机名称（默认系统主机名）
- `PF_AGENT_API_KEY`：Agent 鉴权密钥
- `PF_AGENT_SAMPLE_RATE_MS`：Agent 采样周期（默认 `1000`）

示例：

```bash
set PORT=4600 && set SAMPLE_RATE_MS=500 && npm start
```

---

## 5. API 与 WebSocket

## HTTP API

- `GET /api/health`：健康状态
- `GET /api/health` 额外返回 `reliability`（存储重试、队列拒绝、通知统计）
- `GET /api/storage/status`：持久化状态（是否降级/错误原因）
- `GET /api/hosts`：主机列表（本机 + Agent）
- `GET /api/meta?hostId=...`：指定主机元信息 + 采样配置
- `GET /api/config`：当前采样配置
- `POST /api/config?hostId=<localHostId>`：修改本机采样率（`{ sampleRateMs }`）
- `GET /api/latest?hostId=...`：指定主机最新采样
- `GET /api/history?hostId=...&minutes=5&limit=600&source=auto`：指定主机历史
- `GET /api/history/replay?hostId=...&minutes=60&replayStepMs=2000`：趋势回放抽样
- `GET /api/events?hostId=...&limit=120&source=auto`：指定主机事件
- `GET /api/events/analysis?hostId=...&eventId=...`：获取/触发单事件 AI 根因分析
- `POST /api/events/analysis`：触发单事件 AI 根因分析（Body: `hostId,eventId,force`）
- 当 AI 队列拥塞时，`/api/events/analysis` 返回 `503` 与 `code=analysis_queue_full`
- 队列拥塞响应附带 `Retry-After: 2`，建议客户端按该值退避重试
- `GET /api/export.csv?hostId=...&minutes=5`：导出指定主机 CSV
- `POST /api/agent/ingest`：Agent 上报接口（支持单样本/批量）
- `GET /api/notifier`：通知通道状态
- `GET /api/notifier` 返回重试参数（`retry.maxAttempts/baseDelayMs/maxDelayMs`）
- `GET /api/notifier` 同时返回通知发送统计（`stats.totalRequests/totalRetries/...`）
- `POST /api/notifier/test`：发送通知测试消息
- `GET /api/diagnostics`：采样器性能与缓存诊断

## WebSocket

- 地址：`ws://localhost:4510/ws`
- 服务端消息：
  - `hello`
  - `hosts`
  - `sample`
  - `events`
  - `config`
  - `pong`
- 客户端消息：
  - `setHost`
  - `getHosts`
  - `setSampleRate`
  - `ping`

## Agent 上报格式

请求：`POST /api/agent/ingest`

- 头部可选：`X-Agent-Key: <AGENT_API_KEY>`
- Body 可为单样本：

```json
{
  "host": {
    "id": "agent:node-a",
    "name": "Node-A",
    "source": "agent",
    "meta": {
      "hostId": "agent:node-a",
      "hostName": "Node-A"
    }
  },
  "sample": {
    "ts": 1711111111111,
    "cpu": 42.1,
    "mem": 63.4,
    "temp": 58.0,
    "diskLatency": 4.2,
    "packetLoss": 0.1
  }
}
```

- 也支持批量：`{ "host": {...}, "samples": [ ... ] }`

---

## 6. 关键数据字段（sample）

```json
{
  "ts": 1711111111111,
  "cpu": 63.2,
  "cpuFreq": 4.1,
  "cpuCores": [52.1, 37.4, 70.6],
  "mem": 71.4,
  "memUsedGb": 22.8,
  "memTotalGb": 32,
  "swap": 5.6,
  "swapUsedGb": 0.4,
  "swapTotalGb": 8,
  "gpu": 82.5,
  "gpuName": "NVIDIA GeForce ...",
  "vram": 66.2,
  "vramUsedGb": 5.3,
  "vramTotalGb": 8,
  "diskRead": 120.4,
  "diskWrite": 47.8,
  "diskLatency": 12.3,
  "diskTelemetryAvailable": true,
  "diskTelemetrySource": "systeminformation",
  "diskVolumes": [
    { "name": "C:", "read": 6.1, "write": 2.4, "total": 8.5, "latencyMs": 0.7, "source": "windows-counter" },
    { "name": "D:", "read": 0.0, "write": 1.3, "total": 1.3, "latencyMs": 0.2, "source": "windows-counter" }
  ],
  "diskLatencyEstimated": false,
  "netUp": 8.6,
  "netDown": 24.5,
  "networkRateAvailable": true,
  "networkInterfaces": [
    { "name": "以太网", "up": 1.2, "down": 6.7, "total": 7.9, "rateAvailable": true, "source": "direct-or-delta" }
  ],
  "packetLoss": 0.3,
  "netConnections": 365,
  "temp": 73.0,
  "tempEstimated": false,
  "processTop": [{ "name": "chrome.exe", "cpu": 5.2, "memoryMb": 1430 }],
  "activeAlerts": [],
  "events": []
}
```

---

## 7. 告警规则

- `CPU >= 90%`
- `内存 >= 88%`
- `温度 >= 82°C`
- `磁盘延迟 >= 22ms`
- `丢包 >= 1.2%`

告警触发和恢复都会写入事件流。

---

## 8. 常见问题

## 页面显示“模拟模式”

- 原因：前端连不上采集服务
- 处理：确认 `npm start` 正在运行；检查端口是否被占用；点击“重连数据源”

## GPU/温度显示不完整

- 原因：某些设备或驱动不提供对应传感器数据
- 处理：这是正常兼容行为，界面会降级显示可用字段

## CSV 导出为空

- 原因：历史窗口内暂无点位
- 处理：等待采样积累后再导出，或增大时间范围

## 磁盘/网络/温度显示为 0 或不可用

- 原因：部分 Windows 设备上 `systeminformation` 无法提供 `fsStats/disksIO/温度传感器` 原始值，或当前流量极低接近 0
- 处理：当前版本已区分“不可用”与“真实 0”，并在温度不可用时自动回退估算值；Windows 下磁盘速率会自动回退到系统性能计数器采集

---

## 9. 后续可扩展方向

- 告警抑制/分组（去抖、去重、冷却时间）
- 自定义规则引擎（阈值、表达式、主机标签）
- 指标长期归档到时序数据库（InfluxDB/TimescaleDB）
- 进程维度深钻（CPU Flame、IO 热点、网络会话）
- 桌面客户端封装（Tauri/Electron）

---

## 10. 当前优化重点（持续迭代中）

- 前端渲染采用 `requestAnimationFrame` 合帧，减少高频重绘抖动
- 历史数据窗口切换支持在线回拉，避免大窗口只显示短历史
- 历史/事件缓冲采用“触发阈值后批量裁剪”，降低频繁 `splice` 开销
- `/api/history` 改为时间戳二分定位窗口，降低查询成本
- 新增采样统计（平均耗时、峰值耗时、跳帧次数、错误次数）

# PulseForge-Console
