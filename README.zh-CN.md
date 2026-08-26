# ReproPilot

[English](README.md) | **简体中文**

ReproPilot 是一个基于 [Pi Coding Agent](https://pi.dev) 的 issue 复现 agent。

给它一个 GitHub issue 链接，它会在对应仓库的本地副本中调查问题、复现行为、创建回归测试，并用实际执行过的命令和测试作为证据。加上 `--fix` 后，它还会尝试修复并验证。

## 适合谁

- 想学习证据驱动 coding agent 如何工作的开发者。
- 想把 issue 转换成可复现测试案例的项目维护者。
- 想先确认 bug，再决定是否修复的开发者。

ReproPilot 在本地运行，不会自动 commit、push 或创建 PR。

## 它会做什么

```text
读取 issue → 分析 → 复现 → 创建失败的回归测试
                              ↓
                 不加 --fix：验证并报告
                 加上 --fix：修复 → 验证 → 报告
```

仅仅阅读代码不能证明问题已复现。ReproPilot 必须获得实际运行命令或测试产生的证据。

## 架构

ReproPilot 是一个由四层组成的 Pi package：

| 路径 | 职责 |
| --- | --- |
| `extensions/repro-workflow/` | 接入 Pi：注册 `/repro`、自定义工具、Session 事件和 TUI 状态 |
| `skills/repro-workflow/` | 告诉模型应该按照什么步骤复现问题 |
| `src/core/` | 不依赖 Pi，负责工作流状态、证据规则、持久化验证和报告生成 |
| `src/github.ts` | 加载并验证 GitHub issue，同时检查当前仓库是否匹配 |

Pi 提供模型循环和内置仓库工具；ReproPilot 只增加 issue 复现流程和由代码强制执行的证据门槛。

## 使用要求

- Node.js 20.19 或更高版本。
- 已配置模型的 Pi Coding Agent。
- issue 所属仓库的本地副本，并具有正确的 GitHub `origin`。
- 目标仓库需要的依赖和本地运行环境。

目标仓库不受编程语言或测试框架限制。

ReproPilot 会在当前仓库中运行命令，也可能创建或修改文件。运行前请检查工作区状态，或者使用单独的分支。

## 快速开始

使用 npm 安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装过程中禁用依赖项生命周期脚本。Pi 在正常的 npm 安装过程中不需要安装脚本。

也可以使用安装程序：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

使用 API 密钥进行身份验证：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

或者使用已有订阅：

```text
pi
/login  # 然后选择提供商
```

然后安装一次 ReproPilot：

```bash
pi install https://github.com/zemple/repro-pilot
```

公开 issue 不需要 GitHub token。对于需要登录才能访问的 issue，请在启动 Pi 前设置 `GITHUB_TOKEN`。

## 运行

先下载或打开 issue 所属仓库：

```bash
git clone https://github.com/OWNER/REPOSITORY.git
cd REPOSITORY
pi
```

请直接正常启动 Pi，不要添加 `--no-skills`：它会禁用 ReproPilot 自己的 workflow skill。ReproPilot 不包含任何无关 skill。

替换其中的大写占位符，然后在 Pi 中运行：

```text
/repro https://github.com/OWNER/REPOSITORY/issues/ISSUE_NUMBER
```

这会复现问题并创建回归测试，但不会修改源代码来修复问题。

如果还希望尝试修复：

```text
/repro https://github.com/OWNER/REPOSITORY/issues/ISSUE_NUMBER --fix
```

issue 所属仓库必须与当前仓库的 GitHub `origin` 一致。两者不匹配时，ReproPilot 会停止，避免修改错误的代码库。

## 查看运行状态

Pi 会显示类似状态：

```text
repro:triage evidence:0 test:not_started fix:not_started
```

- `repro`：当前工作阶段。
- `evidence`：已记录的证据数量。
- `test`：回归测试状态。
- `fix`：修复状态。

| 阶段 | 含义 |
| --- | --- |
| `triage` | 理解 issue，定位相关代码和测试 |
| `reproduce` | 运行代码，比较实际行为与预期行为 |
| `test` | 创建回归测试，并确认它在原始代码上失败 |
| `fix` | 修改源代码，仅在使用 `--fix` 时进入 |
| `verify` | 运行回归测试和相关现有测试 |
| `report` | 生成最终报告 |

`test` 可能是 `not_started`、`failing`、`passing` 或 `blocked`；`fix` 可能是 `not_started` 或 `applied`。

## 查看最终结果

| 结果 | 含义 |
| --- | --- |
| `reproduced` | 问题已复现，回归测试在原始代码上失败，但没有修复源代码 |
| `fixed` | 问题已复现并修复，回归测试和相关现有测试都通过 |
| `not_reproduced` | 已实际尝试复现，但没有观察到 issue 描述的问题 |
| `blocked` | 因信息、依赖或环境不足而无法继续 |

最终报告写入目标仓库：

```text
.repro-pilot/runs/<run-id>/report.md
```

阅读报告时，先看 `Outcome` 和 `Verification`。需要检查结论依据时，再看 `Evidence Details` 中的命令、退出码和相关输出。每条证据使用 `E1`、`E2` 等编号。

## 当前限制

- 只接受 `github.com` 的 issue URL。
- 需要用户提前打开匹配的本地仓库。
- 目标项目的依赖和测试必须能够在本地运行。
- 不提供云端隔离环境，不自动 commit、push 或创建 PR。
