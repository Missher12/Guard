# Guard 0.4.0

![Guard · 执行守卫（品牌插画）](docs/images/cover-v2.png)

同一个 Cordis 插件支持 **Windows 和 macOS**：验证当前 DSH shell、隐藏不可用工具、精简成功输出，并提供可靠的批量文件与办公文档操作。安装标识仍为 `dsh-windows-guard`，原 ID 和配置继续使用。

## 安装

支持 DSH **0.2.1-rc.4 / 0.2.2-rc.1**，Node **24.9+**。批处理需要当前会话提供 `subprocess`、沙箱策略及 `load_workspace_dependencies`；桌面版自带的 Python/Office 运行时可直接使用。PDF 读写库随插件附带，不修改全局 Python。转换和公式重算使用宿主 Office skills 配置的 LibreOffice Kit。

下载或本地生成 `dsh-windows-guard-0.4.0.tgz`。先退出 DSH，再在安装包目录执行：

macOS：

```sh
dsh plugin --profile desktop add ./dsh-windows-guard-0.4.0.tgz
```

Windows PowerShell：

```powershell
$bundlePath = (Resolve-Path -LiteralPath '.\dsh-windows-guard-0.4.0.tgz').Path
dsh.cmd plugin --profile desktop add "$bundlePath"
```

重新打开 DSH 并新建会话。如果找不到 `dsh` / `dsh.cmd`，先在桌面设置中启用命令行入口。Web 用户将 profile 改为 `web`。更新原实例不会迁移或删除用户设置、会话、文件及办公库。

## Shell 行为

- 通过当前会话实际绑定的执行器运行有超时的只读探测，继承工作目录与沙箱策略；失败工具从 Native/PTC 清单移除，旧名称也不能绕过执行守卫。
- Windows 保留 PowerShell 方言、版本、工作目录及已确认缺失命令检查。
- macOS 根据实际 Bash 版本给出兼容提示，提示查询命令位置及 GNU/BSD 参数差异，不假定登录 shell、Homebrew 或 PowerShell 已存在。
- 只折叠可证明更短的成功重复输出，原始结构化 stdout/stderr 保留。原有超时退避与会话缓存继续生效。
- Linux/WSL 中独立运行的 Linux 版 DSH 仍跳过本插件。持久终端和独立第三方执行器不冒充标准 shell 验证对象。

## 批量文件：`guard_file_batch`

支持明确列出的普通文件：复制、同磁盘移动/重命名、UTF-8 精确替换。路径相对当前会话目录，也可传入该目录内的绝对路径。目标目录会按需创建。

```json
{
  "action": "run",
  "operations": [
    { "kind": "copy", "source": "资料/说明.txt", "destination": "归档/说明.txt" },
    { "kind": "rename", "source": "旧名称.txt", "destination": "新名称.txt" },
    { "kind": "replace_text", "source": "记录.txt", "edits": [
      { "oldText": "待处理", "newText": "已处理", "count": 3 }
    ] }
  ]
}
```

整批先检查路径、目标冲突与文本匹配数量，再串行修改。已存在的目标不覆盖。重叠、相互依赖、仅大小写/Unicode 拼写不同的目标应拆成明确的顺序批次。同一文件的多处文本修改放在一项 `edits` 中，按数组顺序匹配。二进制文件不能作为文本替换，UTF-8 BOM 和换行保持原样。

默认 `onError: "stop"`，失败后停止后续写入。独立项目可显式使用 `onError: "continue"`；效果不确定仍会停止。每批最多 100 项，单文件/输出最多 64 MiB，请求最多 2 MiB，宿主调用最长 120 秒。跨磁盘移动会在执行前拒绝；可先复制并核对，再单独处理源文件。

## 办公文档：`guard_office_batch`

| action | 格式与行为 |
| --- | --- |
| `inspect` | 识别 xlsx/docx/pptx/pdf，说明复杂对象或不支持的格式 |
| `read` | Excel 指定表与行、Word 段落/表格文本、PPT 页及对象、PDF 文本与页码；按 `offset`/`limit` 分页 |
| `edit` | Excel 单元格/字段；Word 字段、精确替换、表格单元格；PPT 字段、精确替换、图片 |
| `merge` | Excel 按明确键合并选定数据表，或按输入顺序合并 PDF |
| `split` | 按明确页码选择 PDF 页面，每个输出单独列出 |
| `export_pdf` | 用宿主引擎将 xlsx/docx/pptx 转为 PDF |
| `recalculate` | 用宿主引擎重算 xlsx 公式并检查结果 |

默认输出到会话目录的 `guard-output/`，保持原件。用每项 `output` 或顶层 `output` 指定位置，目标不能已经存在。只有用户已明确要求覆盖时才使用 `overwrite: true`；这仅覆盖源文件本身，不覆盖其他已有文件。

不同格式可以在一次 `edit` 批次中分别提供参数：

```json
{
  "action": "edit",
  "files": [
    { "path": "统计.xlsx", "parameters": {
      "cells": [{ "sheet": "统计", "cell": "B2", "value": 42 }]
    } },
    { "path": "通知.docx", "parameters": {
      "fields": { "姓名": "张三" },
      "tables": [{ "table": 1, "row": 2, "column": 1, "value": "已确认" }]
    } },
    { "path": "演示.pptx", "parameters": {
      "fields": { "标题": "月度进展" },
      "pictures": [{ "slide": 1, "shape": 3, "image": "新图.png" }]
    } }
  ]
}
```

`fields` 替换 `{{姓名}}` 这样的模板占位符，字段必须存在。`replacements` 使用 `{oldText,newText,count}`，必须符合预期匹配数量。Word 普通文本替换保留未修改 run 的格式；模板字段跨 run 时，替换内容沿用起始 run 的样式。表格、幻灯片、对象及 PDF 页码从 1 开始；读取分页 `offset` 从 0 开始，`limit` 为 1–100。

Excel 合并要求所有选定表的表头一致：

```json
{
  "action": "merge",
  "files": [{ "path": "一组.xlsx" }, { "path": "二组.xlsx" }],
  "output": "汇总.xlsx",
  "parameters": { "sheet": "数据", "key": "编号", "duplicate": "error" }
}
```

重复键默认报错，也可明确选择 `first` 或 `last`。合并选定表，第一本工作簿作为模板；其他工作簿的其他工作表不被合入。普通行内公式随移动行调整引用，跨行、跨表、固定行、动态引用公式及复杂表对象需要单独处理。单元格的数据类型与样式分别复制，普通文本不会因以 `=` 开头而变成公式。合并的参数和输出位置放在顶层。

PDF 拆分允许同一原件产生多个明确输出：

```json
{
  "action": "split",
  "files": [
    { "path": "总文档.pdf", "output": "第一部分.pdf", "parameters": { "pages": [1, 2] } },
    { "path": "总文档.pdf", "output": "第二部分.pdf", "parameters": { "pages": [3, 4] } }
  ]
}
```

## 结果与续做

结果必须检查 `status`、`counts` 与各项 `status`：

- `completed`：本批全部完成；`skipped`：已确认内容没有变化。
- `failed`：该项失败；`pending`：尚未处理。
- `uncertain`：可能产生了效果，先核对目标；不会盲目重放。
- 批次 `partial` 表示尚未完整完成，不能报告全部成功。

中断、超时或响应丢失后，先用原工具查询：

```json
{ "action": "list" }
```

从结果取得 ID，再查看或继续：

```json
{ "action": "status", "id": "原批次ID" }
```

```json
{ "action": "resume", "id": "原批次ID" }
```

`list` 每页 20 个批次，可用返回的 `nextOffset` 继续。`resume` 只能使用原会话、原目录、原工具和原操作；已完成项不重放。源文件发生变化会拒绝继续修改。未确认项只有核对到原输出才标记完成，否则保留 `uncertain` 并停止。

最小执行记录存放在工作区 `.dsh-guard/`，包含路径、操作参数和逐文件状态，不复制整份源文档；替换/填充文本可能存在参数中。请把该目录加入工作区 Git 忽略。记录用于本地续做，不是防篡改保险箱；外部进程任意篡改文件或记录不在保证范围内。

## 保留边界

- 修改先准备完整输出、重新打开校验，再发布到目标。单文件完整写入不等于整批文件具备全有或全无的事务保证。
- 守卫继承 DSH 权限、沙箱、取消与宿主工具限制；缺少执行器或运行时就说明原因，不自行安装软件、放宽权限或切换到无沙箱。
- 普通复制保留文件内容与权限位；不承诺复制所有 ACL、扩展属性或资源叉。只支持普通文件，不递归处理目录，不经过符号链接/目录联接。
- 旧 Office 格式、宏、加密、签名、嵌入对象、复杂图表与外部链接等需要适用的独立工作流，不默认覆盖。
- 写入公式不是重算。`formulaRecalculated` 单独报告；`visualChecked: false` 表示尚未检查外观。外观修改应再用宿主 `office-render` 查看相关页面。
- PDF 无文本页可能是扫描件或空白页，本版不执行 OCR。读取结果的 `complete`/`nextOffset` 说明当前范围是否已读完。
- 这些保证覆盖受管批处理入口；不能仅凭提示词为任意自写 shell/Python 脚本提供相同保证。

## 配置

原有配置继续有效，`denyTools` 可包含两个新增工具的完整名称：

```yaml
- id: dsh-windows-guard
  config:
    denyTools: []
    probeTimeoutMs: 5000
    compactOutput: true
```

## 开发验证

```sh
npm ci
python -m pip install -r test/requirements.txt
npm test
npm pack
npm run verify:macos
```

`DSH_TEST_PYTHON` 可指定测试解释器，`DSH_TEST_OFFICE_CLI` 可指定已安装的官方 CLI。Mac 默认使用已安装 DSH 的运行时；Windows 的 shell 专项可运行 `npm run verify:windows`。原有 Windows CI 增加了办公测试所需的 Python 依赖。

验证使用真实临时文件和官方 DSH 工具管线，不调用模型 API。真实 OS 沙箱、Windows 专项和安装结果必须分别说明，不能用模拟执行器代替真机验收。0.1.x 的 token 对照不代表增加批处理工具后的 0.4.0，历史说明见 [Windows 0.1.4](docs/windows-0.1.4.md)。

PDF 库的来源与许可证见 [vendor 说明](src/office/vendor/README.md)。
