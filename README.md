# 教研成果署名协商服务

区域教研共同体在联合开发课程资源时，用本服务把**贡献申报、共同确认、异议冻结、发布授权**串成一条连续、可还原的证据链，避免“版本发布后才发现贡献教师遗漏、署名顺序未经确认”的争议。

运行环境：Node.js 20+，无第三方运行时依赖。

## 它保证什么

- **连续证据**：申报、确认、异议、回应、撤回、授权、发布全部是只追加（append-only）事件，按序号落盘为 JSONL。状态只能由事件重放得到，任何人无法悄悄改写历史。
- **版本图与分叉独立**：资源版本一经发布不可改写；后续修改从已发布版本建立父子关系。内容分叉后各分支**分别协商**，一个版本被冻结不影响其他分支。
- **继承已确认贡献**：新版本可继承父版本中“教师本人已同意且未撤回”的贡献及其立场，继承件标注来源；未确认或持异议的贡献不继承。
- **有依据异议即冻结**：任何参与者提出附带依据的异议，对应版本立即冻结；异议解决或撤回、且无其他未决异议后，主持人方可解冻。
- **撤回不消灭事实**：撤回贡献或异议只追加撤回事件并置标记，“曾参与旧版本”的记录永远保留；已发布摘要不可改写。
- **重复确认不增加权重**：同一教师对同一版本重复相同表态仅留痕，立场与权重均不变。
- **发布门槛**：只有达到该版本约定的确认人数、无未表态者、无未决异议、无持反对立场者时，主持人才能授权；授权后若出现新异议则不能签发发布摘要。
- **署名顺序可还原**：支持主持人显式裁定署名位置（每次裁定留痕），未裁定者按累计权重建议排序；接口可还原“某个署名顺序是怎样形成的”，并列出未确认者与争议焦点。
- **保密说明受控**：资源的保密说明仅主持人与本校统筹人可见，教师与外校人员的响应中该字段直接缺省。
- **重启不变**：服务重启后重放事件日志，版本图、冻结状态、发布摘要全部恢复（测试覆盖真实落盘与重开进程）。

## 领域约定

见 `src/domain.js`：

- 贡献类型 `contributionKinds`：`authoring`（撰写）、`review`（审读）、`classroom-validation`（课堂验证）、`coordination`（统筹）。
- 权重建议区间 `weightSuggestionGuide`：仅为建议，申报时允许 `(0,1]` 任意值。
- 版本状态 `versionStates`：`working → frozen → authorized → published`（冻结可在异议了结后回到 working）。
- 异议阶段 `disputeStates`：`raised → responded → resolved / withdrawn`。
- 立场 `confirmationStates`：`pending / agreed / objected`。
- 角色 `userRoles`：`facilitator`（教研主持人）、`coordination`（学校统筹人）、`teacher`（教师）。

## 运行

```bash
npm start                 # 默认 ./data、端口 3000
node index.js --port=3111 --data=./data
# 也可用环境变量 PORT、DATA_DIR
```

数据目录：

- `events.jsonl`：只追加的协商证据事件，版本图与冻结状态的唯一事实来源。
- `tokens.json`：持有者令牌映射，**须置于具备访问控制的运行环境**。

## 认证

- 生产模式（`NODE_ENV=production`）只接受 `Authorization: Bearer <token>`。
- 非生产环境额外接受 `X-Dev-User: <教师编号>` 测试头，便于本地联调与自动化测试。
- 令牌由主持人通过 `POST /admin/tokens` 签发。

## 首次引导

系统尚无任何登记用户时，无需凭证调用一次引导，建立第一所学校与首位主持人：

```bash
curl -X POST localhost:3000/admin/bootstrap -H 'content-type: application/json' -d '{
  "schoolId":"S1","schoolName":"第一中学",
  "userId":"F-1","displayName":"主持人方老师"
}'
```

## HTTP 接口（主要）

| 方法 & 路径 | 说明 | 最低权限 |
| --- | --- | --- |
| `POST /admin/schools` `/admin/users` | 登记学校、教师 | 主持人 |
| `POST /admin/tokens` | 为已登记用户签发令牌 | 主持人 |
| `POST /resources` | 建资源（同时生成初稿 V1，可带 `confidentialNote`、`requiredConfirmations`） | 主持人/本校统筹 |
| `GET  /resources/:rid` | 资源详情（保密说明按权限缺省） | 任意登记用户 |
| `GET  /resources/:rid/graph` | 版本图：各版本状态、未确认者、争议数、发布就绪情况 | 任意登记用户 |
| `POST /resources/:rid/versions` | 从父版本分叉（`parentVersionId`、`requiredConfirmations`、`inherit` 默认 true） | 主持人/本校统筹 |
| `GET  /versions/:vid` | 版本详情：贡献（含已撤回）、确认、异议、就绪度 | 任意登记用户 |
| `GET  /versions/:vid/readiness` | 发布门槛检查 | 任意登记用户 |
| `GET  /versions/:vid/authorship` | 署名顺序形成轨迹 | 任意登记用户 |
| `GET  /versions/:vid/evidence` | 与该版本相关的完整证据时间线 | 任意登记用户 |
| `POST /versions/:vid/contributions` | 申报贡献（教师只能申报本人） | 参与者 |
| `POST /contributions/:cid/withdraw` | 撤回贡献（仅置标记，事实保留） | 本人/主持人 |
| `POST /versions/:vid/confirmations` | 表达立场 `agreed`/`objected`（重复相同表态不增权） | 参与者 |
| `POST /versions/:vid/disputes` | 提有依据异议（`focus`+`basis`，立即冻结该版本） | 参与者 |
| `POST /disputes/:did/respond` | 回应异议 | 主持人/统筹 |
| `POST /disputes/:did/resolve` | 处理结论 | 主持人 |
| `POST /disputes/:did/withdraw` | 撤回异议 | 提出人/主持人 |
| `POST /versions/:vid/unfreeze` | 无未决异议时解除冻结 | 主持人 |
| `POST /versions/:vid/ordering` | 裁定署名位置 `entries:[{teacherRef,order,reason}]` | 主持人 |
| `POST /versions/:vid/authorize` | 达到确认范围且无未决异议时授权 | 主持人 |
| `POST /versions/:vid/publish` | 签发不可改写的发布摘要 | 主持人 |

错误统一为 `{ "error": "..." }`，状态码：400 校验失败、401 未认证、403 权限不足、404 不存在、409 状态冲突（冻结/已发布/未达门槛等）。

## 典型流程

```
建资源(V1) → 教师申报贡献 → 各自 agreed 共同确认（可 objected 表达不同意见）
        ↘ 主持人 decideOrdering 裁定署名顺序（可选）
   达到 requiredConfirmations 且无未决异议 → authorize → publish（发布摘要）
后续修改：POST /resources/:rid/versions 从已发布版本分叉 → 继承已确认贡献 → 独立协商
争议：任一参与者 raiseDispute（带 basis）→ 版本 frozen（仅该分支）
        → respond / resolve 或 withdraw → unfreeze → 继续
```

## 代码结构

- `src/domain.js`：领域枚举与权重建议区间。
- `src/errors.js`：领域错误及 HTTP 状态码映射。
- `src/store.js`：只追加事件日志（JSONL，支持批量原子写入；`null` 文件为内存模式）。
- `src/projection.js`：事件重放读模型（版本图、贡献、确认、异议、署名轨迹、发布门槛）。
- `src/service.js`：协商规则与命令处理（纯领域逻辑，不持有可变状态）。
- `src/auth.js`：持有者令牌与身份解析。
- `src/server.js`：零依赖 HTTP 路由薄封装。
- `index.js`：启动入口（重放日志 → 装配服务）。

## 测试

```bash
npm test
```

覆盖：完整协商发布链路、确认范围门槛、重复确认不增权、反对立场阻断、异议即冻结与分支隔离、解冻条件、撤回留痕、继承规则、署名裁定与还原、证据时间线、保密说明权限、发布不可变、HTTP 认证与端到端，以及真实落盘后的“进程重启”状态恢复。
