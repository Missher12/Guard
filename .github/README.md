<div align="center">

<h1>Guard · Windows/macOS 执行守卫</h1>

<p><img src="../docs/images/cover-v2.png" alt="Guard · 执行守卫（品牌插画）" width="100%"></p>

<p>减少 Token 与不可用工具调用，提高 Windows/macOS 工作效率，减少重复失败。</p>

<p>
  <a href="https://github.com/Missher12/Guard/releases/tag/v0.5.0"><img src="https://img.shields.io/badge/Release-0.5.0-4D6BFE?style=flat-square" alt="Release: 0.5.0"></a>
  <a href="https://github.com/Missher12/Guard"><img src="https://img.shields.io/badge/%E6%96%87%E6%A1%A3-%E4%B8%AD%E6%96%87-4D6BFE?style=flat-square" alt="文档: 中文"></a>
</p>

<p><a href="#功能一览">功能一览</a> · <a href="#快速开始">快速开始</a> · <a href="#visual-guide">图解使用</a> · <a href="#使用场景">使用场景</a> · <a href="#常见问题">常见问题</a> · <a href="#详细文档">详细文档</a></p>

</div>

---

<!-- current-source -->
当前源码与安装包：**0.5.0** · [分支 `main`](https://github.com/Missher12/Guard/tree/main) · [Release 与安装包](https://github.com/Missher12/Guard/releases/tag/v0.5.0)。
<!-- /current-source -->

## 功能一览

| 能做什么 | 说明 |
| --- | --- |
| **只读预检** | 在 Windows/macOS 通过当前会话执行器核对 PowerShell 或 Bash。 |
| **工具守卫** | 隐藏已确认不可用的工具，并拒绝沿用旧名称的调用。 |
| **断连避让** | MCP 明确断连后暂时移出候选，避免反复调用；连接更新或冷却结束后恢复，不自动重放。 |
| **依赖过滤** | 缺少可用工作区运行时时，隐藏依赖它的批处理工具。 |
| **目录核对** | 检查执行器实际目录，避免相邻目录与路径方言错误。 |
| **输出精简** | 折叠重复多行日志，精简一致成功的批次回执，保留原始结果和完整状态查询。 |
| **文件批处理** | 预检整批路径、目标冲突与匹配数量，再串行复制、移动、重命名或精确替换文本。 |
| **办公文档** | 读取和编辑 Excel、Word、PPT，合并与拆分 PDF；转换和公式重算使用宿主 Office 运行时。 |

## 快速开始

1. 核对 DSH 0.2.1-rc.4 / 0.2.2-rc.1、Node.js 24.9+ 及批处理所需宿主能力。
2. 从 Release 下载 `.tgz`，按项目说明用 `dsh`（macOS）或 `dsh.cmd`（Windows）更新原插件实例。
3. 新建会话，按当前系统核对执行器和工具状态。原配置与数据保留。

<!-- visual-guide -->
<a id="visual-guide"></a>

## 图解使用流程

先确认真实执行器和目录，再按顺序操作文件，最后逐项核对结果。

![Guard：三个关键场景的操作插画](../docs/images/usage-story.png)

<sub>场景插画：帮助理解用途与操作顺序，不是 DSH 界面截图。</sub>

![Guard：四步使用流程](../docs/images/workflow-guide.svg)

[查看完整流程图](../docs/images/workflow-guide.svg)

| 步骤 | 怎样操作 | 需要留意 |
| --- | --- | --- |
| 1. 确认环境 | 读取当前会话的实际执行器、工作目录与命令方言。 | Windows 与 macOS 支持运行，Linux 宿主跳过；不凭文件路径猜测执行器。 |
| 2. 核对输入 | 列出要操作的普通文件、输出位置及依赖。 | 目标已存在时先报告冲突；默认保留原件，不把批处理当成自动回滚事务。 |
| 3. 顺序执行 | 按明确清单复制、移动、重命名或替换 UTF-8 文本，办公文件使用对应宿主能力。 | 逐项保留结果；参数、权限或业务错误与连接断开分别处理。 |
| 4. 检查回执 | 查看成功、失败、部分完成和产物位置。 | 重复成功输出可压缩显示，完整结构化结果仍可查看；失败细节不压掉。 |

### 试一次

> 把明确列出的 3 份报告复制到指定输出目录，保留原件。目标已存在时不要覆盖，完成后逐项列出实际路径、失败项和未解决的问题。

使用后可以这样核对：

- 预检使用当前会话真实 shell，路径与平台匹配。
- 已有目标冲突没有被静默覆盖，失败文件没有写成成功。
- 连接断开的工具可临时冷却；恢复候选后也不会自动重放之前操作。

### 使用与配置

| 项目 | 建议 |
| --- | --- |
| 平台与身份 | GitHub 名称为 Guard，内部包名与 ID 继续使用 dsh-windows-guard，原配置沿用。 |
| 工具可用性 | 已确认不可用的工具暂不展示；缺失运行时不会自动伪造工具能力。 |
| 文档与批次 | Office 处理依赖宿主对应运行时；逐项结果比单个“完成”提示更可靠。 |

Guard 提供执行前检查、工具可用性处理和结果整理。它不自动安装依赖或提升权限，也不承诺所有文件操作都能作为事务撤销。
<!-- /visual-guide -->

## 使用前了解

- 支持 Windows 和 macOS；Linux 与 WSL 内独立运行的 Linux 版 DSH 会跳过该插件。
- 批处理需要宿主提供 subprocess、沙箱与工作区依赖；预检不会自动安装 shell 或提升权限。

<!-- readme-expansion -->
## 使用场景

| 遇到的情况 | 怎样使用 |
| --- | --- |
| 命令在 Windows 和 macOS 上经常因为方言不同而失败 | 先使用当前会话真实绑定的执行器做只读预检，再选择可用工具。 |
| 需要复制、重命名或精确替换一批明确文件 | 整批检查路径、冲突与匹配数量，再按顺序执行文件操作。 |
| 想在一个任务中处理表格、文稿、演示文档和 PDF | 按宿主能力读取、编辑、合并、拆分、导出 PDF 或重算公式，默认保留原件。 |

## 常见问题

<details>
<summary>Guard 支持哪些系统？</summary>

0.5.0 同时支持 Windows 与 macOS；安装标识仍为 `dsh-windows-guard`，已有配置继续使用。Linux 和 WSL 中单独运行的 Linux DSH 会跳过本插件。

</details>

<details>
<summary>发现缺少 shell 或 Office 能力，会自动安装或提权吗？</summary>

不会。插件依据当前执行器与宿主依赖判断可用能力，不自动安装 shell，也不自行扩大权限。

</details>

<details>
<summary>一批操作中途失败，会自动撤销前面的修改吗？</summary>

不要按这个假设使用。默认失败后停止后续写入；应根据逐项回执核对已完成操作和剩余项，预检也不等于整批事务回滚。

</details>

<details>
<summary>办公文件会直接覆盖原件吗？</summary>

默认输出到单独的 guard-output 或指定位置并保留原件。只有明确要求覆盖时才使用对应选项，现有目标冲突仍需处理。

</details>

## 搭配使用

配合 [Project Ops](https://github.com/Missher12/Missher-DSH-Project-Ops) 预览和定位输出文件，配合 [Focus](https://github.com/Missher12/Missher-DSH-Focus) 核对任务结果；执行权限仍由宿主决定。

## 升级与数据

升级原插件实例，不迁移或清空个人文件和配置。格式转换、复杂对象与公式结果受宿主 Office 运行时及格式支持影响，输出仍应按用途检查。
<!-- /readme-expansion -->

## 详细文档

[项目原说明](../README.md)

原有功能细节、配置、截图与验证记录保留在上述文档中，历史结论按其注明的版本理解。
