# dsh-plugins

DeepSeek Harness 的插件集合。一个仓，多个插件包。

```
packages/
  dsh-codex-bridge/     Codex 生态桥：把 Codex 的 skill 与 MCP server 接进 DSH
  dsh-remote-control/   远程控制：一个公网页面认领并指挥任意多台在线的 DSH
  dsh-git-repos/        多仓库 Git 工具窗：官方右侧栏里的 Rider 式 Git 面板
```

三个包各自独立：**独立安装、独立配置、独立自检**，只是住在同一个仓里。
它们的共同点只有一条——都是 DSH 的 Loader 行，因此 `package.json` 里都声明
`dsh.bundle.patch` 指向自己的 `cordis.patch.yml`，安装方式也完全一致：

```sh
npm i -g pnpm                       # dsh plugin 依赖 pnpm
dsh plugin --profile web add <本仓中该插件目录的路径>
```

装完**重启一次后端**（macOS 外壳：`Harness → 重启后端`，⇧⌘R）。

---

## 安装源：一律 GitHub，不走本地 link

**本地 link 只在开发期用，不要留在配置里。** `link:` 有一个很难察觉的坏处：插件的行为
取决于**这台机器上那个 checkout 当时的内容**，于是「配置文件里写的版本」和「真正跑起来
的代码」不再是同一个东西——同一份 profile 拷到另一台机器上就是另一套行为，而且 `git log`
说不了谎也没用，因为压根没经过版本控制。

所以正式安装一律指 GitHub（三台插件都是同一个仓里的子目录）：

```sh
dsh plugin --profile web add "github:zhAo-byte/dsh-plugins#path:/packages/dsh-remote-control"
dsh plugin --profile web add "github:zhAo-byte/dsh-plugins#path:/packages/dsh-remote-control/client"
dsh plugin --profile web add "github:zhAo-byte/dsh-plugins#path:/packages/dsh-git-repos"
dsh plugin --profile web add "github:zhAo-byte/dsh-plugins#path:/packages/dsh-codex-bridge"
dsh plugin --profile web add "github:zhAo-byte/dsh-plugins#path:/packages/dsh-codex-bridge/client"
```

**`dsh-git-repos` 只有一条**：它的浏览器半边并进了同一个包（`dsh.client` 就声明在里面），
不像另外两个那样有独立的 `-client` 包名。

### 改了代码怎么生效

```
1. 在仓里改 → 提交 → 推到 main
2. dsh plugin --profile web update     # 重新解析 git 源，拉到 main 最新
3. 重启后端（⇧⌘R）
```

第 2 步是必须的：`update` 会把 git 源的 revision 重新指向当时 `main` 的最新提交。不跑它，
profile 就一直用安装那一刻的旧代码——**症状是「代码推上去了，界面没变」**，很容易被误判
成插件没生效。

> `dsh plugin --profile web update` 只刷新 `github:` 源；`link:` 源不受影响。

### 开发期想改一行就看到效果

上面那条流程要「提交 + 推送 + update + 重启」才能看到一行改动，迭代会很慢。开发期可以
临时把某个包换成 link：

```sh
dsh plugin --profile web remove dsh-git-repos
dsh plugin --profile web add ./packages/dsh-git-repos        # 换成 link:
# 改代码 → 重启后端即可，不用提交
# 验完记得改回来：
dsh plugin --profile web remove dsh-git-repos
dsh plugin --profile web add "github:zhAo-byte/dsh-plugins#path:/packages/dsh-git-repos"
```

**只在这台机器上、只在开发期这么做**，而且干完要换回来——理由就是本节第一段。

---

## packages/dsh-codex-bridge

把 Codex 的**知识层**（skills）和**能力层**（MCP server）接进 DSH，
外加一张只读的状态卡片。对 Codex 侧**只读**：不改它的配置、不 spawn 它的二进制、
不碰它的凭据，Codex 始终保持唯一真源。

```sh
dsh plugin --profile web add ./packages/dsh-codex-bridge
# 浏览器半边是独立包名，另需：
ln -sfn "$PWD/packages/dsh-codex-bridge/client" ~/.dsh/profiles/web/node_modules/dsh-codex-bridge-client
```

细节、来源优先级、字段映射、以及 Figma 远程 MCP 为什么走不通，
都写在 [`packages/dsh-codex-bridge/README.md`](packages/dsh-codex-bridge/README.md)。

## packages/dsh-remote-control

让公网上的一个网页认出你所有在线的 Harness（macOS / Windows），
选机器、选工作台、发起问答式对话。由两半组成：

- **node 插件**：装在每台机器上，主动向外拨长轮询，所以在 NAT 后面也能被派活。
  拿到问题后用官方 `ctx.agents` API 在本地开一个**真正的 DSH 会话**，
  固定 `workspace-write + ask` 权限——**中转台和页面都没有审批通道**，
  越界操作会弹在你本机 GUI 里等确认。
- **relay 中转台**：零依赖，一个进程，只做在线表 + 信箱 + 问答页。
  不跑 DSH、不跑模型、不存模型凭据。

**游客模式**（可选，默认关）：给每台机器开一扇 `/guest` 门，进门用**邀请码**（在 Harness 的设置卡片里
一键生成，15 分钟有效、只能用一次，用过的浏览器之后就免输）——
`guestEnabled: true` 之后，拿到链接的人就能用。范围被两道互不信任的检查限死
（只能访问这台机器明确开出来的那几个工作台），身份是**一人一个匿名 id**
（看不到操作者、也看不到别的游客的对话），而且默认跑的是随插件一起安装的
**只读 agent**（`reader`：没有写工具、没有 Shell，权限再钉 `read-only`）。
中转台上还有 `DSH_REMOTE_GUEST=off` 这个总闸，关门不需要任何机器配合。
链接本身就是凭证，代价写得很清楚——见
[`packages/dsh-remote-control/README.md`](packages/dsh-remote-control/README.md) 的五·五。

```sh
dsh plugin --profile web add ./packages/dsh-remote-control
```

架构、信任模型、部署（含 systemd 与 nginx 资产）、自检说明见
[`packages/dsh-remote-control/README.md`](packages/dsh-remote-control/README.md)。

## packages/dsh-git-repos

官方右侧栏里的**多仓库 Git 工具窗**：把一个工作台下的所有仓库列成一棵树，
逐个下钻到变更 / 历史 / 分支 / 远程，并识别 GitLab 托管仓（MR、流水线、深链）。
仓库清单存在本地 SQLite 注册表里，所以打开面板只同步 `git status`、不重扫目录；
新仓库由「更新仓库列表」这个显式动作（`repos.rescan`）发现。
**读写都有**：单仓和批量的抓取 / 拉取 / 推送、暂存 / 提交 / 放弃改动、分支切换与删除、
stash，以及真正的合并与 rebase（含冲突状态、完成 / 放弃）。
单包两半——宿主行提供 `/dsh-git-repos/api/*`，浏览器半边是右侧栏 tab，
手写 bundle、不需要打包器。

```sh
dsh plugin --profile web add ./packages/dsh-git-repos
```

**不要**再手写一行 `id: git-repos` 进 profile 的 `cordis.patch.yml`：
bundle 通道已经带了这一行，重复 id 会让 profile 启动失败。

守卫、配置（含 GitLab 令牌）与四道自检见
[`packages/dsh-git-repos/README.md`](packages/dsh-git-repos/README.md)。

---

## 自检

`dsh-remote-control` 的自检按**真实前提**分成两个入口，而不是按文件名分组：

| 入口 | 需要什么 | 内容 |
| --- | --- | --- |
| `npm test` | **只要 Node** | relay 155 · node 157 · 自带预设安装 35 · 提问接管 12 |
| `npm run test:harness` | 磁盘上有真 Harness | runner 115 · live 48 · 设置 11 · 配置卡片 12 |
| `npm run test:ui` | 一个 Chromium | 问答页 + 游客页 71 |

```sh
cd packages/dsh-remote-control
npm test                 # 任何环境都能跑，CI 三平台跑的就是这条
npm run test:harness     # 驱动真 runner + 隔离 DSH_HOME 里真启动一次 web profile
npm run test:ui          # 真 Chromium 驱动问答页
```

**为什么要按前提拆而不是按名字拆。** `runner-check` 名字上像是个纯单元测试
（它对着假 Harness 驱动 runner），但 `runner` 抽取回复时会调进 Harness
（`createUserMessage` / `SessionSeq`），所以它**必须在有真 Harness 的机器上跑**。
这个前提以前是隐含的：开发机上 `node_modules/@deepseek-ai` 软链让它成立，
一换到 CI 就整片崩红。现在前提被写进了脚本划分里——缺 Harness 时
`runner-check` 和 `live-check` **报告 skip 并干净退出**，而不是假装通过，也不是报错。

CI 见 [`.github/workflows/`](.github/workflows/)：跨 macOS / Windows / Linux 跑 `npm test`，
另有两个 Ubuntu job 分别跑真浏览器和真 Harness。Windows 那一档不是凑数——
`dsh-remote-control` 明确要支持 Windows，而它第一次跑就抓到了一个真实的加载期 bug。

Codex 桥的自检需要真的 `~/.codex`，所以 CI 里只守语法，原因写在 workflow 里：

```sh
cd packages/dsh-codex-bridge
node tools/panel-check.mjs .        # 宿主侧数据层，不需要 GUI
node tools/client-check.mjs         # 端到端：隔离 DSH_HOME 真启动并断言卡片装上了
```

`dsh-git-repos` 的自检按前提从轻到重分四道，前三道只要 Node：

```sh
cd packages/dsh-git-repos
npm run check          # git 引擎（对着真仓库跑）
npm run check:client   # 浏览器半边（假 React+DOM，断言注册与渲染辅助）
npm run check:host     # 宿主路由（真 http server + 两道守卫）
npm run check:gui      # 真 Chromium 打开真 GUI，断言右侧栏面板
```

`check:gui` 需要一个 `playwright-core`（`PLAYWRIGHT_CORE=<dir>`），
其余三道在任何有 git 的机器上都能跑。

`test:harness` 和 `test:ui` 都不碰你正在跑的后端，也不碰 `~/.dsh`：
它们建临时 `DSH_HOME`、退出即删（`DSH_REMOTE_CONTROL_CHECK_KEEP=1` 可留下排查）。

## 开发环境

两个包的 `node_modules/@deepseek-ai` 都是指向**正在运行的那套 Harness**的软链，
让自检可以在仓内直接跑；它们已被 `.gitignore` 排除，不会也不该进版本库。
装到 profile 之后，这些包由 profile 自己作为 peerDependency 提供。

## 授权

MIT，见各包的 `LICENSE`。
