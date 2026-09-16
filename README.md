# dsh-plugins

DeepSeek Harness 的插件集合。一个仓，多个插件包。

```
packages/
  dsh-codex-bridge/     Codex 生态桥：把 Codex 的 skill 与 MCP server 接进 DSH
  dsh-remote-control/   远程控制：一个公网页面认领并指挥任意多台在线的 DSH
```

两个包各自独立：**独立安装、独立配置、独立自检**，只是住在同一个仓里。
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

---

## 自检

每个包都自带零依赖的自检，且都能在**本仓原地**跑通。

```sh
# 远程控制：5 套，共 182 项
cd packages/dsh-remote-control
npm test                 # relay 41 / node 48 / runner 51
npm run test:live        # 隔离 DSH_HOME 里真启动一次 web profile（21）
npm run test:ui          # 真 Chromium 驱动问答页（21，需要浏览器）

# Codex 桥
cd packages/dsh-codex-bridge
node tools/panel-check.mjs .        # 宿主侧数据层，不需要 GUI
node tools/client-check.mjs         # 端到端：隔离 DSH_HOME 真启动并断言卡片装上了
```

`npm run test:live` 和 `test:ui` 都不碰你正在跑的后端，也不碰 `~/.dsh`：
它们建临时 `DSH_HOME`、退出即删（`*_CHECK_KEEP=1` 可留下排查）。

CI 见 [`.github/workflows/`](.github/workflows/)：跨 macOS / Windows / Linux 跑两个包的自检。
Windows 那一档不是凑数——`dsh-remote-control` 明确要支持 Windows。

## 开发环境

两个包的 `node_modules/@deepseek-ai` 都是指向**正在运行的那套 Harness**的软链，
让自检可以在仓内直接跑；它们已被 `.gitignore` 排除，不会也不该进版本库。
装到 profile 之后，这些包由 profile 自己作为 peerDependency 提供。

## 授权

MIT，见各包的 `LICENSE`。
