# EasyWork

EasyWork 是一个面向算力平台的对话工作台：普通聊天负责知识与创作，工作模式通过 EasyWork 服务维持 SSH 连接，并把一个网页对话绑定到一个远端 CLI Agent session。FRP 只是在跨设备访问时可选的端口映射方式，不参与 SSH 认证或会话本身。

## 本地启动

需要 Node.js 22.13 或更高版本。

```powershell
npm install
npm run gateway
```

另开一个终端：

```powershell
npm run dev
```

打开 `http://localhost:3000`。开发服务器会把同源 `/api` 与 `/ws` 转发到
`http://localhost:8789`；也可以在构建前通过
`NEXT_PUBLIC_EASYWORK_GATEWAY_URL` 指定独立网关地址。

Windows 也可以直接双击 `frp\start.cmd`。它会同时启动网页、网关和 FRP，
并把 npm/Vite/Wrangler/日志缓存放到当前电脑独立的
`.cache\devices\<电脑名>\`。`data\`、`skill\` 等持久数据仍会同步；
Syncthing 设置见 `sync\README.md`。

## 功能

- 三栏响应式界面：导航、聊天/工作画布、可展开任务轨迹。
- 项目与项目内记忆边界，长期记忆、历史引用和来源管理。
- 访客临时目录；注册/登录后使用独立用户目录。
- 技能上传与逐轮选择，所有技能位于 `skill/`。
- 文件解析、切块、关键词检索，以及可选的 Embedding 混合检索。
- 同一账号可保存并同时连接多台 SSH 服务器；每个 Work 对话固定绑定首次选择的服务器。
- SSH 始终由部署 EasyWork 的主机发起：每个账号对应一个 SSH Worker，主机以 Worker 池维护该账号的多台服务器连接；浏览器和设备只订阅状态与任务事件。
- 关闭网页或退出登录不会主动断开 SSH，也不会停止正在执行的 Work 任务；同一账号从其他设备登录后可直接复用主机上的连接并恢复任务进度。
- Worker 使用低频 SSH keepalive，不自动重连意外中断的连接；连续 30 天没有用户主动请求的空闲连接会被定期清理。
- 自动扫描 Agent，或将 OpenCode 安装到远端 `~/.easywork/agents/opencode`。
- Agent 使用自己的配置和数据目录；EasyWork 只在 `~/.easywork/bindings` 保存对话与 Agent task 的绑定。
- Work 的“执行计划”直接镜像 Agent 原生 todo/plan 快照及状态；Agent 没有创建计划时，页面不显示计划栏目，网页端不会另行编排或猜测进度。
- 通过当前 SSH 连接浏览、上传和下载远端文件。
- 一个 Work 对话对应一个 Agent session，过程事件实时映射到页面。

## 目录

```text
app/                  前端界面
gateway/server.mjs    本地账户、检索、SSH 与 Agent 网关
prompts/              chat-system.md 与 work-system.md
skill/                内置、访客和用户技能
data/                 运行时账户与索引数据（Git 忽略）
tests/                渲染与网关集成测试
```

网页聊天 API Key 和账号保存的 SSH 私钥使用本机生成的 AES-256-GCM 密钥加密。私钥短密码和 TOTP 只保存在网关内存中，首次连接使用 TOFU 主机指纹确认。Work 模式不再向 Agent 注入 EasyWork 模型配置；Agent 直接读取自己的原生配置。

每个账号的 SSH 凭据仍保存在其加密的 `secrets.json` 中；非敏感的 Worker 会话状态、最近主动使用时间和进行中任务日志保存在同目录的 `ssh-worker.json`。服务进程重启后不会伪装成仍在线，也不会自动重连服务器：页面会显示已断开，由用户重新认证。

## 验证

```powershell
npm test
npm run lint
```

生产托管版本提供完整界面与演示模式。真实 SSH 需要在能访问算力平台的机器上运行本地网关，并使用本地开发地址或将前端网关地址指向受保护的 HTTPS/WSS 网关。
