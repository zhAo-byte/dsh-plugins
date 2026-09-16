# dsh-remote-control

**让公网上的一个网页，认出你所有在线的 DeepSeek Harness，并给任意一台下达指令。**

一台 Mac、一台 Windows、以后可能还有第三台——它们都在 NAT 后面，谁也没有公网 IP。
这个项目不要求你动路由器、不要求你给 DSH 开监听端口、也不碰 DSH 自己的
「`--host 0.0.0.0` 被拒绝」那道安全闸门。它只做一件事：**让每台机器主动往外拨**。

它由两半组成，可以单独使用，也可以配套使用：

| 半边 | 跑在哪 | 是什么 |
| --- | --- | --- |
| **node 插件** `dsh-remote-control` | 每台装了 DSH 的机器 | 向中转台登记自己（名字、平台、工作台列表），挂一条长轮询等活；拿到问题后在本地开一个**真正的 DSH 会话**跑完，把回答送回去 |
| **relay 中转台** `relay/server.js` | 一台公网可达的机器 | 在线表 + 信箱 + 一个问答页。**零依赖**，只有一个进程 |

---

## 一、为什么必须是「中转台」而不是「直连」

你的需求里有两条硬约束，它们一起决定了架构：

1. **要给不同的 harness 发指令**，所以需要一个谁都够得着的公共点来记账「谁在线」。
2. **机器在 NAT 后面**，所以任何「从公网连进去」的方案都不成立——除非你开端口映射或上 VPN。

于是方向反过来：**由内向外**。每台机器主动连中转台，中转台只负责转发。
这带来几个直接结果：

- 不需要公网 IP，不需要端口映射，不需要 DDNS；
- 中转台上**不跑 DSH、不跑模型、不存你的模型凭据**。它只知道「哪台机器在线」和「有一句话要转给谁」；
- 加第三台机器时，只要在那台机器上装同一个插件，它自己就出现在列表里。

```
        手机 / 笔记本浏览器（问答页）
                   │ HTTPS
                   ▼
   ┌──────────  中转台 (公网)  ──────────┐
   │  relay/server.js                    │
   │    · 在线表  nodeId / 名字 / 工作台  │
   │    · 信箱    命令排队 + 结果回收     │
   │    · 页面    多标签，一标签一目标    │
   └──────▲───────────────────▲──────────┘
          │ 反向长轮询(出站)    │ 反向长轮询(出站)
    ┌─────┴─────┐        ┌────┴──────┐
    │ Mac + DSH │        │ Win + DSH │
    └───────────┘        └───────────┘
```

---

## 二、快速开始

### 1. 起中转台

零依赖，不需要 `npm install`：

```sh
export DSH_REMOTE_AGENT_TOKEN="$(openssl rand -base64 36 | tr -d '/+=')"
export DSH_REMOTE_CONTROL_TOKEN="$(openssl rand -base64 36 | tr -d '/+=')"
node relay/server.js
# dsh-remote-control relay listening on http://127.0.0.1:8787
```

浏览器打开 `http://127.0.0.1:8787`，输入 **control token**。此时列表是空的——正常，还没有机器登记。

> 两个 token 是**分开**的，理由见第五节。默认只绑 `127.0.0.1`；公网暴露交给反代，见第六节。

### 2. 把插件装到一台机器上

```sh
npm i -g pnpm                       # dsh plugin 依赖 pnpm
dsh plugin --profile web add /path/to/dsh-remote-control
```

然后把配置写进这台机器的补丁层 `~/.dsh/profiles/web/cordis.patch.yml`
（完整注释版见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)）：

```yaml
- id: remote-control
  config:
    relayUrl: 'https://icyu.online/harness'
    nodeToken: 'REPLACE_WITH_DSH_REMOTE_AGENT_TOKEN'
    displayName: 'Studio Mac'
    workspaces:
      - { name: deepseek, path: '~/Desktop/deepseek' }
```

**重启一次后端**（macOS 外壳：`Harness → 重启后端`，⇧⌘R）。后端日志里会出现一行：

```
dsh-remote-control: node "node-3f9a1c2b7d4e" (Studio Mac) → https://icyu.online/harness,
  1 workspace(s), preset standard, permission workspace-write
```

刷新问答页，这台机器就在列表里了。Windows 上重复第 2 步即可，两台机器会同时出现。

### 3. 提问

点一台机器 → 点一个工作台 → 输入问题。整轮跑完后回答会一次性出现在页面上。

每点一个工作台就开出一个**标签**，标签之间彼此独立：各自一个 DSH 会话、各自一段历史、
各自一个发送目标。所以可以同时开多台机器、同一台机器的多个目录，一边等 A 跑完一边去问 B。
输入框旁边的「广播」把同一句话一次派给所有标签。

> 标签是 UI 的并发，不是执行的并发。**同一台机器**同时只跑一个远程回合（见第五节），
> 派给它的多条指令仍然是排队依次跑；真正同时在跑的是**不同机器**。

**这次对话是这台机器上一个普通的 DSH 会话**：它会出现在本地 GUI 的侧边栏和工作区分组里，
有标题、有完整日志、能被你自己继续追问。远程不是一条暗线，它就是本机的一个会话，
只是发起人来自公网。

---

## 二·五、在另一台机器上安装（Windows 也一样）

### 1. 装

```sh
npm i -g pnpm
dsh plugin --profile web add "github:zhAo-byte/dsh-plugins#path:/packages/dsh-remote-control"
dsh plugin --profile web add "github:zhAo-byte/dsh-plugins#path:/packages/dsh-remote-control/client"
```

**两条都要。** 第一条装的是节点本体（宿主行），第二条装的是配置卡片（浏览器半边）。
它们的包名不同是刻意的：`dsh-client-modules` 拒绝「两个活跃行解析到同一个客户端包名」，
所以卡片不能挂在宿主那个包上。第二条报的
`declares no dsh.bundle — installed as a plain dependency` 是**正确提示不是错误**——
带 `dsh.client` 的包只进 `dependencies`，不进 `bundles`。

Windows 上就是同一个命令，Path 换成 Windows 风格即可；不需要额外装什么。

### 2. 更新

git 源的安装会**锁定 revision**，改完代码不会自动生效。拉最新版要显式跑：

```sh
dsh plugin --profile web update
```

不跑这一条，你会一直用着装的那一刻的代码——这个坑我踩过：卡片代码推上去了，
profile 里的包内补丁却还是旧的，表现为「装了但没有那张卡」。

### 2·7、工作台从哪来：`workspaces` 的两种模式

这是个**要么/要么**的开关，两种模式的安全含义不同，所以刻意做成显式选择而不是自动兜底。

**列表模式（默认）** —— 你点名允许的目录：

```yaml
workspaces:
  - { name: '602', path: '~/Desktop/602' }
  - '~/Desktop/deepseek'
```

中转台**只能**操作这张表里的目录，别的一律在碰到 DSH 之前被拒。
代价是要手工维护，而漏写的症状很隐蔽：**页面上就是没有那个目录，没有任何提示说为什么**。

**注册表模式** —— 跟随这台机器真实用过的工作区：

```yaml
workspaces: registry
```

节点每次上报和每次执行命令时都重新读一遍 `ctx.workspaceRegistry`（就是这个页面
本机 GUI 侧边栏读的那份），所以：

- 你在本机新开一个会话 → 那个目录**自动**出现在中转台页面上，不用重启后端；
- 你在本机删掉一个工作区 → 它也不再被提供；
- 名称沿用 GUI 里的标题，两个界面对同一目录的叫法一致。

**代价要说清楚**：中转台能点名的集合，从此由「你本机在哪些目录开过会话」决定，
而不是由你明确批准。**你在某个敏感目录里开过一次会话，它就会自动对外开放。**
这正是它默认关闭、并且节点每次连上都会把模式记进日志的原因 ——
连上时你会看到 `workspaces from the DSH registry`，注册表模式下还会额外打一行警告
列出当前对外开放的全部路径。

想换回严格的边界，把这一项改回列表即可，两种模式随时可切。

### 2·8、它出现在哪两个地方

同一个配置界面挂了两处，改哪一处都一样（同一命名空间、同一份数据）：

| 位置 | 槽位 | 说明 |
| --- | --- | --- |
| **设置 → 插件 → 插件配置 → Remote control** | `settings.plugin.item` | 插件页签里的那张卡，保持「插件页签是全部可配置插件的索引」 |
| **设置 → 远程控制** | `settings.section` | 独立页签，顺序排在通用/模型/插件/Agent 预设之后 |

独立页签是 DSH 官方支持的扩展点，不是给 shell 打补丁：设置槽位契约里写明
「一个 feature 拥有自己的设置页，加一个设置从不需要改 shell」，
已装机的 `agent-presets` 页签就是这么来的（order 20）。

### 3. 配

重启一次后端，然后打开 **设置 → 插件 → 插件配置**，里面会多出一张
**Remote control** 卡片，直接填：

| 字段 | 填什么 |
| --- | --- |
| 中转台地址 | `https://icyu.online/harness` |
| 节点令牌 | 中转台 `/etc/dsh-remote-relay.env` 里的 `DSH_REMOTE_AGENT_TOKEN` |
| 显示名称 | 给它起个名，例如 `我的 Windows 本`（留空会用主机名） |
| 工作台 | **每行一个绝对路径**，例如 `C:/Users/me/projects` |

保存后节点会用新配置重新连上中转台，**不用再重启**。改完刷新
<https://icyu.online/harness/> 就能看到这台机器。

> 令牌字段是密码框，**留空 = 保持原值不变**。它的值存在 `~/.dsh/settings.yaml`（`0600`），
> 也可以直接编辑那个文件，现在这样改同样是立即生效的。

---

## 三、命令跑起来之后会发生什么

一次远程提问的完整路径：

```
页面 POST /api/command
   → 中转台确认：这台机器在线吗？这个工作台是它自己报上来的吗？
   → 命令进信箱，正挂着的那条长轮询立刻拿到它
   → 插件收到命令，先回报 status=busy（页面上就能看到「执行中」）
   → RemoteRunner 在本地：
        ctx.agentPresets.resolve('standard')       取预设
        ctx.workspaceRegistry.create(path)         确保工作台已登记
        ctx.agentDefaultModel.currentSelection()   取默认模型（会话必须有路由）
        ctx.agents.create({ agentOptions: { provider, model },
                            meta: { cwd, agentPreset } })
        agentPresets.mount(agentCtx, preset)       把工具挂到会话作用域
        workspace.attachSession(sessionId)         归入工作区分组
        permissionPresets.set(session, 'workspace-write')
        sessionTitle.rename(session, 问题前 60 字)
        agent.followup(用户消息)
        await agent.whenIdle()
   → 从中转台收到回复？不：从本地会话日志里读
        从提问前的 seq 开始扫事件，取最后一条非空 assistant/message 的文本
   → POST /api/agent/report，带上结果
   → 页面收到 SSE 推送，渲染回答
```

追问会复用同一个 `sessionId`，所以是**同一场对话的延续**，不是每次开新会话。
页面上「新对话」按钮清掉 session id，下一条就会开新会话。

**session 是按「机器 + 工作台」记的，不是按机器记的。** 一个 DSH 会话是在某个工作目录里
创建的、搬不走，所以在另一个工作台上追问必须开新会话。页面按目标存 session，节点侧也会
核对一遍：`sessionId` 带来的工作台和这个会话自己的工作台不一致时重开一个。少了这道核对，
那句提问会跑在**错误的目录**里，然后报告成功——一个没有症状的失败。

---

## 四、HTTP 接口

### 机器侧（`Authorization: Bearer <DSH_REMOTE_AGENT_TOKEN>`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/agent/hello` | 登记/刷新身份与工作台列表，返回 `pollHoldMs` |
| POST | `/api/agent/poll` | 长轮询领命令；空闲挂起到 `pollHoldMs` 后返回 `{ command: null }` |
| POST | `/api/agent/report` | 上报状态（`busy`/`idle`）与命令结果 |

### 页面侧（`Authorization: Bearer <DSH_REMOTE_CONTROL_TOKEN>`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/` | 问答页（本身不需要 token，页面自己会让你输入） |
| GET | `/api/state[?nodeId=]` | 在线表；带 nodeId 时连同该机器的对话记录 |
| GET | `/api/events?token=` | SSE：在线表变化 + 新消息推送 |
| POST | `/api/command` | 提交 `{ nodeId, workspace, prompt, sessionId? }` |

`/api/events` 是唯一接受 query token 的路由——`EventSource` 无法设置请求头。
其余所有路由只认 `Authorization` 头，因此 token 不会出现在日志或 Referer 里。

---

## 五、信任模型（这一节是设计说明，不是免责声明）

**中转台不被信任。** 它是一台公网机器，可能被打穿。所以它的权限被刻意压到最小：

| 它能做 | 它**不能**做 |
| --- | --- |
| 问一个问题 | 指定任意目录：只能用它自己报上来的工作台，否则在**碰 DSH 之前**就被拒 |
| 看到会话的回答 | 批准任何操作：它的协议里**根本没有审批通道** |
| 看到机器名和工作台列表 | 改权限：`permissionPreset` 由本机配置决定，不从线上读 |
| | 假装成另一台机器：token 是每台机器各自的，且与页面 token 分开 |

**两个 token 为什么必须分开**：如果页面和机器共用一个 token，那么一个泄露的浏览器 token
就等于一台机器的身份，可以伪造 `nodeId` 去领别的机器的命令。分开之后，
页面 token 泄了只能读和问，机器 token 泄了只能登记和答题，两者都不足以横向移动。

**审批为什么回落本机**：远程会话固定 `workspace-write + ask`。写工作台内的文件正常进行；
一旦越界（写外部目录、跑危险命令），DSH 的审批服务会拦下来，
弹窗出现在**你本机**的 DSH GUI 里。中转台和页面都没有「同意」按钮可点——
这是构造上做不到，不是我们忘了做。你选了「审批一律回落 Mac 本机确认」，这就是它的实现方式。

**中转台本身的暴露面**：它不读写文件、不连数据库、不执行命令。进程只监听一个端口，
只认那几个路由，其余一律 404。systemd 单元还额外关掉了 `ProtectSystem`、`ProtectHome`、
`MemoryDenyWriteExecute` 等。

**还没做、但你应该知道的**：

- **没有持久化**。中转台重启，在线表和对话记录就没了（机器会自动重新登记，几秒内恢复；
  历史消息丢失）。这是有意的：不落盘就没有磁盘上的凭据和对话副本。需要留存的话，
  真正的记录本来就在每台机器的 `~/.dsh/sessions` 里。
- **每台机器同时只跑一个远程回合**。轮询是单条的，第二个问题会排到队列里等前一个跑完。
  多标签让你同时**盯**多台，但派给同一台机器的多条指令仍然排队依次跑；队列深度会显示在
  标签和节点上。
- **页面没能取消正在跑的回合**。回合跑完之前只能等；本机 GUI 里可以随时中断。
- **中转台的对话记录上限 200 条**（`DSH_REMOTE_TRANSCRIPT_LIMIT`），按机器分别计。

---

## 六、部署到公网（以 `icyu.online` 为例）

这套东西第一次落地时是装在一台**已经在跑别的生产站点**的 Ubuntu 机器上的，
所以下面每一步都按「不许碰现有的东西」来写。实测过的环境事实：
那台机器 `nginx/1.18.0`、站点文件在 `/etc/nginx/sites-enabled/icyu.online`、
已有 `/play/` 和 `/vpn/` 两个 location、`8787` 端口空闲、**而且没有装 Node**。

### 1. 上传

```sh
rsync -az --exclude node_modules --exclude '.git/' \
  -e 'ssh -i ~/.codex/keys/minigame-public-server.pem' \
  ./ ubuntu@49.232.148.72:/opt/dsh-remote-control/
```

### 2. 一键引导（装 Node、生成密钥、装服务、自证可用）

```sh
ssh -i ~/.codex/keys/minigame-public-server.pem ubuntu@49.232.148.72
sudo bash /opt/dsh-remote-control/deploy/bootstrap-relay.sh ubuntu
```

这个脚本做四件事，而且**幂等**，重跑只会修不会重装：

1. **装 Node**，但**不碰 apt**：直接解压官方静态包到 `/usr/local`。
   理由很实际——机器上可能有别的生产服务，而旧版 Ubuntu 的官方源里根本没有 Node 22；
   静态包不改包管理器状态、不装系统库，因此不可能扰动别的站点。
   同时解释器路径固定成 `/usr/local/bin/node`，systemd 单元可以写死。
   （要换版本：`sudo DSH_REMOTE_NODE_VERSION=22.x.y bash ...`）
2. **生成两个 token** 写进 `/etc/dsh-remote-relay.env`（`0600`，只有 root 能读）。
   已存在就保留，不会把你的 token 换掉。
3. **按 `ubuntu` 用户渲染 systemd 单元**并 `enable --now`。
4. **自证**：等端口应答 → 断言匿名请求是 `401` → 断言带真 token 的
   `/api/agent/hello` 是 `200`。失败就把 `journalctl` 打出来。
   这一步不是装饰：它把「环境文件写错了」这种错在你离开机器之前就暴露出来，
   而不是等某台机器注册不上时才发现。

### 3. nginx

```sh
sudo mkdir -p /etc/nginx/backups
sudo cp -a /etc/nginx/sites-enabled/icyu.online /etc/nginx/backups/icyu.online.bak-$(date +%F)
sudo vi /etc/nginx/sites-enabled/icyu.online   # 加进 deploy/nginx-location.conf 的内容，放在 location / 兜底之前
sudo nginx -t && sudo systemctl reload nginx
```

**备份必须放在 `sites-enabled/` 之外。** 那个目录里的**每个文件**都会被 `include`，
所以把 `icyu.online.bak-…` 留在原地，等于多了一份同样的 server 块，
`nginx -t` 会报 `duplicate listen options for [::]:443` 而**拒绝加载**——
此时配置其实是对的，是备份本身让测试失败的。这一步实际踩过。

三个参数**必须有**，少一个都会以「页面能打开但什么都不干」的形式失败：

| 参数 | 少了会怎样 |
| --- | --- |
| `proxy_buffering off` | SSE 变成一阵一阵地刷，看着像卡住 |
| `proxy_read_timeout 120s` | 长轮询被 60 秒默认值切断，机器进入「连上就断」的死循环 |
| `proxy_set_header X-Forwarded-Prefix /harness;` | **页面加载后完全不工作** |

第三条值得展开：`proxy_pass` 结尾那个 `/` 会把 `/harness/` 前缀**剥掉**，relay 只看到 `/`，
于是它无从知道自己在公网上挂在哪儿。页面里的接口调用是相对自己所在目录解析的，
没有这个前缀，浏览器就会把 `/api/state` 发到域名根路径——**被那个域名上别的站点接走**，
relay 根本收不到。relay 拿到这个头之后只给 HTML 注入一个 `<base>`，数据响应一律不动。

这个 bug 是真的踩过：全套测试当时都是挂在根路径上跑的，全部通过，
而生产环境挂在 `/harness/` 下会彻底不可用。现在 `ui-check` 会起一个**和 nginx 行为一致的代理**
（剥前缀 + 加头）专门复现这个挂载方式，`relay-check` 里也有一条零依赖的等价断言。

### 3·5、服务器上的代码在哪（部署后必读）

中转台的代码放在服务器 **`/opt/dsh-remote-control/`**，而且**它现在是一个 git 检出**，
不是散装上传的文件——这样可以随时确认线上跑的是哪一版，也能直接 `git pull` 更新。

```
/opt/dsh-remote-control/                                  ← git 检出（完整 monorepo）
└── packages/dsh-remote-control/relay/server.js           ← 服务实际执行的文件
    packages/dsh-remote-control/relay/public/index.html   ← 问答页
/etc/dsh-remote-relay.env                                 ← 两个令牌（600 root）
/etc/systemd/system/dsh-remote-relay.service              ← 单元文件
```

> **注意路径。** 早期版本是把 `packages/dsh-remote-control` 的内容直接铺在
> `/opt/dsh-remote-control/` 下的，所以 `ExecStart` 一度是 `<那个目录>/relay/server.js`。
> 现在是完整仓库，正确路径多了 `packages/dsh-remote-control/` 一层。
> 改单元文件后**必须 `daemon-reload`**，否则 systemd 会继续用缓存里的旧路径去启动，
> 表现为服务反复 `activating (auto-restart)` + 日志里 `MODULE_NOT_FOUND`。

更新线上代码：

```sh
cd /opt/dsh-remote-control && sudo -u ubuntu git pull
sudo systemctl restart dsh-remote-relay
```

改过单元文件的话，restart 之前先 `sudo systemctl daemon-reload`。

自检：

```sh
systemctl is-active dsh-remote-relay                     # active
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/state   # 401
curl -s -o /dev/null -w '%{http_code}\n' https://icyu.online/harness/      # 200
```

### 4. 验收

```sh
# 匿名请求应当被拒
curl -s -o /dev/null -w '%{http_code}\n' https://icyu.online/harness/api/state    # 401
# 页面应当可加载，并且带上挂载前缀
curl -s https://icyu.online/harness/ | grep -o '<base href="[^"]*">'              # <base href="/harness/">
```

两条都对，就用 `env` 文件里的 control token 打开 `https://icyu.online/harness/`，
再把各台机器的 `nodeToken` 配上。

### 实测记录（2026-09-16 首次落地）

```
Node        22.23.2，静态包装入 /usr/local（未使用 apt）
relay       127.0.0.1:8787，systemd enabled + active，User=ubuntu
加固         NoNewPrivileges=yes  ProtectSystem=strict  ProtectHome=yes
nginx       在 sites-enabled/icyu.online 插入 location /harness/（+26 行，无其他改动）
公网验收     /harness/api/state 401 · /harness/ 200 · /play/ 200 · /vpn/ 401 · / 404
浏览器验收   真 Chromium 走完整登录表单 → roster 到达 → SSE 首帧即时送达
TLS         证书链可信（ssl_verify_result=0）
```

在那台机器上顺带确认了一件事：**`/healthz` 返回 404 不是这次改动造成的。**
原始配置里 grep 不到任何 `healthz`，`location /` 本来就是 `return 404`；
那条路径大概期待 MiniGame 网关自己挂在根路径上。属于既有状态，我没有动它。

---

## 七、自检

四个脚本，零依赖。前三个不需要任何运行中的东西：

```sh
npm test              # = 下面三个
node tools/relay-check.mjs    # 真起 relay/server.js，用真 HTTP 打它
node tools/node-check.mjs     # 真 RelayClient 打假中转台
node tools/runner-check.mjs   # 真 RemoteRunner 打假 Harness

npm run test:live             # 隔离 DSH_HOME 里真启动 web profile
npm run test:ui               # 真 Chromium 里把问答页跑一遍
```

`live-check` 是最关键的一个：它建一个临时 `DSH_HOME`、把插件按用户的方式装进去、
用 `--dump-config` 确认行被组合出来、真启动 web profile、然后断言插件出现在后端日志里、
连上了中转台、报上了工作台、挂上了长轮询、并且在收到一个**未授权工作台**的命令时
在碰 DSH 之前就拒绝并回报。

它存在的原因不是覆盖率，而是这个插件**真的犯过**这个错：第一版在 `apply()` 里直接读
`config.nodeId.trim()`，字段是 `undefined` 就抛异常——抛在插件自己的初始化里，
什么都还没注册，所以没有任何地方能报告它。症状是：行出现在 `--dump-config` 里、
加载了、然后**什么都不做**。没有日志、没有错误、没有线索。
现在配置解析集中在 [`lib/config.js`](lib/config.js)，每个字段都有显式默认值，
而 `live-check` 专门盯死「装上了但没运行」这一类问题。

`ui-check` 用 DevTools 协议驱动真 Chromium：注入 token、加载真页面、**在页面上打字并点
页面自己的发送按钮**，然后自己扮演节点把命令领走回答，断言回答不刷新就出现在页面上；
再从侧边栏开第二个工作台，断言两个标签的历史**互不串台**、第二次提问落在它自己的工作台上、
而且**没有继承**第一个工作台的 session。
它已经抓到过几个只有真浏览器才看得见的问题：首次打开时节点列表渲染出来却**没有自动选中**
（于是工作台、历史、发送按钮全是空的），乐观插入的问句和 SSE 推来的问句重复渲染成两条、
其中一条永远停在「等待中」，以及一个 `position: absolute` 少了定位祖先的提示条——它在 DOM 里，
却被甩到屏幕上方几百像素，肉眼完全看不见。都修了，见 [`relay/public/index.html`](relay/public/index.html)。
它还会把五张截图落到临时目录，给人眼看。

> 多标签那部分还有个教训值得留着：为了看清 ui-check 覆盖不到的状态（执行中、离线、报错、
> 空态、窄屏抽屉），另外写了个一次性的截图脚本，它当场抓到两个真问题——提示条跑到屏幕外，
> 以及窄屏下「权限」被逐字折成两行（`.hint-item` 是 flex 容器，长句子成了可逐字收缩的匿名
> flex item）。这两个都属于「不看就不知道」的那一类，所以两个都补了断言。

`live-check` 和 `ui-check` 都不碰你正在跑的后端，也不碰 `~/.dsh`；临时目录退出即删
（`DSH_REMOTE_CONTROL_CHECK_KEEP=1` 可以留下排查，`ui-check` 的截图也在那里）。

当前实况：

```
relay-check   41/41
node-check    56/56
runner-check  62/62
live-check    21/21
ui-check      31/31
```

CI（[`.github/workflows/checks.yml`](.github/workflows/checks.yml)）分三层：

- **`checks`** 在 **macOS / Windows / Linux** 三平台跑 `npm test`。
  这一步**不执行任何 `npm install`**，并且先断言 `dependencies` 是空的——
  因为「零依赖」是承诺，得让 CI 证明它，而不是让 lockfile 偷偷补货。
  三平台矩阵也不是摆设：Windows 正是这个插件必须支持的平台，
  `node:path` 上的想当然会在这里露出来。
- **`ui`** 装 Chromium 跑 `test:ui`。
- **`harness`** 装真的 `@deepseek-ai/dsh`，在隔离 `DSH_HOME` 里真启动一次 web profile。

---

## 八、配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
**配置有两层，后者覆盖前者：**

1. **profile 的补丁层**（`cordis.patch.yml`）—— 部署期默认值，进程启动时读一次；
2. **用户设置**（`settings.yaml` 的 `remote-control` 命名空间）—— **改完立即生效，不用重启后端**。

两层都是可选的，字段级覆盖：YAML 里给了 `relayUrl`，设置里只改 `displayName`，
另一个字段继续从 YAML 继承。少了必填项时插件只报一条错误并停止，**不会弄坏 profile**。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `relayUrl` | 必填 | 中转台地址，含子路径、不带尾斜杠 |
| `nodeToken` | 必填 | 中转台的 `DSH_REMOTE_AGENT_TOKEN` |
| `nodeId` | 主机名+家目录的哈希 | 稳定身份；两台机器主机名相同时才需要显式指定 |
| `displayName` | 主机名 | 页面上显示的名字 |
| `workspaces` | `[]` | 允许访问的工作台。三种写法见下节；**列表模式下一律拒绝不在表里的路径** |
| `agentPreset` | `standard` | 远程会话用哪个 agent 预设 |
| `permissionPreset` | `workspace-write` | 固定给远程会话的权限预设 |
| `reconnectMinMs` / `reconnectMaxMs` | `2000` / `60000` | 断线重连退避区间 |
| `enabled` | `true` | 设 `false` 只校验配置并打日志，不连接 |

改用户设置现在可以直接编辑 `settings.yaml`：

```yaml
remote-control:
  displayName: 我的 Windows 本
  workspaces:
    - C:/Users/me/projects
```

保存即生效——插件会拆掉当前节点、用新配置重新登记，无需重启后端
（`tools/settings-check.mjs` 就是端到端验证这件事的）。

中转台的环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_REMOTE_AGENT_TOKEN` | 必填 | 机器侧共享密钥 |
| `DSH_REMOTE_CONTROL_TOKEN` | 必填 | 页面侧共享密钥 |
| `DSH_REMOTE_RELAY_HOST` / `_PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `DSH_REMOTE_POLL_HOLD_MS` | `25000` | 长轮询挂起时长 |
| `DSH_REMOTE_OFFLINE_AFTER_MS` | `45000` | 多久没轮询算离线（离线节点会被拒绝收新命令） |
| `DSH_REMOTE_TRANSCRIPT_LIMIT` | `200` | 每台机器保留多少条对话记录 |

---

## 九、分发

这个仓库同时是**插件包**和**中转台**，刻意合成一个仓、一个包名：

- `dsh plugin add <路径或包名>` 用的是 profile 依赖，`package.json` 里已声明
  `dsh.bundle.patch`，装完重启一次后端即可；
- 中转台是同一个包里 `relay/` 下的独立入口，`npm i -g dsh-remote-control` 之后
  还有 `dsh-remote-relay` 这个 bin，也可以直接 `node relay/server.js`；
- 插件本体**零运行时依赖**：只用 `node:http` / `node:crypto` / `node:os` 这些内置模块，
  `@deepseek-ai/*` 声明为 peerDependency，由正在运行的 Harness 提供。
  CI 会断言这一点，所以它不会悄悄长回来。

### 从 GitHub 装

```sh
dsh plugin --profile web add github:OWNER/dsh-remote-control
# 或者先克隆再按本地路径装：
git clone https://github.com/OWNER/dsh-remote-control ~/src/dsh-remote-control
dsh plugin --profile web add ~/src/dsh-remote-control
```

### 发到 npm

包名 `dsh-remote-control` 目前没有 scope。要发到公共 npm，把 `package.json` 的 `name`
改成你 scope 下的名字（比如 `@you/dsh-remote-control`）再 `npm publish`，
插件安装命令不变，只是路径换成包名：

```sh
npm publish --access public
dsh plugin --profile web add @you/dsh-remote-control
```

本仓已经 `git init` 并有一次提交（分支 `main`），推到远端即可：

```sh
git remote add origin git@github.com:OWNER/dsh-remote-control.git
git push -u origin main
```

---

## 十、授权

MIT。
