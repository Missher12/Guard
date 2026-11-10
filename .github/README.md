<div align="center">

<h1>Guard · Windows/macOS 执行守卫</h1>

<p><img src="../docs/images/cover-v2.png" alt="Guard · 执行守卫（品牌插画）" width="100%"></p>

<p>减少 Token 与不可用工具调用，提高 Windows/macOS 工作效率，减少重复失败。</p>

<p>
  <a href="https://github.com/Missher12/Guard/releases/tag/v0.5.0"><img src="https://img.shields.io/badge/Release-0.5.0-4D6BFE?style=flat-square" alt="Release: 0.5.0"></a>
  <a href="https://github.com/Missher12/Guard"><img src="https://img.shields.io/badge/%E6%96%87%E6%A1%A3-%E4%B8%AD%E6%96%87-4D6BFE?style=flat-square" alt="文档: 中文"></a>
</p>

<p><a href="#功能一览">功能一览</a> · <a href="#快速开始">快速开始</a> · <a href="#使用场景">使用场景</a> · <a href="#常见问题">常见问题</a> · <a href="#详细文档">详细文档</a></p>

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

## 第一次使用

1. 安装后新建会话，确认系统、实际 shell、工作目录与宿主依赖。
2. 给出明确输入文件、操作规则和输出目录，让 Agent 按规则预检。
3. 完成后检查逐项结果、输出文件和失败原因；文档转换或公式重算还需核对实际内容。

### 一个具体例子

“把当前项目中我列出的 3 个文本文件复制到归档目录，并按给出的名称重命名。先检查源文件、目标冲突和工作目录；已有目标不要覆盖，完成后列出逐项结果。”

办公任务也应写清工作表、单元格、页码或要替换的准确文字，避免用模糊范围修改文件。

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
