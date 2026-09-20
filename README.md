<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="EasyWork — Connect conversations, knowledge and remote work">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.2-17786B?style=flat-square" alt="Version 0.1.2">
  <img src="https://img.shields.io/badge/platforms-Windows%20%2F%20Linux-17786B?style=flat-square" alt="Windows and Linux">
  <img src="https://img.shields.io/badge/architecture-x64-17786B?style=flat-square" alt="64-bit x86">
  <img src="https://img.shields.io/badge/deployment-self--hosted-17786B?style=flat-square" alt="Self-hosted">
</p>

<p align="center">
  <a href="README_zh.md"><b>简体中文</b></a> · <b>English</b>
</p>
<p align="center">
  <a href="#features">Features</a> · <a href="#download-and-install">Download and Install</a> · <a href="#quick-start">Quick Start</a> · <a href="#faq">FAQ</a>
</p>

## What is EasyWork?

**EasyWork is a conversational workspace connecting AI, personal knowledge and remote servers.** Chat and search your materials in a browser, or use SSH to let an Agent write code, process files and run computing tasks in a remote workspace. Conversations, files, terminals, server resources and job status share one interface.

EasyWork integrates **OpenCode, Codex, Claude Code and Qoder CN**, with projects, file collections, skills, layered memory and access across devices. Host EasyWork on your own Windows or Linux machine; Agents run on the Linux servers you connect to.

## Features

### 💬 Chat and Work

- **Chat mode**: Ask questions with your models, files, skills and memories. No server connection is required.
- **Work mode**: Choose a server, Agent and workspace. The web assistant gathers relevant materials; the remote Agent receives the original request and handles planning, execution and the response.
- **Streaming conversations**: Follow replies, tool activity and progress as they arrive. Append messages, interrupt, approve actions or compact context where supported by the Agent.
- **Images and attachments**: Upload or paste images for vision models. In work mode, manually attached original files can be delivered to the remote Agent.

### 🖥️ Remote Workbench

- Connect through SSH passwords or keys, including interactive authentication and server fingerprint confirmation.
- Browse, upload, download and preview remote files, open terminals and inspect computing resources.
- Submit, cancel and track jobs on Slurm servers, with ongoing status updates for registered jobs.
- Continue connections, terminals and conversations across devices with the same account. Closing the browser leaves background tasks running while the EasyWork host stays online.

### 📚 Files, Projects and Memory

- Organize materials into file collections linked to projects or conversations. Search text, Markdown, PDF, Word and other supported content.
- Retain user preferences, project context and stable facts from conversations for later work.
- Use `@` to reference other conversations explicitly and continue from relevant records.
- Preview generated files and images in the conversation, zoom in or download results.

### 🧩 Four Agents and Custom Skills

- Choose **OpenCode, Codex, Claude Code or Qoder CN**, with model selection and the runtime options each Agent supports.
- OpenCode, Codex and Claude Code use configured model services. Qoder CN uses its own account login, model catalog and quota.
- Install skills from the market, or upload and edit your own. Set their scope to chat, work or both.
- Server types, allowlists and denylists apply only in work mode. Skills set to both modes remain available in chat.
- Agent and server switches retain separate sessions that can be resumed. Changing the workspace for the same Agent and server keeps its existing session.

### 🌿 Conversation Branches and File History

- Branch a conversation or return to an earlier message to explore another approach.
- Coordinate conversation rewinds with tracked remote file versions. Conflicts require attention before later changes can be overwritten.
- Automatic file history is independent of workspace Git. Available rewind behavior depends on the Agent and the state of the files.

### 🌐 Self-Hosting and Access Across Devices

- Access the same EasyWork installation from desktop and mobile browsers.
- Keep account data and encrypted credentials on your host, with separate materials and connections for each account.
- Use personal model APIs or administrator-provided models, Embedding and OCR services.

## Download and Install

Releases are **x86-64 / AMD64 only**. Windows 10 and Windows 11 share one package.

| Host system | Package | Runtime |
| --- | --- | --- |
| Windows 10 / 11, x64 | `easywork-0.1.2-windows-x64.zip` | Node.js included |
| Ubuntu 22.04 or later, x64 | `easywork-0.1.2-linux-x64.tar.gz` | Node.js included |
| CentOS 7.9, x64 | `easywork-0.1.2-linux-centos7-x64.tar.gz` | Node.js compatible with glibc 2.17 included |

Download the matching package from [Releases](../../releases). Local builds are written to `releases/` with `SHA256SUMS.txt`. Extract the archive and start the web service; a separate Node.js installation is unnecessary.

Use the dedicated CentOS 7 package for that system. It includes the Node.js [glibc 2.17 community build](https://github.com/nodejs/unofficial-builds#builds).

### Install Your Selected Agent

**Release archives do not include downloaded Agent applications.** The `agent-app/` directory contains the download scripts for the host system, a pinned version catalog and the files needed by those scripts. Download the Agents you need, then install them on the remote server through EasyWork. Chat alone does not require this step.

This EasyWork release uses the following fixed versions. The scripts do not follow the latest upstream releases:

| Agent | Script name | Pinned version |
| --- | --- | --- |
| OpenCode | `opencode` | `1.18.30` |
| Codex | `codex` | `0.154.0` |
| Claude Code | `claudecode` | `2.1.269` |
| Qoder CN | `qodercncli` | `1.1.53` |

Run the appropriate command from the extracted directory, replacing `codex` with your choice:

```powershell
# Windows 10 / 11: download Codex only
.\agent-app\update-agent-app.cmd --agent codex --platform linux-x64

# PowerShell is also supported
.\agent-app\update-agent-app.ps1 -Agent codex -Platform linux-x64
```

```bash
# Ubuntu / CentOS 7: download Codex only
sh agent-app/update-agent-app.sh --agent codex --platform linux-x64
```

- **Choose what to download**: `--agent opencode,codex` selects multiple Agents. Only an explicit `--all` selects all four. Running without arguments shows help and downloads nothing.
- **Select the remote platform**: `--platform` describes the Linux server where the Agent will run, not the host running the script. The default is `linux-x64`; `linux-x64-musl`, `linux-arm64` and `linux-arm64-musl` are also supported. Separate multiple platforms with commas. Windows hosts also download remote Linux installers.
- **Verify and repair**: Files are checked against their SHA-256 and size. Valid files are reused; rerun the same command to restore missing or damaged files. Add `--check` for offline verification. PowerShell uses `-Check` and `-All`.
- **Compatibility builds**: Claude Code downloads for `linux-x64` also include pinned version `2.1.170` for older glibc environments. Qoder CN includes a baseline build of `1.1.53`. EasyWork selects artifacts using the remote host's capabilities; requirements still vary by Agent.

After downloading, connect SSH in work mode, open the Agent selection panel and click **Install**. For an existing managed Agent, **Update** synchronizes it with this release's pinned catalog. Configure its model service or complete Qoder CN account login. Scripts use the bundled Node.js runtime; source deployments require Node.js 22.13 or later.

## Quick Start

### 1. Start the Service

**Windows**: Extract `easywork-0.1.2-windows-x64.zip`, open the folder and double-click **`start.cmd`**.

**Ubuntu**:

```bash
tar -xzf easywork-0.1.2-linux-x64.tar.gz
cd easywork-0.1.2-linux-x64
./start.sh
```

**CentOS 7**:

```bash
tar -xzf easywork-0.1.2-linux-centos7-x64.tar.gz
cd easywork-0.1.2-linux-centos7-x64
./start.sh
```

Open **[http://127.0.0.1:8001](http://127.0.0.1:8001)** on the host. Other devices can use `http://HOST_IP:8001` when the network allows it. Keep the service running during use; press `Ctrl+C` in its terminal to stop it.

### 2. Register and Set Up Administrators

There is no preset account or password. **The first registered account automatically becomes an administrator.** Complete this registration before opening the service to others. Administrators can configure shared models, Embedding and OCR in the sidebar's administrator panel.

To add an administrator, have the user register first, then edit `admins/adminList` in the data directory (default: `data/admins/adminList`). Use UTF-8 text with one registered username per line. Removing a line revokes that user's administrator role. Sign in again to refresh the interface, and retain at least one administrator. If `EASYWORK_DATA_ROOT` is set, edit the file under that directory.

### 3. Configure a Model and Start Working

1. Open **Model API** in your profile and enter an API URL and key, or select an administrator-provided service.
2. Choose a model and start chatting. Add file collections, skills or conversation references as needed. Semantic file search requires Embedding. Image understanding uses a vision model where supported, with configured OCR as a fallback.
3. For work mode, download your selected Agent using the scripts above, connect SSH, install it remotely and choose a workspace before sending a task.
4. Follow replies, tool activity, terminals, remote files and job status in the same interface.

See the [user guide](help/help.md) for more operations.

## Configuration and Data

Copy `.env.example` to `.env`, edit it and restart the service. Common settings are `EASYWORK_WEB_PORT` (default: `8001`) and `EASYWORK_DATA_ROOT` (an absolute path is recommended; defaults to `data/` beside the application).

Back up the **entire data directory**, including its encryption material. Before upgrading, stop the service, extract the new release to a separate directory and reuse your existing data directory and configuration. Download Agents as needed. Guest data is temporary; use an account for work you want to retain.

For public access, configure an HTTPS reverse proxy with WebSocket support. The internal rendering port does not need to be public. Model requests send relevant context to the configured model service.

## FAQ

**Will tasks continue after I close the browser?**  
Yes, while the EasyWork host process is running. Reconnect SSH after a host restart; recovery depends on the task state and the Agent's native session records.

**Why do I need to download an Agent after extracting a release?**  
Releases provide the web service and download scripts for the host system. Users prepare Agent applications as needed. Chat requires no Agent download; choose an Agent when you want to use work mode.

**Must the host and work server be the same machine?**  
No. Your browser connects to the EasyWork host, which connects to Linux work servers through SSH. Agent architecture and system requirements follow the work server.

**Can it work entirely offline?**  
The interface is hosted on your own machine. Chat, retrieval and Agent tasks depend on configured services, so offline use requires those services and installation files to be locally available.

## Local Development

Use **Node.js 22.13 or later**:

```bash
npm ci
npm run build
npm start
```

For development, run `npm run gateway` and `npm run dev` in separate terminals. Prepare an Agent when needed:

```bash
npm run agents:download -- --agent codex --platform linux-x64
```

`npm run test:gateway` runs tests; `npm run lint` checks code. Commit your changes, then run `npm run release` to build all three packages. Packaging also requires Python 3.9+ and `tar`; no Agent downloads are needed beforehand. Each archive includes only its host system's Agent download scripts and the pinned catalog.
