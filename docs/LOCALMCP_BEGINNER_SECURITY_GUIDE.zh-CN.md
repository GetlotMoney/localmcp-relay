# LocalMCP 从零理解、日常使用与安全维护指南

> 面向第一次接触网络、MCP、Cloudflare、Git/GitHub 的使用者。
>
> 本文不假设你已经理解任何专业名词。目标不是让你“照着命令抄一次”，而是让你以后遇到问题时知道系统里每一层在做什么、哪一层出了问题、应该检查什么。

---

## 0. 先记住一句话：LocalMCP 到底是什么

LocalMCP 的作用可以粗略理解成：

> **让 ChatGPT 通过一个经过认证的互联网中转站，调用你自己电脑上的文件、命令行和进程能力。**

它不是“ChatGPT 直接进入你的电脑”，也不是“把 Windows 某个端口直接开放到公网”。

当前这套自建结构可以画成：

```text
ChatGPT
   │
   │ HTTPS 请求
   ▼
你自己的 Cloudflare Worker
   │
   │ 已认证的中继
   ▼
Cloudflare Durable Object
   │
   │ 已经由本机主动建立的 WebSocket 长连接
   ▼
LocalMCP Agent（你的电脑）
   │
   ├── 文件工具
   ├── Shell 命令
   ├── 持久进程
   ├── Skills
   └── 外部 MCP Server
```

核心安全思想是：

```text
你的电脑主动向外连接 Cloudflare
而不是
Cloudflare / 互联网主动打进你的 Windows 端口
```

---

# 第一部分：必须先懂的基础名词

## 1. 公网（Internet）和局域网（LAN）

### 1.1 局域网是什么

你家里、实验室或公司的 Wi-Fi / 路由器内部网络，就是局域网。

常见地址：

```text
192.168.x.x
10.x.x.x
172.16.x.x ~ 172.31.x.x
```

这些地址一般不能直接从整个互联网访问。

### 1.2 公网是什么

公网就是互联网。

例如：

```text
github.com
workers.dev
openai.com
```

都是公网服务。

### 1.3 “公网可访问”不等于“任何人都有权限”

这是非常重要的区别。

Cloudflare Worker 的地址是公网地址，所以别人理论上可以向它发请求。

但是：

```text
能找到门
≠
有门钥匙
```

LocalMCP 的真正安全边界取决于认证密钥，而不是“别人是否知道 workers.dev 域名”。

---

## 2. IP、端口、127.0.0.1、0.0.0.0

### 2.1 IP 可以理解成“电脑的网络地址”

### 2.2 端口可以理解成“这台电脑上的某扇门编号”

例如：

```text
127.0.0.1:55086
```

其中：

```text
127.0.0.1 = 地址
55086     = 端口
```

### 2.3 `127.0.0.1` 是什么

`127.0.0.1` 叫回环地址（loopback）。

人话：

> 只有这台电脑自己能访问。

所以：

```text
127.0.0.1:12345
```

通常不会被局域网其他电脑或互联网直接访问。

### 2.4 `0.0.0.0` 是什么

当服务监听：

```text
0.0.0.0:12345
```

意思是：

> 在这台电脑所有 IPv4 网络接口上接受连接。

它比 `127.0.0.1` 开放得多。

但是：

```text
0.0.0.0 LISTENING
≠
公网一定能连进来
```

是否真正公网可达，还取决于：

- Windows 防火墙
- 路由器 NAT
- 端口转发
- 公网 IPv4 / IPv6
- 云安全组等

---

## 3. HTTP、HTTPS、WebSocket、WSS

### 3.1 HTTP

网页和 API 最常见的请求协议。

### 3.2 HTTPS

HTTPS = 加密的 HTTP。

例如：

```text
https://example.com
```

### 3.3 WebSocket

普通 HTTP 常见模式是：

```text
客户端问一次
服务器答一次
```

WebSocket 更像：

```text
双方建立一条持续连接
之后可以一直互相发消息
```

LocalMCP Agent 就是主动向 Cloudflare 建立 WebSocket 长连接。

### 3.4 WSS

WSS = 加密的 WebSocket。

类似：

```text
HTTP  → HTTPS
WS    → WSS
```

---

## 4. MCP 是什么

MCP = Model Context Protocol。

可以把它理解成：

> 一套统一约定，让 AI 知道“你有哪些工具、每个工具需要什么参数、调用以后会返回什么”。

例如 LocalMCP 可以向 ChatGPT 暴露：

```text
read_file
write_file
run_command
start_process
read_process
```

ChatGPT 不需要知道 LocalMCP 内部如何实现，只需要按照 MCP 约定调用。

---

## 5. Worker 是什么

Cloudflare Worker 可以理解成：

> 运行在 Cloudflare 云端的一小段服务器程序。

你的 `localmcp-relay` Worker 主要负责：

1. 接收 ChatGPT 的 MCP 请求；
2. 验证密钥；
3. 找到对应设备；
4. 把请求转发到已经在线的 LocalMCP Agent；
5. 把 Agent 的返回结果再转给 ChatGPT。

Worker 本身不等于你的电脑。

---

## 6. Durable Object 是什么

Cloudflare Durable Object 可以先理解成：

> Cloudflare 上“为某个设备保存状态并维持连接”的小房间。

在当前实现里，一个 `deviceId` 会映射到一个 Durable Object。

它保存的核心信息包括：

- Agent token 的哈希
- MCP token 的哈希
- 当前 Agent WebSocket
- 当前待处理请求状态

---

## 7. Token、Secret、Hash 到底分别是什么

这是最关键的一组概念。

### 7.1 Token

Token 可以理解成：

> 一串随机生成的秘密钥匙。

当前 LocalMCP 使用高随机度 token 来认证。

### 7.2 Secret

Secret 是“秘密值”的泛称。

例如：

```text
REGISTRATION_SECRET
```

就是你自己保存的“注册管理员密码”。

### 7.3 Hash

Hash 可以理解成：

> 给一个值生成固定长度的“指纹”。

例如：

```text
secret
  ↓ SHA-256
hash
```

重要性质：

```text
知道 secret → 很容易算出 hash
知道 hash   → 正常情况下不能倒推出 secret
```

所以服务端适合保存 hash，而不是保存真正密码。

### 7.4 当前注册保护

你自己保存：

```text
REGISTRATION_SECRET
```

Cloudflare Worker 保存：

```text
REGISTRATION_TOKEN_HASH
```

这样 Cloudflare 不需要保存原始管理员密码。

---

# 第二部分：当前系统里到底有哪几把“钥匙”

## 8. Agent Token

Agent Token 用来证明：

> “这个连接到 Worker 的 LocalMCP Agent 是真正属于该设备的 Agent。”

用途：

```text
LocalMCP Agent
→ /agent/<deviceId>
→ Authorization: Bearer <agentToken>
```

它主要保护 Agent WebSocket。

---

## 9. MCP Token

MCP Token 用来证明：

> “访问这个 MCP 设备的人持有正确的远程访问凭证。”

MCP URL 形式：

```text
https://YOUR-WORKER.workers.dev/mcp/<deviceId>/<mcpToken>
```

因此：

> **完整 MCP URL 本身就是访问凭证。**

不要把它当普通网址。

安全级别应该接近：

- API Key
- SSH 私钥
- 密码

不要：

- 发到聊天群
- 提交 GitHub
- 发公开 Issue
- 截完整图
- 贴完整终端日志

---

## 10. Registration Secret

这是当前自建版本新增的“注册管理员密码”。

作用：

> 控制谁可以调用 `/register` 创建新设备。

之前：

```text
任何互联网用户
→ POST /register
→ 都能创建一套自己的 device/token
```

这不等于对方能控制你的设备，但可以滥用你的 Worker 资源。

现在：

```text
POST /register
        ↓
必须知道 Registration Secret
        ↓
才能注册
```

健康检查：

```powershell
Invoke-RestMethod "$worker/healthz"
```

看到：

```text
registration : protected
```

说明注册入口已经受保护。

---

# 第三部分：MCP URL 为什么这么敏感

## 11. URL 不只是“地址”

普通网址：

```text
https://example.com/page
```

通常只是位置。

而当前 LocalMCP MCP URL：

```text
https://worker/mcp/deviceId/mcpToken
```

最后一段直接包含 token。

所以：

```text
知道完整 URL
≈
知道访问钥匙
```

这就是为什么泄露以后不能只“删聊天记录”，而应该直接换 token。

---

# 第四部分：密钥轮换（Token Rotation）

## 12. “轮换”是什么意思

轮换（rotation）就是：

```text
旧钥匙
→ 生成新钥匙
→ 服务端开始只承认新钥匙
→ 旧钥匙失效
```

不是“同时保留两把钥匙”。

---

## 13. 当前自建版本的轮换设计

当前仓库新增接口：

```text
POST /rotate/<deviceId>
Authorization: Bearer <当前 mcpToken>
```

Worker 会：

1. 验证当前 MCP token；
2. 生成全新的随机 MCP token；
3. 用新 token 的 SHA-256 hash 覆盖旧 hash；
4. 返回新的 MCP URL；
5. 旧 MCP URL 立即失效。

注意：

```text
deviceId   不变
agentToken 不变
mcpToken   改变
```

因此只需要更新 ChatGPT 使用的 MCP URL，不需要重新注册整个 Agent。

---

## 14. Windows 上推荐的安全轮换方法

如果：

```powershell
npm run worker:rotate
```

因为 Node 网络连接问题超时，可以使用 PowerShell。

### 14.1 先停止 LocalMCP（泄露事件时建议）

```powershell
localmcp stop
```

### 14.2 安全轮换

```powershell
$path = "$env:USERPROFILE\.localmcp\worker.json"
$settings = Get-Content $path -Raw | ConvertFrom-Json

$rotateUrl = ($settings.workerUrl -replace '/+$','') + "/rotate/" + $settings.deviceId

$headers = @{
    Authorization = "Bearer $($settings.mcpToken)"
}

$result = Invoke-RestMethod `
    -Method Post `
    -Uri $rotateUrl `
    -Headers $headers

if (-not $result.mcpToken -or -not $result.mcpUrl) {
    throw "轮换失败：Worker 没有返回新的密钥"
}

$settings.mcpToken = $result.mcpToken
$json = $settings | ConvertTo-Json -Depth 10

[System.IO.File]::WriteAllText(
    $path,
    $json,
    [System.Text.UTF8Encoding]::new($false)
)

Set-Clipboard -Value $result.mcpUrl
Write-Host "成功：旧 MCP URL 已失效，新 MCP URL 已写入 worker.json，并复制到剪贴板。"
```

这段命令故意不打印新 URL。

### 14.3 再启动 LocalMCP

```powershell
localmcp
```

然后：

```powershell
localmcp status
```

只确认：

```text
Status: running
```

不要在公开场合贴完整 `MCP URL:`。

---

# 第五部分：ChatGPT 端怎么换新 URL

## 15. 为什么旧连接器可能不能编辑

ChatGPT 的自定义 MCP / 插件界面可能不会给已有连接提供直接编辑 URL 的能力。

这种情况下可以：

1. 保留旧记录；
2. 创建一个新的自定义 MCP 连接；
3. 使用新的 MCP URL；
4. 旧连接因为旧 token 已失效，已经没有访问能力。

真正决定安全的是：

```text
Worker 是否还承认旧 token
```

而不是 UI 里旧名字是否还存在。

---

# 第六部分：自建 Worker 与公共 Worker

## 16. 公共 Worker

如果使用项目作者提供的 Worker：

```text
ChatGPT
→ 作者运营的 Worker
→ 你的 Agent
```

你需要额外信任第三方中继。

## 17. 自建 Worker

当前架构是：

```text
ChatGPT
→ 你自己的 Cloudflare Worker
→ 你的 Agent
```

好处：

- Worker 部署归你自己的 Cloudflare 账号控制；
- GitHub 代码归你自己的仓库控制；
- 可以自己修改注册、认证和轮换逻辑；
- 减少一个第三方运营信任节点。

---

# 第七部分：本地端到底有没有暴露公网

## 18. 如何检查监听端口

Windows：

```powershell
netstat -ano | findstr LISTENING
```

更清楚的版本：

```powershell
Get-NetTCPConnection -State Listen |
Sort-Object LocalPort |
Select-Object LocalAddress,LocalPort,OwningProcess,
@{Name='Process';Expression={
    try {(Get-Process -Id $_.OwningProcess -ErrorAction Stop).ProcessName}
    catch {'?'}
}} |
Format-Table -AutoSize
```

判断：

```text
127.0.0.1:xxxx  → 通常仅本机
0.0.0.0:xxxx    → 所有 IPv4 网卡
[::]:xxxx       → 所有 IPv6 网卡
```

LocalMCP 当前 Agent 会把内部 HTTP 服务绑定到 `127.0.0.1`。

因此核心路径不是：

```text
互联网 → 你的 Windows:某端口
```

而是：

```text
你的 Windows → 主动建立 WSS → Cloudflare
```

---

# 第八部分：Workspace 到底保护了什么

## 19. 文件工具的 Workspace

例如配置：

```text
D:\backup\Documents\ChatGPT\gzsl-research
```

那么文件工具会限制：

```text
read_file
write_file
edit_file
delete_path
```

只能在对应 workspace 范围内活动。

代码还会阻止：

- `..` 路径穿越
- 符号链接绕过
- 某些 hard link 覆盖风险

---

## 20. 但是 Shell 不是文件沙箱

这是非常重要的一条。

即使 `run_command` 的当前工作目录在：

```text
D:\backup\Documents\ChatGPT\gzsl-research
```

Shell 命令仍然可能主动访问：

```text
C:\Users\...
其他磁盘
SSH
网络
```

因此：

```text
Workspace 文件边界
≠
Shell 操作系统沙箱
```

如果开启：

```text
run_command
start_process
```

就应该把 MCP URL 当成高价值远程执行凭证。

---

# 第九部分：LocalMCP 常用命令到底是什么意思

## 21. 启动

```powershell
localmcp
```

含义：

- 读取本地配置；
- 启动 Agent；
- 启动本地 MCP server；
- 主动连接 Cloudflare Worker。

## 22. 查看状态

```powershell
localmcp status
```

常见输出：

```text
Status: running
PID: 1234
MCP URL: <敏感，不要公开>
Config: ...
Log: ...
```

### PID

PID = Process ID，进程编号。

就是 Windows 给正在运行程序分配的编号。

## 23. 停止

```powershell
localmcp stop
```

意味着 Agent 下线。

Worker 仍在公网，但没有本机 Agent 可以转发。

## 24. Reload

```powershell
localmcp reload
```

用于重新读取配置。

---

# 第十部分：本地 `.localmcp` 目录有什么

默认：

```text
C:\Users\<用户名>\.localmcp\
```

常见文件：

### `localmcp.json`

LocalMCP 功能和 workspace 配置。

### `worker.json`

非常敏感。

包含：

- workerUrl
- deviceId
- agentToken
- mcpToken

不要提交 GitHub。

### `connection.json`

包含当前连接信息，可能包含完整 MCP URL。

同样按敏感文件处理。

### `agent.log`

日志。

排错时非常有用，但发送日志前一定检查是否包含：

- MCP URL
- token
- secret

---

# 第十一部分：Git 和 GitHub 基础

## 25. Git 是什么

Git 是版本管理工具。

可以理解成：

> 给代码建立可追踪的“时间线”。

## 26. GitHub 是什么

GitHub 是托管 Git 仓库的网站。

Git 是工具，GitHub 是服务平台。

类似：

```text
Git    ≈ 文档版本管理机制
GitHub ≈ 在线存放和协作这些版本的地方
```

---

## 27. Repository / Repo

Repository = 仓库。

就是一个被 Git 管理的项目目录。

当前：

```text
GetlotMoney/localmcp-relay
```

就是一个 GitHub 仓库。

---

## 28. Branch / 分支

分支可以理解成：

> 从当前代码复制出一条独立开发线。

例如：

```text
main
  └── security/minimal-relay-hardening
```

可以在安全分支改代码，不立刻影响正式版本。

---

## 29. main

`main` 通常是正式主分支。

Cloudflare 如果绑定 GitHub 自动部署，通常会从指定主分支部署线上 Worker。

---

## 30. Commit

Commit = 一次明确的版本快照。

可以理解成：

> “保存一次代码历史节点。”

---

## 31. Pull Request / PR

PR 可以理解成：

> “我在分支里改好了，请把这些改动审查后合并到 main。”

典型流程：

```text
main
 ↓
创建 branch
 ↓
修改
 ↓
测试
 ↓
PR
 ↓
审查
 ↓
merge
 ↓
main 更新
```

---

## 32. Merge

Merge = 合并。

就是把分支里的修改正式并回主线。

---

## 33. Clone / Pull / Fetch

### Clone

```powershell
git clone <URL>
```

第一次把整个 GitHub 仓库复制到本机。

### Fetch

```powershell
git fetch
```

只获取远端的新信息，不自动改当前工作区。

### Pull

```powershell
git pull
```

通常相当于：

```text
fetch
+
把远端更新合到当前本地分支
```

---

# 第十二部分：Fork 到底是什么，以及当前仓库算不算你的项目

## 34. GitHub Fork 的严格定义

GitHub 的 Fork 是：

> 平台显式记录“这个仓库来自另一个仓库”的派生关系。

Fork 页面通常会显示类似：

```text
forked from upstream-owner/upstream-repo
```

GitHub API 里会出现：

```text
"fork": true
```

---

## 35. 当前 `GetlotMoney/localmcp-relay` 的实际状态

当前 GitHub 元数据是：

```text
owner = GetlotMoney
fork  = false
```

所以：

> **严格从 GitHub 仓库关系来看，它现在是你的独立仓库，而不是 GitHub Fork Network 中的 fork。**

这很可能是因为 Cloudflare 的部署/导入流程把上游源码导入成了你的独立 repository，而不是点击 GitHub 的 Fork 按钮创建平台级 fork。

---

## 36. “仓库属于我”不等于“原始代码都是我写的”

必须区分三个概念：

### 仓库控制权

当前仓库 Owner 是你，你有 admin / push 权限。

你可以：

- 修改代码
- 创建分支
- 合并 PR
- 删除仓库
- 改仓库设置

所以从账号和仓库管理角度，它确实是你的仓库。

### 原始作者身份

LocalMCP 的原始代码来自 `daodao97/localmcp`。

不能因为复制到了自己账户，就把原始作者身份改写成自己。

### 你的修改

你后来新增、修改的代码和配置，是你这个派生项目自己的维护内容。

因此更准确的表述是：

> **这是你控制和维护的个人派生项目 / 独立仓库，基于 daodao97 的 MIT 开源 LocalMCP 代码。**

---

## 37. MIT License 意味着什么

当前仓库使用 MIT License。

它允许：

- 使用
- 修改
- 合并
- 发布
- 分发
- 再许可
- 商业使用

核心条件是：

> 保留原版权声明和 MIT 许可声明。

所以不要删掉：

```text
Copyright (c) 2026 daodao97
```

以及 MIT License 正文。

---

# 第十三部分：自建 Worker 的部署逻辑

## 38. GitHub 和 Cloudflare 是怎么连起来的

当前流程大致是：

```text
GitHub main
   ↓
Cloudflare 检测到更新
   ↓
自动构建 / 部署
   ↓
新的 Worker 版本上线
```

所以：

```text
GitHub 代码改了
≠
本机 Agent 自动升级
```

这里有两个独立部分：

1. 云端 Worker 代码；
2. 本机安装的 LocalMCP npm 程序。

要分开理解。

---

# 第十四部分：如何判断哪里坏了

## 39. 分层排错原则

不要看到“连接失败”就随便改东西。

按照层级排：

```text
1. 本机 LocalMCP 是否 running？
2. Worker /healthz 是否正常？
3. ChatGPT 使用的 URL 是否是当前 token？
4. Worker 是否能认证？
5. Agent WebSocket 是否在线？
6. 本地 MCP 工具是否正常？
```

---

## 40. 检查 LocalMCP

```powershell
localmcp status
```

期望：

```text
Status: running
```

---

## 41. 检查 Worker

```powershell
$worker = (Get-Content "$env:USERPROFILE\.localmcp\worker.json" -Raw | ConvertFrom-Json).workerUrl
Invoke-RestMethod "$worker/healthz"
```

期望：

```text
ok           : True
service      : localmcp-relay
registration : protected
```

这个检查不包含 MCP token，可以安全用于普通排错。

---

## 42. GitHub 网络问题

先测试 TCP：

```powershell
Test-NetConnection github.com -Port 443
```

再测试 HTTPS：

```powershell
curl.exe -I https://github.com
```

再测试 Git：

```powershell
git ls-remote https://github.com/GetlotMoney/localmcp-relay.git
```

三层含义：

```text
Test-NetConnection → 网络端口能不能连
curl               → HTTPS 能不能正常请求
git ls-remote      → Git 本身能不能访问仓库
```

如果 clone 偶发超时，可使用浅克隆：

```powershell
git clone --depth 1 <repo-url>
```

`--depth 1` = 只拉最新历史，数据更少。

---

## 43. Node fetch 超时但 PowerShell 能访问

可能出现：

```text
PowerShell Invoke-RestMethod 正常
Node fetch 超时
```

这说明：

> 不同程序可能使用不同的代理/网络路径。

不要因此误判 Worker 挂了。

优先分层验证：

```text
Worker /healthz 是否成功？
```

如果 PowerShell 能成功访问 Worker，Worker 本身通常没坏。

---

# 第十五部分：测试代码为什么会“误伤真实环境”

## 44. 测试环境必须隔离

自动测试应该使用：

```text
临时 HOME
临时 USERPROFILE
临时 worker.json
临时端口
```

否则 Windows 测试可能意外读取真实：

```text
C:\Users\Administrator\.localmcp
```

这会导致：

- 测试连接真实 Agent
- 日志打印真实 MCP URL
- 测试结果失真

所以测试“能跑”不代表测试“隔离正确”。

这是非常重要的软件工程概念：

> **测试不仅要验证功能，还必须与生产环境隔离。**

---

# 第十六部分：如果 MCP URL 泄露，标准应急流程

## 45. 第一步：把泄露当真

不要纠结：

```text
“应该没人看到吧？”
```

只要完整 token 进入：

- 聊天
- 日志
- 截图
- GitHub
- Issue
- 公开网页

就按照泄露处理。

---

## 46. 第二步：必要时先停 Agent

```powershell
localmcp stop
```

作用：

```text
即使旧凭证暂时还有效
也没有在线 Agent 可执行请求
```

---

## 47. 第三步：轮换 MCP Token

使用本文前面的 rotation 方法。

确认：

```text
旧 MCP URL → 失效
新 MCP URL → 生效
```

---

## 48. 第四步：更新 ChatGPT

创建或替换成新 MCP URL。

不要再把新 URL 发到聊天。

---

## 49. 第五步：重新启动 Agent

```powershell
localmcp
```

---

# 第十七部分：日常最佳实践

## 50. 每次真正操作前检查

推荐养成习惯：

```powershell
localmcp status
```

确认自己操作的是预期 Agent。

---

## 51. 不要长期到处复制完整 MCP URL

需要复制时，尽量：

```text
直接复制到目标配置框
不要经过聊天 / 笔记 / Issue
```

---

## 52. 日志分享原则

发日志前搜索：

```text
/mcp/
token
secret
Authorization
Bearer
```

确认没有完整凭证。

---

## 53. GitHub 不应该出现的文件

不要提交：

```text
.localmcp/
worker.json
connection.json
.env
.dev.vars
真实 secret
真实 MCP URL
```

当前 `.gitignore` 已经包含多项相关规则，但仍然要人为检查。

---

## 54. Shell 权限越大，MCP Token 就越敏感

如果只允许读文件，泄露影响较小。

如果允许：

```text
run_command
start_process
SSH
```

那么 token 泄露影响显著上升。

可以把安全风险简单理解为：

```text
风险 ≈ 凭证泄露概率 × 凭证拥有的权限
```

---

# 第十八部分：当前这套自建版本相比原始版本新增了什么

当前个人维护版本已经加入：

### 1. 注册保护

环境 Secret：

```text
REGISTRATION_TOKEN_HASH
```

### 2. MCP Token Rotation

接口：

```text
POST /rotate/<deviceId>
```

### 3. 旧 MCP URL 立即失效

轮换完成后服务端 hash 被替换。

### 4. Windows 测试隔离修复

确保 relay 测试不会误连真实用户 `.localmcp` 环境。

这些修改已经经过核心 relay/security 测试验证。

---

# 第十九部分：常用命令速查

## LocalMCP

```powershell
localmcp
localmcp status
localmcp stop
localmcp reload
```

## Worker 健康检查

```powershell
$worker = (Get-Content "$env:USERPROFILE\.localmcp\worker.json" -Raw | ConvertFrom-Json).workerUrl
Invoke-RestMethod "$worker/healthz"
```

## Git 状态

```powershell
git status
```

## 获取远端更新

```powershell
git pull
```

## 检查 GitHub

```powershell
Test-NetConnection github.com -Port 443
curl.exe -I https://github.com
git ls-remote https://github.com/GetlotMoney/localmcp-relay.git
```

## 安装依赖

```powershell
npm ci
```

## 类型检查

```powershell
npm run check
```

## 构建

```powershell
npm run build
```

## 核心中继安全测试

```powershell
npx tsx --test test/relay.test.ts
```

---

# 第二十部分：最终心智模型

以后不要把 LocalMCP 看成一团模糊的“远程连接”。

把它拆成五层：

```text
第 1 层：ChatGPT
负责发 MCP 请求

第 2 层：Cloudflare Worker
公网入口 + 验证 + 路由

第 3 层：Durable Object
设备状态 + token hash + WebSocket

第 4 层：LocalMCP Agent
主动连接 Worker，接收请求

第 5 层：本机工具
文件 / Shell / 进程 / SSH / 外部 MCP
```

遇到问题时永远问：

> **“到底是哪一层出了问题？”**

而不是一上来就重装、删配置或换代码。

安全上永远记住三句话：

> **完整 MCP URL 就是钥匙。**
>
> **Worker 公网可达不等于电脑公网裸露。**
>
> **Workspace 能限制文件工具，但不能把 Shell 变成沙箱。**

---

# 附录 A：当前仓库身份说明

当前仓库：

```text
GetlotMoney/localmcp-relay
```

GitHub 当前将它识别为：

```text
owner: GetlotMoney
fork: false
license: MIT
```

因此从 GitHub 平台关系和仓库控制权来说，它是你的独立个人仓库。

但源码历史上来源于 `daodao97/localmcp`，所以更严谨的表述是：

> **“我个人维护的 LocalMCP 派生版本，基于 daodao97 的 MIT 开源项目。”**

而不是：

> “LocalMCP 原项目是我原创的。”

---

# 附录 B：安全红线

以下内容永远不要公开：

```text
完整 MCP URL
mcpToken
agentToken
Registration Secret
SSH 私钥
API Key
密码
```

如果怀疑已经泄露：

```text
不要争论是否真的有人看到
→ 直接 rotate / revoke
```

这是最省事也最可靠的安全习惯。
