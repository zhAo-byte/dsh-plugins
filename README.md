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

```sh
dsh plugin --profile web add ./packages/dsh-remote-control
```

架构、信任模型、部署（含 systemd 与 nginx 资产）、自检说明见
[`packages/dsh-remote-control/README.md`](packages/dsh-remote-control/README.md)。

## packages/dsh-git-repos

官方右侧栏里的**多仓库 Git 工具窗**：把一个工作台下的所有仓库列成一棵树，
逐个下钻到变更 / 历史 / 分支 / 远程，并识别 GitLab 托管仓（MR、流水线、深链）。
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
| `npm test` | **只要 Node** | relay 41 · node 50 |
| `npm run test:harness` | 磁盘上有真 Harness | runner 51 · live 21 |
| `npm run test:ui` | 一个 Chromium | 问答页 21 |

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
