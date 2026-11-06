# dsh-windows-guard

给原生 Windows 上的 DeepSeek Harness（DSH）用的 Cordis 插件。它在模型收到工具清单以前，通过当前会话的 DSH 执行器试运行一条只读命令。已确认无法启动或方言不匹配的标准 `pwsh` / `bash` 会被隐藏。模型沿用旧工具名时，执行守卫也会拒绝调用。已注册的 `read`、`grep`、`glob` 等工具仍可用于完成任务。

## 在 Windows 上安装

插件版本 **0.1.2**，支持 DSH **0.2.1-rc.4** 和 **0.2.2-rc.1**，宿主 Node.js 24.9 或更高。使用桌面版安装包不必单独安装 npm。桌面版先启动一次以初始化 profile，再完全退出 DSH。在 PowerShell 里进入安装包所在的目录，执行下面两行，然后重新打开 DSH 并新建会话。

```powershell
$bundlePath = (Resolve-Path -LiteralPath '.\dsh-windows-guard-0.1.2.tgz').Path
dsh.cmd plugin --profile desktop add "$bundlePath"
```

桌面版的 Windows 命令入口是 `dsh.cmd`。若 PowerShell 找不到它，请先在 DSH 桌面设置中启用命令行入口，再开一个新终端。使用 Web 版时把 `desktop` 换成 `web`，使用该安装提供的 `dsh` 命令。如果从源码安装，在项目根目录先执行 `npm.cmd pack`。卸载命令：`dsh.cmd plugin --profile desktop remove dsh-windows-guard`，然后重启。

## 在你的 Windows 上验收

解压 **`dsh-windows-guard-validation-0.1.2.zip`** 后，在项目目录打开 PowerShell。从 Git 源码运行时，先用 `npm.cmd pack` 生成同目录的插件包。验收需要 Node.js 24.9+、npm 和系统的 `tar.exe`。

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run verify:windows
```

脚本直接加载同目录的插件安装包，打印 Windows 和 Node 版本，然后在临时目录里运行官方 DSH 的 PowerShell 和文件读取工具。它独立执行一条对照命令，分别核对本机直连、只读沙箱和工作区可写沙箱里的实际可用性；再故意配置一个不存在的程序，确认失败调用由 1 变为 0，文件仍读到 `answer=42`。若 PowerShell 可用，还会检查 80 行真实 UTF-8 日志折叠后的模型文本和未经改写的原始输出。沙箱确实无法启动会显示“不可用”，不会被报告为沙箱执行成功。全程不调用模型，不需要 API key，不改变你正在使用的 DSH profile。

可以通过 `DSH_TEST_PWSH` 指定 PowerShell 程序。Windows CI 矩阵覆盖两版受支持的 DSH 以及 PowerShell 5.1 和 7。测试使用相邻的 `project[1]` 和 `project1`，检查默认目录和单次调用的 `workdir`，并验证文件工具能正确读取无 BOM 的 UTF-8 中文内容。严格验收要求本机直连、只读沙箱和工作区可写沙箱均能实际执行。

## 哪些情况会被拦住

| Windows 会话里的实际情况 | 插件行为 |
| --- | --- |
| DSH 提供了 `pwsh`，但程序无法启动、被沙箱拦住、超时，或返回的方言标记不对 | 隐藏该工具及专属提示。工具请求会在原工具执行前被拒绝 |
| PowerShell 实际进入的文件系统目录与 DSH 指定的目录不符，例如 5.1 将 `project[1]` 解析为相邻的 `project1` | 默认目录错位时隐藏 `pwsh`；单次调用指定的其他目录错位时只拒绝该调用。可以用 `read` 继续读取目标文件 |
| Bash 已安装，但 DSH 给 `bash` 实际接上的执行器是 PowerShell | 隐藏 `bash`。只有同一个执行器能返回 Bash 专属标记才保留 |
| PowerShell 5 执行简单命令中的 `&&` 或 `||` | 提示成功分支使用 `if ($?)`，失败分支使用 `if (-not $?)`。在 PowerShell 7 放行 |
| PowerShell 收到以 `grep`、`rg`、`sed`、`awk`、`head`、`jq` 等开头的单行命令 | 预检子进程关闭模块自动加载。若正常命令允许从模块自动加载，未探明的名字交给 PowerShell；只有在裸命令无法自动加载模块且已确认该名字缺失时才拦截 |
| 一个原本可用的 shell 突然报启动错误 | 用只读探测复核。如果执行器确实失效，下一轮就隐藏它。原命令只执行一次 |
| 成功的 shell 输出含大量连续相同行 | 仅在可证明整段文本按指定 V4 分词器会变短时发送一行原文和重复次数。其余输出、退出信息、DSH 的原始结构化值与所有失败输出保留 |

探测继承会话工作目录和沙箱策略。结果按会话缓存，工作目录、沙箱或所选执行器发生变化时重新检查。每次探测都有超时，不调用模型，也不会自动安装 Bash、切换 shell 或申请提权。macOS、Linux 和 WSL 中独立运行的 Linux 版 DSH 会跳过整个插件。

仅超时会在同一环境中按需重试：首次冷却 5 秒，连续超时逐次延长至最多 60 秒，下次有活动时才重新探测。并发回合共享同一次探测。明确的沙箱拒绝保持生效，用户原命令不会被重放。

## 屏蔽自己机器上的其他工具

把 DSH 显示的**完整工具名**加入插件配置的 `denyTools`。例如在当前 profile 的 `cordis.patch.yml` 加入下列覆盖项。将示例名换成自己的工具名并重启。

```yaml
- id: dsh-windows-guard
  config:
    denyTools: [my_linux_only_tool]
    probeTimeoutMs: 5000
    compactOutput: true
```

启动较慢时可把 `probeTimeoutMs` 调至 30000。填入未注册的工具名也有效，之后加载的同名工具会被拦截。禁用规则针对确切名称。PTC 的 `run_code` 是公共入口，应填写它调用的具体工具名。

**覆盖边界。** 自动探测覆盖 DSH 的标准单次 shell 工具，包括 Standard、Cordis 和 PTC 预设继承的工具。Minimal 的持久终端、自带执行器的第三方工具，以及配置了多个隔离执行器且无法确认绑定关系的预设，可用 `denyTools` 指定。两个受支持版本的标准 Native 工具清单和 PTC 生成的 SDK 均屏蔽禁用工具，包括 agent 自身注册的同名工具；旧名称也不能绕过执行守卫。探测只能证明当时的执行器和已检查命令可用。文件锁、权限变化、用户命令自身的错误仍可能导致失败。更换同名程序或安装命令行软件后，重开会话即可刷新探测。

## 实测

在 DSH 0.2.2-rc.1 的真实 Cordis 注册表、提示组装器、官方 shell 工具及 Native 执行管线里，分别关闭和开启本插件，运行相同的脚本化选择策略。文件内容和 Windows 执行器响应由测试夹具提供。每个样例统计一次工具说明、工具清单和实际返回给模型的工具文本，以 DeepSeek 官方 V4 分词器计数。测试不请求模型 API。

| 固定任务 | 关闭插件 | 开启插件 | 失败调用 | 开启后的本地探测 |
| --- | ---: | ---: | ---: | ---: |
| PowerShell 启动失败，仍需读出 `answer=42` | 868 tokens | 40 tokens | 1 → 0 | 1 |
| 读取含 80 行相同进度的构建日志，确认 `BUILD OK` | 1,659 tokens | 851 tokens | 0 → 0 | 1 |
| PowerShell 可用，只读短文件 | 859 tokens | 830 tokens | 0 → 0 | 1 |

这些数值只衡量上述输入片段。完整会话还包含用户消息、历史、模型输出和缓存，实际节省量取决于工作负载。计数所用 `tokenizer.json` 的 SHA-256 为 `89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614`。[DeepSeek 官方分词器](https://api-docs.deepseek.com/quick_start/token_usage/)

日志折叠有单独的保证：对上面指定的 V4 词表，候选文本的 UTF-8 字节数是其 token 数的上界。原文每个 token 最多覆盖 128 字节，也最多覆盖一个由 ASCII 空白分隔、且包含非不换行空格内容的片段。插件仅在原文的这两个下界之一严格大于候选上界时才改写，否则原样发送。例如四行长分隔符原本只用 9 个 token，替换说明会用 12 个，插件会保留原文。`scripts/verify_v4.py` 可对官方词表逐项重验，无需把词表装进插件。

### 复现

```powershell
npm ci
npm test
npm run bench
```

`npm run bench` 显示调用次数、失败次数、探测次数和字符数。要复现 token 数，解压官方分词器并运行以下命令。

```powershell
py -m pip install tokenizers
py scripts/count_tokens.py 'C:\path\to\tokenizer.json'
```

要对真实 PowerShell 和磁盘文件计数，在最后一条命令末尾加 `--native`。真实样例中的临时路径不同，数字可能略有变化。固定样例适合复核上表；本机验收适合验证实际执行环境。

Windows 测试会实际启动 Windows PowerShell 5.1、PowerShell 7 和 Git Bash，要求测试机装有三者。日常使用只探测 DSH 已提供的标准 shell 工具。仓库提供 `windows-latest` 工作流。本地 macOS 可用 `DSH_TEST_PWSH` 指定 PowerShell 7 的路径来运行真实进程测试。

## 参考项目

- **dsh-ops** 提供原生文件工具、Windows Bash 和 PTC。这个插件借鉴它按会话治理工具的做法，可以独立安装。[T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)
- **Codex** 的 PowerShell 探测会实际启动候选程序。Windows 上存在 PATH 能找到程序但宿主启动失败的案例。[PowerShell 源码](https://github.com/openai/codex/blob/main/codex-rs/shell-command/src/powershell.rs) · [故障记录](https://github.com/openai/codex/issues/18937)
- **Claude Code** 按 Git for Windows 的可用性选择 Bash 或 PowerShell。这里进一步验证 DSH 实际绑定的执行器，避免假设两个工具共享相同的 Windows 环境。[Windows 安装说明](https://code.claude.com/docs/en/setup#install-on-native-windows)
- DSH 的工具注册表负责按 scope 限制可见工具，并在执行前应用守卫。PowerShell 的管道链运算符从 7 开始支持。[DSH 工具注册表](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/core/tools/src/index.ts) · [Microsoft PowerShell 文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pipeline_chain_operators)
