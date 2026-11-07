# Windows / macOS 文件与办公处理升级计划

**Goal:** 在同一个 `dsh-windows-guard` 插件中支持 Windows 和 macOS，并优先让批量文件修改准确、可追踪、可继续，再增强办公文档工作流。

**Architecture:** 保留现有 shell 守卫；增加一个执行明确操作列表的批处理入口，沿用 DSH 会话权限、执行器、取消与任务展示。办公处理通过格式适配器复用宿主 Office skills、Python 库和 LibreOffice Kit，使用同一套逐文件结果规则。

**Tech Stack:** 现有 JavaScript ESM、Cordis、DSH 工具/沙箱服务、Node 测试；办公处理使用宿主提供的 Python 与库。新增运行依赖需由具体操作证明必要。

**Spec:** 本文依据本次已确认范围：原插件同时支持 Windows 和 Mac；文件整理与办公文档两类都需要；先保证批量修改可靠。已按用户后续授权直接实施至 0.4.0；以下保留阶段划分并记录最终实现。

执行方式：当前会话自行实施；遵守用户禁止主动创建子代理的规则。交付源码与可安装包，不自动提交、推送、发布或修改日常 DSH profile。

## 已核实的基础

- GitHub 仓库：`Missher12/dsh-windows-guard`，升级基线包版本 `0.1.4`，本轮包版本 `0.4.0`。
- 升级前 `cordis.patch.yml` 与 `src/index.js` 均仅在 Windows 启用；原有 `src/guard.js` 已覆盖工具可见性、调用拦截、会话缓存及重复输出折叠。
- 当前声明支持 DSH `0.2.1-rc.4` / `0.2.2-rc.1`，Node `>=24.9.0`。不直接扩大宿主版本承诺。
- 本机为 Intel macOS 15.7.4，已安装 DSH `0.2.1-rc.4`。应用中包含 `dsh-skill-office`、`dsh-tool-workspace-dependencies`、`dsh-office-to-pdf` 与 LibreOffice Kit；组件存在不等于所有文档操作已通过验收。
- 已实施双平台入口、批量文件工具、办公工具与对应测试；实际验证范围见文末。

## 方案选择

1. **只增加行为提示**：改动最少，适合提醒模型选工具，但无法保证批量修改不遗漏、不中途覆盖或不重复执行。
2. **整体依赖或复制第三方文件引擎**：可以取得现有批处理能力，但会引入安装、原生二进制、权限和升级耦合。
3. **已采用：原守卫 + 小范围受管批处理 + 宿主办公能力**：先覆盖明确的常用操作，把结果与失败处理做实；参考 `dsh-ops` 的结果语义，不强制安装它，也不复制它的完整架构。

继续保留包名、插件 ID 和原配置。首版能力以结构化操作为边界，不尝试解析任意 shell/Python 脚本来推断全部文件副作用。

## 第一阶段：0.2.0，双平台基础

**涉及文件：** `src/index.js`、`src/probe.js`、`src/guard.js`、`cordis.patch.yml`、`README.md`、`test/host.js`、`test/macos.test.js`。

- [x] 在 Windows 和 macOS 启用同一插件；沿用现有工具名和用户配置。
- [x] Mac 通过会话实际绑定的执行器探测 Bash 方言和版本；不根据登录 shell 推断，不假定已经安装 Homebrew、GNU 工具或 PowerShell。
- [x] 保留超时重试、不可用工具屏蔽、旧工具调用拦截及成功日志折叠。Windows 专用提示只用于对应环境。
- [x] 检查中文、空格及特殊字符路径；权限与取消继续由 DSH 管理。
- [x] 运行已有测试及 Mac 真实执行器用例，验证可用 Bash、不存在的执行器、错误方言、文件工具回退和日志原文保留。沙箱不可用时报告不可用，不能算执行成功。

**完成标准：** Mac 能实际使用原插件，Windows 既有规则回归通过。Intel 与 Apple Silicon 的真实验收结果分别记录，不用一个平台的结果代替另一个。

## 第二阶段：0.3.0，可靠批量修改（优先交付）

**新增边界：** `src/batch.js` 负责工具注册，`src/runtime.js` 通过宿主管线取得运行时并执行沙箱子进程；`src/batch-worker.py` 与 `src/worker_common.py` 负责固定文件操作；`test/batch.test.js` 验证用户可见结果。文件与办公共用一个 Python worker，复用宿主解释器和沙箱，避免为两个入口维护两套记录与续做逻辑。

已实现入口 `guard_file_batch`：接收当前会话中的明确操作列表，返回每项结果；不接收任意可执行代码。

```text
runBatch(ctx, exec, request) -> BatchResult
request = { action: run, operations: [{ kind, source, destination?, edits? }] }
        | { action: resume, id }
kind = copy | move | rename | replace_text
BatchResult = { id, status, counts, items }
item.status = completed | skipped | failed | pending | uncertain
```

`resume` 只接受原批次 ID，绑定原会话与原目标；先重新核对当前权限和文件状态，不允许借续做更换目标。文本替换使用明确的匹配内容、替换内容和预期匹配数量，匹配数量不符时该文件不写入。

`status=completed` 仅表示请求已完整完成；冲突、失败、未处理与效果未确认均必须使批次显式显示未完成。`skipped` 只用于确定无须修改的项目，并说明原因。

- [x] 明确源目录、目标文件和筛选规则后再执行；文件列表来自当前任务，执行中不重新扩大匹配范围。普通已授权任务直接运行，目标含糊或出现覆盖冲突时才询问必要问题。
- [x] 先覆盖批量重命名、分类移动、复制和 UTF-8 文本替换。相同目标名、仅大小写差异、路径重叠、相互依赖的移动和超出授权范围在相关操作执行前处理；不能静默覆盖或随意改名。
- [x] 内容写入先产生完整临时文件，核对必要结果后再替换目标；使用逐文件版本检查，读取后被其他程序修改的文件不能无声覆盖。
- [x] 首版每批修改串行执行，复制与读取的并发优化后置；同一文件的多个动作按明确顺序执行，无法表达的依赖在执行前返回冲突。
- [x] 为实际产生写入的批次保留最小逐文件执行记录，不另复制源文档全文；替换与填充文本会保留在操作参数中。中断后不重做已完成项；未开始项可以继续；执行效果不确定的项目先核对结果，不能直接重放。
- [x] 默认错误策略为停止后续写入并报告已完成项。可明确选择独立项目失败后继续，但不能把部分成功报告成全部成功。
- [x] 结果展示成功/失败/未处理数量、失败原因、输出位置和可继续项；大量详情分页或按需读取，不用整份文档内容占满上下文。

**验证场景：** 在临时目录对一批真实文件完成改名/复制/替换；加入重名目标、只读文件、中文路径和操作中断，确认结果逐项正确、失败文件未被截断、已完成项不重复执行。只选择这些直接对应功能的检查。

**边界：** 保证每项操作可核对、避免半写文件，不承诺整批文件具备数据库事务式原子性。不同磁盘的移动需要完成复制并核对后再删除源文件；首版若不能可靠完成该流程，应在执行前明确拒绝。

## 第三阶段：0.4.0，办公文档批处理

**新增边界：** `src/office/operations.py` 负责四种格式的动作、输入检查与输出复读；PDF 使用随包附带的纯 Python pypdf wheel（含许可证）。复用第二阶段的结果、冲突和续做语义，不另建一套任务系统。

```text
guard_office_batch({ action: inspect, files }) -> { status, items: [{ path, status, result: { format, limitations, ... } }] }
guard_office_batch({ files, action, parameters, output }) -> BatchResult
```

- [x] 先根据文件实际类型与任务选择适配器；转换与重算按需加载宿主办公技能，通过 DSH 的 `load_workspace_dependencies` 获取解释器和已带库；不猜 `python`/`node` 命令路径，不默认安装依赖。
- [x] 文件损坏、加密、旧格式或含不支持对象时，逐项报告适用范围。Office ZIP 文件不能作为普通文本批量替换。
- [x] 首版办公修改默认另存输出目录；用户明确要求覆盖原件时沿用该授权，执行单文件完整写入与冲突检查，不逐文件重复确认。

| 顺序 | 格式 | 首版具体行为 | 必要结果检查 |
| --- | --- | --- | --- |
| 1 | Excel `.xlsx` | 批量读取、指定工作表/单元格更新、按明确键合并数据、模板填充 | 重新打开；对指定单元格复读值，测试核对合并行列、公式、类型及跨工作簿样式。需要最新公式值时调用重算并检查结果 |
| 2 | Word `.docx` | 模板字段填充、指定文本替换、表格更新、批量导出 PDF | 重新打开；核对目标段落/表格与相关格式，避免整段替换破坏混合样式 |
| 3 | PDF | 文本提取、页面合并/拆分、从 Office 导出 PDF | 校验可打开、页数/页序及指定内容；扫描件提取明确区分需要 OCR 的情况 |
| 4 | PowerPoint `.pptx` | 模板占位符更新、指定文本/图片替换、批量导出 PDF | 重新打开；核对页数和目标对象。布局/外观修改检查相关页渲染结果 |

公式写入与重算、文件可打开与视觉正确分开报告。复杂图表、宏、嵌入对象、外部链接和加密文档不能默认宣称完整保真；能力不匹配时不覆盖原件，返回具体原因与可行处理路线。

**验证场景：** 使用包含公式/格式的工作簿、混合样式段落的 Word、模板幻灯片和多页 PDF，逐项验证目标修改与未改部分。格式转换或外观修改检查对应渲染；普通数据修改只做相关内容检查。

## 宿主集成与交付

- 优先使用宿主现有任务结果、错误和取消机制。只有出现实际配置需求时才增加符合项目 DSH 原生规范的设置项。
- 精简的能力提示按任务/工具加载；完整办公指南继续通过现有 skills 按需加载，不把所有格式说明常驻系统提示。
- `denyTools`、`probeTimeoutMs`、`compactOutput` 保持兼容；卸载插件不删除用户文件、办公库或历史会话。
- 各阶段独立完成后交付安装包及简短验证结果。发布或 GitHub 同步按后续明确要求执行。

## 参考与适用范围

- [当前插件](https://github.com/Missher12/dsh-windows-guard)：本次升级基线。
- [DSH 桌面办公集成](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop-host/src/office.ts)、[Office 转 PDF](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/office-to-pdf.zh.md)：参考当前官方能力；本机实际能力已另外核对到安装包中的组件与说明，执行仍需逐项验证。
- [dsh-ops 批量读写](https://github.com/T-Auto/dsh-ops/blob/main/docs/file-batching.md)、[批处理结果与恢复语义](https://github.com/T-Auto/dsh-ops/blob/main/docs/native-ptc.md)：参考明确结果和不盲目重试的设计，不将其实现或验证结果算作本插件能力。

## 0.4.0 实际交付与验证

- 文件批处理与办公专项 14 项通过，包含真实子进程中断、续做不重复、冲突/只读/链接检查、改后输入拒绝、四种格式与原件保留。
- 当前 Intel Mac 已使用实际 DSH Bash 执行器与 OS 沙箱；DSH 0.2.1-rc.4 兼容集成检查 44 项通过、1 项按平台跳过，0 失败。
- 使用本机官方 LibreOffice Kit 完成真实 Word 转 PDF、Excel 重算，以及修改后的 Word/PPT 页面渲染与人工图像检查。样例中文、混合样式、表格与替换图片显示正常；不代表所有文档视觉保真。
- Windows 和 Apple Silicon 未做本轮真机验证。保留 Windows 专项并补充已有 CI 的 Python 依赖与包内批处理检查；未推送，因此没有新 CI 结果。
- 全量 `node --test test/*.test.js`：81 项，72 通过、9 项按平台跳过、0 失败；`git diff --check` 与两个验收脚本语法检查通过。
- `npm pack` 生成 `dsh-windows-guard-0.4.0.tgz`，15 个文件，429,525 字节，包含 Python worker、Office 适配器、pypdf wheel 与许可证。
- `node scripts/verify-macos.js` 从该安装包解压后运行 Mac、批处理、办公和宿主集成用例：29 项全部通过，0 跳过。此结果是包内验证，未安装进日常 DSH profile。
