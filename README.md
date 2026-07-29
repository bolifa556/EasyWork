# EasyWork

EasyWork 是一个面向算力平台的对话工作台：普通聊天负责知识与创作，工作模式通过本机网关维持 SSH 连接，并把一个网页对话绑定到一个远端 CLI Agent session。

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

打开 `http://localhost:3000`。前端默认连接 `http://localhost:8789`；也可以在构建前通过 `NEXT_PUBLIC_EASYWORK_GATEWAY_URL` 指定网关地址。

## 功能

- 三栏响应式界面：导航、聊天/工作画布、可展开任务轨迹。
- 项目与项目内记忆边界，长期记忆、历史引用和来源管理。
- 访客临时目录；注册/登录后使用独立用户目录。
- 技能上传与逐轮选择，所有技能位于 `skill/`。
- 文件解析、切块、关键词检索，以及可选的 Embedding 混合检索。
- SSH 私钥 + 短密码 + TOTP 登录，连接随浏览器 WebSocket 生命周期维持。
- 自动扫描或安装 OpenCode 到远端 `~/.easywork`。
- 一个 Work 对话对应一个 OpenCode session，过程事件实时映射到页面。

## 目录

```text
app/                  前端界面
gateway/server.mjs    本地账户、检索、SSH 与 Agent 网关
prompts/              chat-system.md 与 work-system.md
skill/                内置、访客和用户技能
data/                 运行时账户与索引数据（Git 忽略）
tests/                渲染与网关集成测试
```

API Key 使用本机生成的 AES-256-GCM 密钥加密，SSH 私钥、私钥短密码和 TOTP 只保存在网关内存中。首次连接使用 TOFU 主机指纹确认。远端 API Key 写入会话专属的 `~/.easywork/runtime` 临时文件，并在断开时删除。

## 验证

```powershell
npm test
npm run lint
```

生产托管版本提供完整界面与演示模式。真实 SSH 需要在能访问算力平台的机器上运行本地网关，并使用本地开发地址或将前端网关地址指向受保护的 HTTPS/WSS 网关。

