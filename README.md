# LOOK 磁盘寻道与到达事件回放后端

单磁头 **LOOK 磁盘寻道仿真服务**（仅后端：HTTP API + CLI）。TypeScript + Node.js + SQLite（`node:sqlite` 内置模块，无需本机编译、无需 Docker/WSL、无需任何在线服务），Windows 本地直接运行。

本项目只研究**在线到达下的寻道顺序与等待**，不实现磁盘读写、文件系统、旋转延迟或吞吐带宽模型。

## 仿真模型

- 柱面为从 `0` 开始的连续整数（`0..maxCylinder`），磁头有整数初始位置与初始方向：`1` 向上（柱面号增大）、`-1` 向下。
- 读请求具有唯一编号 `id`、到达时刻 `arrival`（非负整数）与目标柱面 `cylinder`。
- 磁头每个整数时间单位**最多移动一个柱面**；服务当前柱面的请求不额外耗时。

### 每个仿真周期（时刻 t）的严格顺序

1. **到达纳入**：先纳入所有 `arrival == t` 的请求；
2. **同柱面服务**：一次服务当前柱面的全部待处理请求，按 `(到达时刻, 编号)` 稳定排序；同刻到达同柱面为零等待，服务多个同柱面请求不增加移动；
3. **LOOK 方向选择**（只看当前队列，不提前看未来请求）：
   - 当前方向上存在待处理柱面 → 朝该方向移动一格；
   - 当前方向没有、反方向有 → **立即反向**（计一次反向）再移动一格；
   - 两侧都没有 → 保持位置与方向等待；
4. 移动后到 `t+1` 才处理新到达与新位置服务；**不必走到物理边缘才反向**。

### 空闲跳转

队列已空但存在未来到达时，直接跳到下一到达时刻（不逐格空跑），并以 `WAIT_SKIP` 事件明确记录等待区间 `[t, nextArrival)`；**跳过的时间不计入寻道距离**。存在待处理请求时绝不允许越过中途到达事件。

### 完成与暂停

- 未来没有到达且队列为空 → 标记 `complete`；
- 步数预算耗尽或触及最大时间/边界 → 标记 `paused` 并保留全部待处理项，**绝不假称全部服务完毕**；携带更大预算再次推进即可恢复；
- 当前位置、方向、时刻、队列都是持久状态，**重启后继续不重置方向**。

### 公开上限（防止巨大空跑）

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `MAX_TIME` | `1,000,000,000` | 最大仿真时刻 |
| `MAX_STEP_BUDGET` | `1,000,000` | 单次推进预算上限 |
| `DEFAULT_STEP_BUDGET` | `10,000` | 推进时的默认预算 |
| 最大柱面数 | `10,000` | 模型边界上限 |
| 最大请求数 | `100,000` | 单版本请求上限 |

可通过 `GET /api/limits` 查询。

## 环境要求

- Windows（已在 Node.js **v25.5.0** 实测）；最低 Node `22.5.0`（使用内置 `node:sqlite`）。
- 全程仅模拟时间，**不使用真实 sleep**，不启动任何操作系统设备工具。

## 快速开始（PowerShell）

```powershell
npm install
npm run build      # 编译 TypeScript 到 dist/
npm test           # 编译并运行全部测试（node --test）
npm run demo       # 内置演示场景，打印逐条中文事件表
npm start          # 启动 HTTP API（默认自动选择空闲端口）
```

指定端口与数据目录：

```powershell
node dist/src/cli.js serve --port 8080 --data data
# 或 $env:LOOK_DATA_DIR="data"
```

端口被占用时自动回退到系统分配的空闲端口，启动行会打印实际地址。

## CLI 用法

```powershell
node dist/src/cli.js create-model --name 验收模型 --data data
node dist/src/cli.js create-version --model 1 --max-cylinder 10 --head 5 --direction 1 `
  --requests requests.sample.json --data data
node dist/src/cli.js start   --version 1 --data data     # 开始运行（已开始则返回当前运行）
node dist/src/cli.js step    --version 1 --data data     # 单步推进一个仿真周期
node dist/src/cli.js advance --version 1 --budget 100 --data data  # 推进多步
node dist/src/cli.js run    --version 1 --budget 10000 --data data # start + 推进到完成/暂停
node dist/src/cli.js time   --version 1 --data data      # 查询当前时刻/位置/方向
node dist/src/cli.js stats  --version 1 --data data      # 统计
node dist/src/cli.js history --version 1 --data data     # 事件历史（JSON）
node dist/src/cli.js report --version 1 --data data      # 完整报告
node dist/src/cli.js export --version 1 --data data      # JSON 导出到 data/exports/
```

## HTTP API

所有请求/响应均为 JSON。错误响应形如 `{"error":{"code":"VALIDATION","message":"...","details":...}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/api/limits` | 公开上限 |
| POST | `/api/models` | 创建模型：`name,maxCylinder,initialHead,initialDirection` |
| GET | `/api/models` / `/api/models/:id` | 列出模型 / 模型详情（含版本与运行） |
| POST | `/api/models/:id/versions` | 为模型创建请求版本并导入请求 |
| POST | `/api/versions/:id/start` | 开始运行（幂等；重启继续不重置方向） |
| POST | `/api/versions/:id/step` | 单步推进一个周期 |
| POST | `/api/versions/:id/advance` | 按 `budget` 推进（默认 10000） |
| GET | `/api/versions/:id` | 版本与请求表 |
| GET | `/api/versions/:id/run` | 运行状态 |
| GET | `/api/versions/:id/time` | 当前时刻、柱面、方向 |
| GET | `/api/versions/:id/statistics` | 服务数、等待、总距离、反向、最终位置等 |
| GET | `/api/versions/:id/history` | 全部仿真事件 |
| GET | `/api/versions/:id/report` | 完整报告（版本+运行+统计+顺序+事件） |
| GET | `/api/versions/:id/export` | 生成 JSON 导出文件并返回报告 |

创建版本请求体示例：

```json
{
  "maxCylinder": 10,
  "initialHead": 5,
  "initialDirection": 1,
  "requests": [
    { "id": "R2", "arrival": 0, "cylinder": 2 },
    { "id": "R7", "arrival": 0, "cylinder": 7 },
    { "id": "R6", "arrival": 1, "cylinder": 6 }
  ]
}
```

### 错误码

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 400 | `VALIDATION` / `BAD_REQUEST` | 非法方向、非整数位置、越界柱面、负时间、重复编号、非法 JSON 等 |
| 404 | `NOT_FOUND` | 模型/版本/运行不存在 |
| 409 | `CONFLICT` | 已完成仍推进、**已开始版本的到达表不可修改** |
| 409 | `BUDGET_EXHAUSTED` | 暂停状态下未提供更大预算 |
| 422 | `LIMIT_EXCEEDED` | 柱面/请求数/时刻/预算超限、请求体过大 |

## 不可变性与版本

到达表一旦随运行开始即**不可原地修改**（`versions.started=1`，再导入返回 `CONFLICT`）。需要换请求集时对同一模型创建**新版本**（版本号自增），旧版本及其运行、事件、报告全部保留，可随时导出对比。

## 数据与原子性

- SQLite 数据库位于项目内 `data/look.db`（可用 `--data` 或 `LOOK_DATA_DIR` 配置），导出文件位于 `data/exports/`。
- 每次推进在**单个 SQLite 事务**内原子写入运行状态与事件（WAL 模式），进程任何时刻崩溃都不会出现“事件已写、状态未更新”的撕裂。
- 事件类型：`ARRIVALS / SERVICE / WAIT_SKIP / REVERSE / MOVE / COMPLETE / PAUSED`，每条含时刻、队列、是否反向、下一位置与中文解释，任一请求为何先处理均可追查。

## 手工事件表核对（验收场景）

磁头 5 号柱面、方向向上，零时刻请求柱面 2、7：先到 7，再反向到 2，**总距离 7、反向 1 次**。

追加移动期间到达（t1 到柱面 6 的 R6、t3 到柱面 3 的 R3），顺序受当时队列影响：

| 完成顺序 | 请求 | 完成时刻 | 等待 |
| --- | --- | --- | --- |
| 1 | R6 | 1 | 0 |
| 2 | R7 | 2 | 2 |
| 3 | R3 | 6 | 3 |
| 4 | R2 | 7 | 7 |

关键点：R3 在 t3 磁头从 7 回到 6 的移动**之后**才被纳入，故在 t6 才完成。`npm run demo` 会打印完整中文事件表，并额外验证：

- 同柱面多个请求零移动零等待、稳定排序；
- 初始方向无请求时立即反向；
- 请求恰好到达当前磁头即时服务；
- 长时间空闲跳转且不计距离；
- 边缘反向；
- 分段（逐周期）推进与一次性运行结果完全一致；
- 关闭并重新打开数据库（模拟重启）后状态、方向、事件、统计完全一致；
- 旧版本报告在创建新版本后仍保留。

## 测试覆盖

- `tests/engine.test.ts`：LOOK 语义、等待与完成时刻、单步=批量、预算暂停/恢复、距离守恒（总距离等于 MOVE 位置变化绝对值之和）、请求不丢失不重复；
- `tests/store.test.ts`：SQLite 持久化与重启一致性、已开始表不可改与旧版本保留、JSON 导出、全部参数校验错误码。

## 范围与假设

- 面向**少量柱面与有限请求**的教学/回放场景，不做高性能调度；
- 柱面、时刻、位置均限定为安全整数；方向仅二值；
- 服务不耗时，同柱面一批请求在同一时刻全部完成；
- 无旋转延迟、传输时间、优先级、抢占与真实时间（不使用 sleep）。
