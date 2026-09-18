# 教研成果署名协商

区域教研共同体统一资源版本、贡献记录与署名协商的基础语义与服务。
`fixtures/version-context.json` 描述一个资源分支及其贡献摘要，`src/domain.js` 列出贡献类别、版本状态和异议处理阶段。
资源版本一经发布不可改写，后续修改从已发布版本建立新的父子关系。

请使用 Node.js 20 或更高版本，运行 `npm test` 校验版本资料。
保密说明和真实教师身份应存放于具备访问控制的运行环境。

## 运行

```bash
npm start                 # 默认事件日志 ./data/events.jsonl，端口 3000
PORT=3100 EVENT_LOG=./data/events.jsonl npm start
```

所有写操作先落盘为不可变事件（JSONL，只追加），再投影到内存；服务重启后重放日志，
版本图、确认记录、异议与冻结状态保持不变。请求以 `X-Teacher-Ref` 头标识教师身份
（演示用的简单方案；生产环境应替换为具备访问控制的认证机制）。

## 协商模型

- **贡献申报** `POST /resources/:r/versions/:v/contributions`：类型取自 `src/domain.js`
  （`authoring` / `review` / `classroom-validation` / `coordination`），附权重建议与依据。
- **共同确认** `POST .../confirmations`：参与者表达同意；重复确认幂等，不增加计数或权重。
- **异议冻结** `POST .../disputes`：任何参与者提出**有依据**的异议立即冻结该版本；
  冻结仅限本版本，其他分支的协商不受影响。异议经主持人回应、裁定（或提出者撤回）后解冻，
  提出者需重新确认。
- **发布授权** `POST .../authorization`：仅主持人可签发，条件是确认数达到版本约定的
  `requiredConfirmations` 且无未决异议；授权时固化署名顺序快照（SHA-256 摘要）。
- **发布** `POST .../publication`：授权后签发不可改写的发布摘要。

### 版本分叉与继承

- 新版本可指定 `parentVersionId` 从任意版本分叉；只继承父版本上**本人已确认同意**的有效贡献，
  确认与异议不带入——内容分叉后必须分别协商。
- 撤回贡献不会删除参与事实：撤回记录保留在版本视图的 `withdrawnContributions` 与历史事件中，
  仅不再进入当前署名顺序。
- 署名顺序：同一教师多类贡献的权重建议相加后降序排列；同权重按首次申报先后确定，全程可由
  事件链解释（`GET .../history`）。

## 查询接口

| 接口 | 说明 |
| --- | --- |
| `GET /resources/:r/versions/:v` | 版本状态、署名顺序、未确认者 `confirmations.unconfirmed`、争议焦点 `disputes.open[].focus` |
| `GET /resources/:r/versions/:v/history` | 还原署名顺序如何形成的完整事件证据链 |
| `GET /resources/:r/versions/:v/graph` | 版本父子图及各分支冻结/确认状态 |
| `GET /resources/:r?confidential=true` | 保密说明；普通教师返回 403，仅主持人/协调员可读 |

异议处理：`POST /disputes/:id/responses`（主持人/协调员回应）、
`POST /disputes/:id/resolutions`（主持人裁定）、`POST /disputes/:id/withdrawal`（撤回异议）。

## 代码结构

- `src/domain.js` —— 贡献类型、版本状态、异议阶段的领域约定
- `src/store.js` —— 只追加事件日志与快照摘要
- `src/service.js` —— 协商规则、状态投影、分叉继承与查询
- `src/server.js` / `bin/server.js` —— HTTP 层与启动入口
- `test/` —— 领域规则测试（10 项）与 HTTP 端到端 + 重启持久化测试（2 项）
