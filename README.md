# ReproPilot

ReproPilot 是一个基于 [Pi Coding Agent](https://pi.dev) 的 issue 复现 agent。

给它一个 GitHub issue，它会在对应仓库的本地副本中查找相关代码、运行复现步骤、创建回归测试，并用实际执行结果说明问题是否存在。加上 `--fix` 后，它还会尝试修复并验证。

## 适合谁

- 想学习一个完整 agent 工作流如何实现的开发者。
- 想把 GitHub issue 转换成可执行复现证据的项目维护者。
- 想先确认 bug 和回归测试，再决定是否修复的开发者。

当前 MVP 主要面向使用 TypeScript 和 Vitest 的项目。它不是云端服务，也不会自动提交代码或创建 PR。

## 它会做什么

```text
读取 issue → 定位相关代码 → 复现问题 → 创建失败的回归测试
                                      ↓
                    不修复：验证并报告复现结果
                    --fix：修复 → 运行测试 → 报告结果
```

ReproPilot 只把实际运行过的命令和测试当作证据。仅仅阅读代码不能算成功复现。

## 使用前准备

你需要：

- Node.js 20.19 或更高版本。
- 已安装并配置好模型的 Pi Coding Agent。
- issue 所属仓库的本地副本，并且仓库具有正确的 GitHub `origin`。

ReproPilot 不会自动下载目标仓库。所有命令和代码修改都发生在你的本地仓库中，建议先确认工作区状态或使用单独的测试分支。

## 安装

先安装 Pi：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

也可以使用 npm：

```bash
npm install -g @earendil-works/pi-coding-agent
```

第一次运行 `pi` 时，用 `/login` 登录模型提供商。

然后安装 ReproPilot：

```bash
pi install https://github.com/zemple/repro-pilot
```

这是一次性安装。安装后可以在不同的目标仓库中使用。

公开 issue 不需要 GitHub token。访问私有仓库的 issue 时，可以设置：

```bash
export GITHUB_TOKEN=你的_token
```

## 运行

先进入 **issue 所属仓库**，再启动 Pi：

```bash
git clone https://github.com/unjs/ufo.git
cd ufo
pi
```

在 Pi 中运行：

```text
/repro https://github.com/unjs/ufo/issues/148
```

这会复现问题并创建回归测试，但不会修改源代码来修复问题。

如果希望同时尝试修复：

```text
/repro https://github.com/unjs/ufo/issues/148 --fix
```

issue URL 所属仓库必须与当前目录的 GitHub `origin` 一致。否则 ReproPilot 会停止，避免操作错误的代码库。

## 怎么看运行状态

Pi 界面会显示类似状态：

```text
repro:triage evidence:0 test:not_started fix:not_started
```

- `repro`：当前阶段。
- `evidence`：已经记录的证据数量。
- `test`：回归测试状态。
- `fix`：修复状态。

阶段依次为：

| 阶段 | 含义 |
| --- | --- |
| `triage` | 理解 issue，定位相关代码和测试 |
| `reproduce` | 运行代码，比较实际行为与预期行为 |
| `test` | 创建回归测试，并确认它在原始代码上失败 |
| `fix` | 修改源代码，仅在使用 `--fix` 时进入 |
| `verify` | 重新运行回归测试和相关现有测试 |
| `report` | 生成最终报告 |

`test` 可能是 `not_started`、`failing`、`passing` 或 `blocked`；`fix` 可能是 `not_started` 或 `applied`。

## 怎么看最终结果

一次运行最终会得到以下结果之一：

| 结果 | 含义 |
| --- | --- |
| `reproduced` | 问题已复现，回归测试在原始代码上失败，但没有修复源代码 |
| `fixed` | 问题已复现并修复，回归测试和相关现有测试都通过 |
| `not_reproduced` | 已实际尝试，但没有观察到 issue 描述的问题 |
| `blocked` | 因环境、依赖或信息不足而无法继续 |

最终报告写入目标仓库：

```text
.repro-pilot/runs/<run-id>/report.md
```

报告包含：

- issue 和最终结果。
- 实际执行的复现命令及其输出。
- 回归测试在修复前是否失败。
- 修改了什么（如果请求修复）。
- 回归测试和现有测试的验证结果。

每条证据都有 `E1`、`E2` 这样的编号，并记录命令、退出码和相关输出。判断结果时优先查看最终 `Outcome` 和 `Verification`，需要追查细节时再查看 `Evidence Details`。

## 当前限制

- 只接受 `github.com` 的 issue URL。
- 需要用户提前下载并进入 issue 对应仓库。
- 当前主要支持 TypeScript 和 Vitest 项目。
- 不提供云端隔离环境，不自动 commit、push 或创建 PR。

## 本地开发

```bash
npm install
npm test
npm run typecheck
npm run check
```
