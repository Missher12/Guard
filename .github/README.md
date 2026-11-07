<div align="center">

<h1>DSH Windows Guard · Windows 执行守卫</h1>

<p><img src="../docs/images/overview.svg" alt="Windows Guard 功能示意" width="100%"></p>

<p>先确认当前 Windows shell 能用，再把可用工具交给模型。</p>

<p>
  <a href="https://github.com/Missher12/dsh-windows-guard/blob/main/package.json"><img src="https://img.shields.io/badge/%E6%BA%90%E7%A0%81%E7%89%88%E6%9C%AC-0.1.4-4D6BFE?style=flat-square" alt="源码版本: 0.1.4"></a>
  <a href="https://github.com/Missher12/dsh-windows-guard"><img src="https://img.shields.io/badge/%E6%96%87%E6%A1%A3-%E4%B8%AD%E6%96%87-4D6BFE?style=flat-square" alt="文档: 中文"></a>
</p>

<p><a href="#功能一览">功能一览</a> · <a href="#快速开始">快速开始</a> · <a href="#详细文档">详细文档</a></p>

</div>

---

<!-- current-source -->
当前开发源码：**0.1.4** · [分支 `main`](https://github.com/Missher12/dsh-windows-guard/tree/main)。安装包以实际 Release 为准。
<!-- /current-source -->

## 功能一览

| 能做什么 | 说明 |
| --- | --- |
| **只读预检** | 通过会话执行器探测标准 PowerShell 与 Bash。 |
| **工具守卫** | 隐藏已确认不可用的工具，并拒绝沿用旧名称的调用。 |
| **目录核对** | 检查执行器实际目录，避免相邻目录与路径方言错误。 |
| **输出精简** | 满足已证明的边界时折叠重复日志，保留原始输出与退出信息。 |

## 快速开始

1. 核对下方支持的 DSH 与 Node.js 版本，准备本地 .tgz；源码可用 npm.cmd pack 打包。
2. 正常退出目标 DSH，按下方 Windows 安装说明用 dsh.cmd 安装到实际 profile。
3. 重新打开 DSH 并新建会话，按自己的 Windows 环境核对执行器状态。

## 使用前了解

- macOS、Linux 和 WSL 内的 Linux 版 DSH 跳过该插件；预检不会自动安装 shell 或提升权限。

## 详细文档

[项目原说明](../README.md)

原有功能细节、配置、截图与验证记录保留在上述文档中，历史结论按其注明的版本理解。
