# LOOK 磁头寻道与到达事件回放后端

使用 TypeScript + Node.js + SQLite（`node:sqlite`，零原生依赖）实现的单磁头 LOOK 磁盘寻道仿真服务。仅提供 HTTP API 与 CLI，不依赖 Docker / WSL / 外部服务，Windows 本地直接运行。

## 模型与语义

- 柱面为从 0 开始的连续整数（`0 .. cylinders-1`），磁头有初始位置与初始方向（`up`/`down`）。
- 请求含唯一编号 `requestId`、到达时刻 `arrival`、目标柱面 `cylinder`。
- 每个整数时间单位磁头最多移动一个柱面；服务当前柱面的请求不额外耗时。
- 每个时刻 `t`：
  1. 纳入所有 `arrival == t` 的请求；
  2. 服务当前柱面全部已到达请求（按 `arrival, requestId` 稳定排序）；
  3. 队列非空：当前方向有待处理柱面则移动一格；当前方向没有而另一方向有则**立即反向**并移动一格（不必走到物理边缘）；
  4. 两侧都没有：保持位置与方向等待。空闲时直接跳到下一到达时刻，并记录 `idle` 事件（跳过的时间不计入寻道距离）；存在待处理请求时不会越过中途到达事件。
- 移动后到 `t+1` 才处理新到达与新位置的服务；不使用未来请求决定当前方向。
- 等待时间 = 完成时刻 − 到达时刻；同刻到达同柱面可零等待。
- 方向与位置是持久状态，重启后继续推进不会重置。
- 未来无到达且队列为空 → `completed`；步数预算耗尽或超过 `maxTime` → `paused`，待处理项保留，可继续推进。

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm run demo      # 运行内置演示场景
npm start         # 启动 HTTP 服务（默认端口 0 = 自动选空闲端口）
```

## CLI

```powershell
node dist/src/cli.js create-model --cylinders 10 --position 5 --direction up
node dist/src/cli.js add-request --model 1 --id 1 --arrival 0 --cylinder 2
node dist/src/cli.js add-request --model 1 --file requests.json   # 批量导入
node dist/src/cli.js run --model 1 --steps 1000                   # 开始并推进
node dist/src/cli.js step --run 1 --count 5                       # 继续推进
node dist/src/cli.js status --run 1                               # 当前时刻/位置/方向
node dist/src/cli.js stats --run 1                                # 统计
node dist/src/cli.js events --run 1                               # 事件历史
node dist/src/cli.js requests --run 1                             # 已服务/待处理
node dist/src/cli.js export --run 1 --out report.json             # JSON 导出
node dist/src/cli.js version --model 1                            # 复制为新版本
node dist/src/cli.js serve --port 8080                            # 指定端口；省略则自动选空闲端口
```

所有命令支持 `--db 路径`（默认 `data/look.db`，也可用环境变量 `LOOK_DB`）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/models` | 创建模型 `{cylinders, initialPosition, initialDirection}` |
| GET | `/models` / `/models/:id` | 列表 / 详情（含请求表） |
| POST | `/models/:id/requests` | 导入请求 `{requests:[{requestId,arrival,cylinder}]}` |
| POST | `/models/:id/version` | 复制为新版本（旧版本报告保留） |
| POST | `/models/:id/runs` | 开始运行 `{maxTime?}` |
| GET | `/models/:id/runs` | 该模型的全部运行 |
| POST | `/runs/:id/step` | 推进 `{count?}` 步（默认 1） |
| GET | `/runs/:id` | 当前状态（时刻/位置/方向/距离/反向数） |
| GET | `/runs/:id/stats` | 统计：服务顺序、等待、总距离、反向次数、最终位置 |
| GET | `/runs/:id/events` | 事件历史（每刻队列、是否反向、下一位置、空闲区间） |
| GET | `/runs/:id/requests` | 已服务（含完成时刻与等待）与待处理请求 |
| GET | `/runs/:id/export` | 完整 JSON 导出 |
| GET | `/limits` | 公开的上限参数 |

错误统一返回 `{"error":{"code","message"}}`，错误码包括：
`INVALID_PARAM`、`INVALID_CYLINDERS`、`INVALID_POSITION`、`INVALID_DIRECTION`、`INVALID_ARRIVAL`、`INVALID_CYLINDER`、`INVALID_REQUEST_ID`、`DUPLICATE_REQUEST_ID`、`LIMIT_EXCEEDED`、`MODEL_LOCKED`、`MODEL_NOT_FOUND`、`RUN_NOT_FOUND`、`NOT_FOUND`、`INVALID_JSON`。

## 持久化与一致性

- 所有事件、运行状态、请求服务记录在单个 SQLite 事务中原子写入；进程崩溃后重开数据库可继续推进。
- 模型一旦开始运行即锁定，到达表不可原地修改；换请求集用 `POST /models/:id/version` 创建新版本，旧版本与其运行报告完整保留。
- 只使用模拟时间推进，不使用真实 `sleep`，不启动任何操作系统设备工具。

## 演示场景

`npm run demo` 运行两个场景（初始位置 5、方向 up、柱面 0..9）：

1. `t=0` 请求在 2、7 号柱面 → 先到 7，立即反向到 2，总距离 7，反向 1 次；
2. 另加 `t=1` 到达的 6 号（近端，磁头经过时顺带服务）与 `t=3` 到达的 0 号（反方向）请求，展示服务顺序受当时队列影响。

## 测试

`npm test` 覆盖：同柱面多请求、初始方向无请求立即反向、恰好到达当前磁头、长时间空闲跳转、边缘反向、移动途中到达不越过、单步与批量推进一致、保存重启后继续与不间断运行一致、预算耗尽暂停、模型锁定与版本复制、参数校验、空请求集、超过 `maxTime` 暂停。并核对移动距离等于位置变化绝对值之和、请求无丢失无重复。

## 限制与假设

- 范围限定少量柱面与有限请求：`cylinders ≤ 100000`，单模型请求 ≤ 100000，`arrival/time ≤ 10^7`，单次推进 ≤ 10^6 步（见 `GET /limits`，常量位于 `src/types.ts`）。
- 仅研究寻道顺序与等待：不建模磁盘读写、文件系统、旋转延迟与吞吐带宽。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能；要求 Node ≥ 22.5（建议 ≥ 23.4 免实验标志）。
- 步数预算每次调用独立计算；`paused` 状态可通过继续调用 `step` 恢复推进。
