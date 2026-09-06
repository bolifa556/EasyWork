<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="EasyWork — Chat, knowledge and remote work in one place">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-17786B?style=flat-square" alt="Version 0.1.0">
  <img src="https://img.shields.io/badge/platforms-Windows%20%2F%20Linux-17786B?style=flat-square" alt="Windows and Linux">
  <img src="https://img.shields.io/badge/architecture-x64-17786B?style=flat-square" alt="64-bit x86">
  <img src="https://img.shields.io/badge/deployment-self--hosted-17786B?style=flat-square" alt="Self-hosted">
</p>

<p align="center">
  <a href="README_zh.md"><b>简体中文</b></a> · <b>English</b>
</p>
<p align="center">
  <a href="#features">Features</a> · <a href="#download">Download</a> · <a href="#quick-start">Quick Start</a> · <a href="#faq">FAQ</a>
</p>

## What is EasyWork?

**EasyWork is a conversational workspace that connects AI, your knowledge and remote servers.** Ask questions in Chat mode, or switch to Work mode to let a coding agent complete tasks in a remote workspace. Conversations, files, terminal sessions and results stay together in your browser.

Connect **OpenCode, Claude Code or Codex**, organize reusable material into projects and file collections, and continue your work from another device. EasyWork runs on a host you control; remote work runs on the Linux servers you connect through SSH.

## Features

### 💬 Chat & Work — From questions to action

- **Chat mode** — Ask questions with a model API you configure, using relevant files, skills and memories when needed.
- **Work mode** — Select a server, agent and workspace, then describe the task in natural language.
- **Visible progress** — Follow tool activity, commands, responses and generated files in the conversation.
- **Continuous work** — Closing the browser does not cancel a task while the EasyWork host remains running.

### 🖥️ Remote Workspace — Your server in the browser

- Connect multiple servers with SSH passwords or keys, with interactive verification when required.
- Browse and preview files, open a terminal and inspect server resources.
- Use an existing directory or create a temporary workspace managed by EasyWork.
- Inspect Slurm jobs and submit or cancel jobs on servers that provide Slurm.

### 📚 Files & Memory — Bring the right context

- Organize files into collections and attach them to conversations or projects.
- Search text, Markdown, PDF and Word documents; image recognition requires an OCR model configuration.
- Retain useful preferences and project context, with project memory scope controls.
- Reference another conversation with `@` and search previous conversations.

### 🧩 Agents & Skills — Continue with the tools you prefer

- Switch between OpenCode, Claude Code and Codex, with relevant context passed to the selected session.
- Install marketplace skills or upload your own, and control where they apply.
- Branch or rewind conversations with coordinated remote file history, subject to the agent's capabilities and file conflicts.

### 🌐 Self-Hosted — One account, multiple devices

- Access the same deployment from desktop or mobile browsers.
- Keep account data and encrypted credentials on your EasyWork host.
- Configure your own model services, or let the administrator provide shared services.

## Download

Only **x86-64 / AMD64** packages are provided. Windows 10 and 11 share one archive.

| Host system | Package | Runtime |
| --- | --- | --- |
| Windows 10 / 11, x64 | `easywork-0.1.0-windows-x64.zip` | Bundled Node.js |
| Ubuntu 22.04+, x64 | `easywork-0.1.0-linux-x64.tar.gz` | Bundled Node.js |
| CentOS 7.9, x64 | `easywork-0.1.0-linux-centos7-x64.tar.gz` | Bundled glibc 2.17 compatible Node.js |

Release assets belong on the repository's [Releases page](../../releases). Local builds are written to `releases/`, together with `SHA256SUMS.txt`.

The CentOS 7 package uses the Node.js project's [unofficial glibc 2.17 build](https://github.com/nodejs/unofficial-builds#builds). Use that archive on CentOS 7, whose system libraries cannot run the ordinary Linux runtime. This is a compatibility build; CentOS 7 is no longer maintained upstream.

These archives start a web service. Open it in a browser; no desktop application or separate Node.js installation is required. AI services and remote SSH servers must be reachable for the corresponding features.

### Install & update agents

**All three release packages include the Linux x64 applications for OpenCode, Codex and Claude Code**, with glibc and musl variants. After extraction, EasyWork can install them on your connected remote servers.

The source repository provides the installer catalog and update scripts; download the applications yourself when deploying from source or restoring missing files. Run the script for your host from the project or installation directory:

```powershell
# Windows 10 / 11
.\agent-app\update-agent-app.cmd
```

```bash
# Ubuntu / CentOS 7
sh agent-app/update-agent-app.sh
```

By default, the scripts download the pinned versions and verify SHA-256 hashes, skipping valid local files. Add `--latest` to download the latest versions, or `--check` to verify local files without downloading. Use `--agent codex` to select one agent. Windows also provides `update-agent-app.ps1`, with `-Latest`, `-Check` and `-Agent codex` parameters. Release packages use their bundled Node.js; source deployments require Node.js 22.13+.

Once the files are ready, connect SSH in Work mode, open the agent selector and click **安装** (Install). For an existing managed agent, click **更新** (Update) to check for and install a newer version, then configure its model API. The scripts prepare installers on the host; the web interface deploys them to the remote server.

Agents currently run on **remote Linux x64 servers**, so the Windows package also includes these remote applications. Each agent has its own system requirements; running the EasyWork host on CentOS 7 does not guarantee that every agent runs on a CentOS 7 remote server.

## Quick Start

### Windows

Extract `easywork-0.1.0-windows-x64.zip` and double-click **`start.cmd`** inside the extracted folder. Keep its window open while using EasyWork.

### Ubuntu

```bash
tar -xzf easywork-0.1.0-linux-x64.tar.gz
cd easywork-0.1.0-linux-x64
./start.sh
```

### CentOS 7

```bash
tar -xzf easywork-0.1.0-linux-centos7-x64.tar.gz
cd easywork-0.1.0-linux-centos7-x64
./start.sh
```

Open **[http://127.0.0.1:8001](http://127.0.0.1:8001)** on the host. Other devices can use `http://HOST_IP:8001` when the network and firewall permit access. Press `Ctrl+C` in the launcher terminal to stop the service.

### Administrator setup

There is no preset administrator account or password. **The first registered account automatically becomes the administrator.** Register before opening a fresh deployment to other users. After signing in, open **管理员面板** (Admin panel) in the sidebar to configure shared models, embeddings and OCR.

To add an administrator, have the user register first, then edit `admins/adminList` inside your data directory (default: `data/admins/adminList`). Save it as UTF-8 text with one registered username per line; remove a line to revoke that user's administrator access. Ask the user to sign in again to refresh the interface, and keep at least one administrator. If you set `EASYWORK_DATA_ROOT`, edit the file under that directory instead.

### Your first task

1. **Create an account.** The first registered user becomes the administrator; complete this step before exposing a fresh deployment to other users.
2. **Configure a model API.** Open your profile → **模型 API** to add an API URL and key, or select a service provided by the administrator.
3. **Start a chat.** Choose a model and send a message. File indexing requires an embedding service; image recognition also requires an OCR service configured by the administrator.
4. **Try Work mode.** Connect an SSH server, configure an agent and select a workspace, then describe your task.

The detailed [user guide](help/help.md) follows the current Chinese interface.

## Configuration & Data

For release packages, copy `.env.example` to `.env` and edit it before starting. Common settings are the public port (`EASYWORK_WEB_PORT`, default `8001`) and an absolute data directory (`EASYWORK_DATA_ROOT`, default `data/` beside the application).

Back up the **entire data directory**, including its encryption material. When upgrading, stop EasyWork, extract the new package into a separate folder and reuse the same data directory and configuration. Guest data is temporary; use an account for work you want to keep.

For internet access, use an HTTPS reverse proxy with WebSocket support on port `8001`; the internal rendering port does not need to be exposed. Files and credentials are stored on your host, while model requests send the selected context to the configured model provider.

## FAQ

**Does my browser have to stay open?**  
No. The host continues running tasks after the browser closes. Keep the host process running. After a host restart, reconnect your SSH servers; recovery depends on the task and the agent's available session state.

**Do I need an SSH server for ordinary chat?**  
No. Chat mode only needs a configured model service. Work mode uses a connected Linux server.

**Will EasyWork change my workspace's Git history?**  
EasyWork's automatic file history is separate from the workspace's Git repository. An agent can still run Git commands when carrying out your instructions.

**Can I use it completely offline?**  
The interface runs on your host. Chat, retrieval and agent tasks depend on their configured services; offline operation requires those services and any needed installers to be available locally.

## Development

Use Node.js **22.13+** and install dependencies from the lockfile:

```bash
npm ci
npm run build
npm start
```

For development, run `npm run gateway` and `npm run dev` in separate terminals. Run the test suite with `npm run test:gateway` and check code with `npm run lint`.

Run `npm run agents:download` to prepare the agent applications, then `npm run release` to build all three complete packages. Building also requires Python 3.9+ and `tar`. Every package includes the agent applications and update scripts for its host system.

```text
app/          Browser interface
gateway/      Application services and remote work
shared/       Shared utilities
prompts/      Model prompts and skill definitions
help/         User guide
doc/          Mechanism and agent documentation
scripts/      Build, startup and release tools
tests/        Automated tests
```
