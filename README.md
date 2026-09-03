# EasyWork

EasyWork 是面向个人与算力平台的对话工作台。聊天模式直接调用网页模型；工作模式由部署 EasyWork 的主机统一维护 SSH Worker，并把网页对话、远端服务器、工作区和 CLI Agent 原生会话组合成可持续恢复的任务。

## 启动

需要 Node.js 22.13 或更高版本。

```powershell
npm install
npm run build
npm start
```

打开 `http://127.0.0.1:8001`。网页、`/api` 和 `/easywork-ws` 共用这一个对外端口；内部服务不需要单独访问。独立部署时可通过 `NEXT_PUBLIC_EASYWORK_GATEWAY_URL` 指向受保护的 HTTPS/WSS 网关。

Windows 可使用 `frp\start.cmd` 启动主服务、内部网页渲染器和可选的 FRP 映射。主服务是唯一公开入口；FRP 只映射 `8001 → 8001`，不参与 SSH 认证和远端会话。

开发时可分别运行 `npm run gateway` 与 `npm run dev`；开发服务器同样使用 `8001`，并把 API 与实时连接转发到开发网关。

## 运行模型

- 同一账号的多台设备共享账号配置、对话、文件集、技能和主机维护的 SSH 状态。
- 每个用户拥有一个 SSH Worker；Worker 可同时连接该用户的多台服务器，同一连接可被多个对话复用。
- 网页关闭后，主机继续执行已启动任务；服务重启时只恢复能由 Agent 原生会话安全续接的任务，不能证明可恢复的任务会明确失败收口。
- 一个网页对话可使用多个 Agent；每个 Agent 在每个工作区拥有独立原生会话，切回时只补发缺失上下文。
- EasyWork 管理的数据位于 `data/users/<id>` 或 `data/guests/<id>`；远端控制数据只位于 `~/.easywork`。
- Skill 的用户版本保存在 Actor 数据目录，执行前固定版本与哈希，并只部署到远端 `~/.easywork/skills`，不修改 Agent 原生配置。
- 工作区版本管理使用 `~/.easywork` 下的影子仓库，不读写用户工作区的 `.git`。
- 文件集、项目文件和对话附件统一经过资源提取、切块与 Embedding；原文件、解析结果和向量索引均按用户隔离。

## 目录

```text
app/easywork/       页面 Shell 与按需加载功能模块
app/core/           前端合同、网关客户端和能力注册表
gateway/core/       账户、资源、记忆、SSH、Agent 与任务服务
prompts/            所有模型提示词、工具定义与上下文组装模板
doc/                三份唯一机制规范：SSH、网页 Agent、远端版本与 Agent
data/               用户与访客运行数据（Git 忽略）
tests/              当前架构的领域、HTTP 与集成测试
scripts/            当前构建与启动工具
```

机制说明只维护在 [SSH机制](doc/SSH机制.md)、[网页Agent机制](doc/网页Agent机制.md) 和 [远端文件版本与Agent机制](doc/远端文件版本与Agent机制.md) 三份文档中。

## 验证

```powershell
npm test
npm run lint
```

API Key 与 SSH 凭据在磁盘加密保存；公开响应、实时事件和审计记录均不包含明文密钥。首次连接采用主机指纹确认，管理员 SSH 网络策略会在建立连接前校验主机、解析地址和端口。
