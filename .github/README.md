<div align="center">

<h1>DSH Windows Guard · Windows/macOS 执行守卫</h1>

<p><img src="../docs/images/overview.svg" alt="Windows Shell 预检功能示意，0.4.0 新增 macOS 与批处理支持" width="100%"></p>

<p>核对当前会话的 shell，可靠地处理文件与办公文档。</p>

<p>
  <a href="https://github.com/Missher12/dsh-windows-guard/releases/tag/v0.4.0"><img src="https://img.shields.io/badge/Release-0.4.0-4D6BFE?style=flat-square" alt="Release: 0.4.0"></a>
  <a href="https://github.com/Missher12/dsh-windows-guard"><img src="https://img.shields.io/badge/%E6%96%87%E6%A1%A3-%E4%B8%AD%E6%96%87-4D6BFE?style=flat-square" alt="文档: 中文"></a>
</p>

<p><a href="#功能一览">功能一览</a> · <a href="#快速开始">快速开始</a> · <a href="#详细文档">详细文档</a></p>

</div>

---

<!-- current-source -->
当前源码与安装包：**0.4.0** · [分支 `main`](https://github.com/Missher12/dsh-windows-guard/tree/main) · [Release 与安装包](https://github.com/Missher12/dsh-windows-guard/releases/tag/v0.4.0)。
<!-- /current-source -->

## 功能一览

| 能做什么 | 说明 |
| --- | --- |
| **只读预检** | 在 Windows/macOS 通过当前会话执行器核对 PowerShell 或 Bash。 |
| **工具守卫** | 隐藏已确认不可用的工具，并拒绝沿用旧名称的调用。 |
| **目录核对** | 检查执行器实际目录，避免相邻目录与路径方言错误。 |
| **输出精简** | 满足已证明的边界时折叠重复日志，保留原始输出与退出信息。 |
| **文件批处理** | 预检整批路径、目标冲突与匹配数量，再串行复制、移动、重命名或精确替换文本。 |
| **办公文档** | 读取和编辑 Excel、Word、PPT，合并与拆分 PDF；转换和公式重算使用宿主 Office 运行时。 |

## 快速开始

1. 核对 DSH 0.2.1-rc.4 / 0.2.2-rc.1、Node.js 24.9+ 及批处理所需宿主能力。
2. 从 Release 下载 `.tgz`，按项目说明用 `dsh`（macOS）或 `dsh.cmd`（Windows）更新原插件实例。
3. 新建会话，按当前系统核对执行器和工具状态。原配置与数据保留。

## 使用前了解

- 支持 Windows 和 macOS；Linux 与 WSL 内独立运行的 Linux 版 DSH 会跳过该插件。
- 批处理需要宿主提供 subprocess、沙箱与工作区依赖；预检不会自动安装 shell 或提升权限。

## 详细文档

[项目原说明](../README.md)

原有功能细节、配置、截图与验证记录保留在上述文档中，历史结论按其注明的版本理解。
