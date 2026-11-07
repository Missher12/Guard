"""Office adapters prepare and reopen outputs; the common batch worker publishes them."""
from copy import copy
import datetime
import json
from pathlib import Path
import re
import subprocess
import sys
import zipfile

from worker_common import MAX_BYTES, require, safe_path, version

sys.path.insert(0, str(Path(__file__).parent / "vendor/pypdf-6.18.1-py3-none-any.whl"))


def inspect_format(path):
    version(path)
    kind = path.suffix.lower().lstrip(".")
    require(kind in {"xlsx", "docx", "pptx", "pdf"}, "首版支持 xlsx/docx/pptx/pdf；旧格式、宏或加密文件需要单独处理")
    limitations = []
    if kind == "pdf":
        from pypdf import PdfReader
        require(path.open("rb").read(5) == b"%PDF-", "文件内容不是 PDF")
        reader = PdfReader(path)
        require(not reader.is_encrypted, "加密 PDF 需要单独处理")
        return {"format": kind, "pages": len(reader.pages), "limitations": []}
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        require(len(entries) <= 10000 and sum(e.file_size for e in entries) <= 256 * 1024 * 1024, "Office 解压内容超出处理上限")
        require(not any(e.flag_bits & 1 for e in entries), "加密文档需要单独处理")
        names = archive.namelist()
        require(len(names) == len(set(names)), "Office 包含重复条目")
        main = {"xlsx": "xl/workbook.xml", "docx": "word/document.xml", "pptx": "ppt/presentation.xml"}[kind]
        require(main in names and "[Content_Types].xml" in names, "文档内容与扩展名不一致")
        if any(re.search(r"(?:vbaProject|/embeddings/|/activeX/|/externalLinks/|_xmlsignatures|/charts/|/pivot|/slicers/|/queryTables/|/connections\.xml)", n, re.I) for n in names):
            limitations.append("包含宏、嵌入对象、图表、外部链接或签名，首版不修改这些文档")
        if kind == "docx" and re.search(rb"<w:(?:ins|del|altChunk)\b", archive.read(main)):
            limitations.append("包含修订或嵌入文档，首版不修改")
    return {"format": kind, "limitations": limitations}


def make_operations(root, request):
    action = request.get("action")
    require(action in {"edit", "merge", "split", "export_pdf", "recalculate"}, "不支持的办公操作")
    files = request.get("files")
    require(isinstance(files, list) and 1 <= len(files) <= 100, "需要 1–100 个明确文件")
    shared = request.get("parameters", {})
    require(isinstance(shared, dict), "parameters 必须是对象")
    overwrite = request.get("overwrite") is True
    operations = []
    if action == "merge":
        require(not overwrite, "合并必须另存输出")
        require(not any(f.get("output") or f.get("parameters") for f in files), "合并请使用顶层 output 和 parameters")
        source = files[0]["path"]
        output = request.get("output") or str(Path("guard-output") / ("merged" + Path(source).suffix))
        return [{"kind": "office", "action": action, "source": source, "sources": [f["path"] for f in files],
                 "destination": output, "parameters": shared, "overwrite": False}]
    for file in files:
        source = file["path"]
        suffix = ".pdf" if action == "export_pdf" else Path(source).suffix
        output = file.get("output") or request.get("output") or (source if overwrite else str(Path("guard-output") / (Path(source).stem + suffix)))
        operations.append({"kind": "office", "action": action, "source": source, "destination": output,
                           "parameters": {**shared, **file.get("parameters", {})}, "overwrite": overwrite})
    return operations


def validate_operation(op, sources, root):
    facts = [inspect_format(p) for p in sources]
    kind = facts[0]["format"]
    action = op["action"]
    require(all(f["format"] == kind for f in facts), "同一次合并必须使用同一种格式")
    output_kind = Path(op["destination"]).suffix.lower().lstrip(".")
    require(output_kind == ("pdf" if action == "export_pdf" else kind), "输出扩展名与操作不一致")
    if action != "export_pdf":
        require(not any(f["limitations"] for f in facts), "文档包含不支持修改的复杂对象，请使用独立工作流")
    allowed = {"edit": {"xlsx": {"cells", "fields", "replacements"}, "docx": {"fields", "replacements", "tables"},
                        "pptx": {"fields", "replacements", "pictures"}}.get(kind, set()),
               "merge": {"sheet", "key", "duplicate"} if kind == "xlsx" else set(),
               "split": {"pages"}, "export_pdf": set(), "recalculate": set()}[action]
    require(set(op["parameters"]) <= allowed, "此格式或操作不支持提供的参数")
    if action == "edit":
        require(kind != "pdf", "PDF 修改请使用页面合并或拆分")
        edit_document(kind, sources[0], op["parameters"], root)
    elif action == "merge":
        require(kind in {"xlsx", "pdf"}, "合并支持 Excel 或 PDF")
        require(sum(p.stat().st_size for p in sources) <= MAX_BYTES, "合并输入总量超过 64 MiB，请分批")
        if kind == "xlsx":
            merge_books(sources, op["parameters"])
    elif action == "split":
        require(kind == "pdf", "页面拆分仅支持 PDF")
        select_pages(op["parameters"].get("pages"), facts[0]["pages"])
    elif action == "recalculate":
        require(kind == "xlsx", "公式重算仅支持 xlsx")
    else:
        require(kind != "pdf", "PDF 不需要再次导出 PDF")


def specs(parameters, texts):
    result = list(parameters.get("replacements", []))
    for name, value in parameters.get("fields", {}).items():
        old = "{{" + name + "}}"
        result.append({"oldText": old, "newText": value, "count": sum(t.count(old) for t in texts)})
    for edit in result:
        require(isinstance(edit.get("oldText"), str) and edit["oldText"] and isinstance(edit.get("newText"), str), "替换字段必须是非空源文本与目标文本")
        count = edit.get("count")
        require(type(count) is int and count > 0 and sum(t.count(edit["oldText"]) for t in texts) == count, "替换匹配数量不符或字段不存在")
        texts = [t.replace(edit["oldText"], edit["newText"]) for t in texts]
    return result


def replace_runs(paragraph, old, new):
    runs = list(paragraph.runs)
    text = "".join(run.text for run in runs)
    starts, offset = [], 0
    for run in runs:
        starts.append(offset)
        offset += len(run.text)
    matches = list(re.finditer(re.escape(old), text))
    for match in reversed(matches):
        first = True
        for i, run in enumerate(runs):
            start, end = starts[i], starts[i] + len(run.text)
            if end <= match.start() or start >= match.end():
                continue
            left, right = max(0, match.start() - start), min(len(run.text), match.end() - start)
            run.text = run.text[:left] + (new if first else "") + run.text[right:]
            first = False


def word_paragraphs(document):
    result, seen = [], set()
    def collect(container):
        for p in container.paragraphs:
            if p._p not in seen:
                seen.add(p._p)
                result.append(p)
        for table in container.tables:
            for row in table.rows:
                for cell in row.cells:
                    collect(cell)
    collect(document)
    for section in document.sections:
        for field in ["header", "footer", "first_page_header", "first_page_footer", "even_page_header", "even_page_footer"]:
            container = getattr(section, field)
            if not container.is_linked_to_previous:
                collect(container)
    return result


def ppt_paragraphs(presentation):
    result = []
    def collect(shapes):
        for shape in shapes:
            if hasattr(shape, "shapes"):
                collect(shape.shapes)
            if shape.has_text_frame:
                result.extend(shape.text_frame.paragraphs)
            if shape.has_table:
                for row in shape.table.rows:
                    for cell in row.cells:
                        result.extend(cell.text_frame.paragraphs)
    for slide in presentation.slides:
        collect(slide.shapes)
    return result


def edit_document(kind, source, parameters, root):
    require(any(parameters.get(key) for key in ["fields", "replacements", "cells", "tables", "pictures"]), "没有指定修改内容")
    if kind == "xlsx":
        from openpyxl import load_workbook
        document = load_workbook(source)
        for edit in parameters.get("cells", []):
            require(edit.get("sheet") in document.sheetnames and re.fullmatch(r"[A-Z]{1,3}[1-9]\d{0,6}", edit.get("cell", "")), "工作表或单元格地址无效")
            cell = document[edit["sheet"]][edit["cell"]]
            cell.value = edit["value"]
        cells = [cell for sheet in document for row in sheet for cell in row if isinstance(cell.value, str)]
        edits = specs(parameters, [c.value for c in cells])
        for edit in edits:
            for cell in cells:
                # Formula text requires an explicit cell edit, not template substitution.
                if edit["oldText"] in cell.value:
                    require(cell.data_type != "f", "公式请使用明确的单元格修改")
                    cell.value = cell.value.replace(edit["oldText"], edit["newText"])
                    cell.data_type = "s"
        return document
    if kind == "docx":
        from docx import Document
        document = Document(source)
        paragraphs = word_paragraphs(document)
    else:
        from pptx import Presentation
        document = Presentation(source)
        paragraphs = ppt_paragraphs(document)
    for edit in specs(parameters, ["".join(r.text for r in p.runs) for p in paragraphs]):
        for paragraph in paragraphs:
            replace_runs(paragraph, edit["oldText"], edit["newText"])
    if kind == "docx":
        for edit in parameters.get("tables", []):
            require(type(edit["table"]) is int and 1 <= edit["table"] <= len(document.tables), "表格序号超出范围")
            table = document.tables[edit["table"] - 1]
            require(1 <= edit["row"] <= len(table.rows) and 1 <= edit["column"] <= len(table.columns), "表格单元格超出范围")
            cell = table.cell(edit["row"] - 1, edit["column"] - 1)
            require(len(cell.paragraphs) == 1 and not cell.tables, "复杂表格单元格需要单独处理")
            p = cell.paragraphs[0]
            if p.runs:
                p.runs[0].text = edit["value"]
                for run in p.runs[1:]:
                    run.text = ""
            else:
                p.add_run(edit["value"])
    else:
        for edit in parameters.get("pictures", []):
            require(1 <= edit["slide"] <= len(document.slides), "幻灯片超出范围")
            slide = document.slides[edit["slide"] - 1]
            require(1 <= edit["shape"] <= len(slide.shapes), "幻灯片对象超出范围")
            old = slide.shapes[edit["shape"] - 1]
            require(old.shape_type == 13, "指定对象不是图片")
            image = safe_path(root, edit["image"])
            version(image)
            new = slide.shapes.add_picture(str(image), old.left, old.top, old.width, old.height)
            new.rotation, new.name = old.rotation, old.name
            for field in ["crop_left", "crop_right", "crop_top", "crop_bottom"]:
                setattr(new, field, getattr(old, field))
            parent, index = old._element.getparent(), old._element.getparent().index(old._element)
            parent.remove(new._element)
            parent.insert(index, new._element)
            parent.remove(old._element)
    return document


def merge_books(sources, parameters):
    from openpyxl import load_workbook
    from openpyxl.formula import Tokenizer
    from openpyxl.formula.translate import Translator
    sheet_name, key = parameters.get("sheet"), parameters.get("key")
    require(isinstance(key, str) and key, "合并 Excel 必须指定唯一键 key")
    books = [load_workbook(source) for source in sources]
    sheets = [book[sheet_name] if sheet_name else book.active for book in books]
    headers = [cell.value for cell in sheets[0][1]]
    require(headers.count(key) == 1, "唯一键列不存在或重复")
    key_index, rows, order = headers.index(key), {}, []
    duplicate = parameters.get("duplicate", "error")
    require(duplicate in {"error", "first", "last"}, "重复键处理方式无效")
    style_fields = ["font", "fill", "border", "alignment", "protection", "number_format", "quotePrefix"]
    for sheet in sheets:
        require(not sheet.merged_cells.ranges and not sheet.tables, "带合并单元格或 Excel 表对象的数据表需要单独合并")
        require([cell.value for cell in sheet[1]] == headers, "各文件表头不一致")
        for row in list(sheet.iter_rows())[1:]:
            if all(cell.value is None for cell in row):
                continue
            value = row[key_index].value
            require(value is not None and row[key_index].data_type != "f", "唯一键不能为空或公式")
            identity = (type(value).__name__, str(value))
            if identity in rows:
                require(duplicate != "error", "发现重复键: " + str(value))
                if duplicate == "first":
                    continue
            else:
                order.append(identity)
            for cell in row:
                if cell.data_type != "f":
                    continue
                require(isinstance(cell.value, str), "数组公式需要单独合并")
                for token in Tokenizer(cell.value).items:
                    if token.type == "FUNC":
                        require(token.value.upper() not in {"INDIRECT(", "OFFSET("}, "动态引用公式需要单独合并")
                    if token.type == "OPERAND" and token.subtype == "RANGE":
                        refs = token.value.split(":")
                        matches = [re.fullmatch(r"\$?[A-Z]{1,3}([1-9]\d*)", ref, re.I) for ref in refs]
                        require(len(refs) <= 2 and all(m and int(m[1]) == cell.row for m in matches),
                                "合并仅支持当前行的相对引用公式；跨行、跨表或固定行引用需要单独处理")
            rows[identity] = [(c.value, c.data_type, c.coordinate, {field: copy(getattr(c, field)) for field in style_fields},
                               copy(c.hyperlink), copy(c.comment)) for c in row]
    target = sheets[0]
    target.delete_rows(2, max(0, target.max_row - 1))
    for row_index, identity in enumerate(order, 2):
        for column, (value, data_type, origin, styles, hyperlink, comment) in enumerate(rows[identity], 1):
            cell = target.cell(row_index, column)
            cell.value = Translator(value, origin=origin).translate_formula(cell.coordinate) if data_type == "f" else value
            cell.data_type = data_type
            for field, style in styles.items():
                setattr(cell, field, style)
            cell.hyperlink, cell.comment = hyperlink, comment
    return books[0]


def select_pages(pages, count):
    require(isinstance(pages, list) and pages and len(pages) <= 10000 and all(type(p) is int and 1 <= p <= count for p in pages), "需要有效的页码列表（从 1 开始）")
    return [p - 1 for p in pages]


def cli_output(action, source, target, runtime):
    node, cli = runtime.get("node"), runtime.get("officeCli")
    require(node and cli and Path(node).is_absolute() and Path(cli).is_absolute(), "需要宿主提供的 LibreOffice Kit 绝对路径")
    target.unlink(missing_ok=True)  # The engine requires an exclusively new output.
    result = subprocess.run([node, cli, "convert" if action == "export_pdf" else "recalculate", "--input", str(source), "--output", str(target)],
                            capture_output=True, timeout=90, check=False)
    require(result.returncode == 0 and target.is_file(), "办公引擎失败: " + result.stderr.decode("utf-8", "replace")[-2000:])


def prepare_output(op, sources, target, root, runtime):
    action, kind = op["action"], sources[0].suffix.lower()[1:]
    if action in {"export_pdf", "recalculate"}:
        cli_output(action, sources[0], target, runtime)
    elif action == "edit":
        edit_document(kind, sources[0], op["parameters"], root).save(target)
    elif kind == "xlsx":
        merge_books(sources, op["parameters"]).save(target)
    else:
        from pypdf import PdfReader, PdfWriter
        writer = PdfWriter()
        if action == "merge":
            for source in sources:
                writer.append(PdfReader(source))
        else:
            reader = PdfReader(sources[0])
            for page in select_pages(op["parameters"].get("pages"), len(reader.pages)):
                writer.add_page(reader.pages[page])
        writer.write(target)
    facts = inspect_format(target)
    # Reopen the produced format before it can replace a user's file.
    if facts["format"] == "xlsx":
        from openpyxl import load_workbook
        book = load_workbook(target, data_only=action == "recalculate")
        if action == "edit":
            for edit in op["parameters"].get("cells", []):
                require(book[edit["sheet"]][edit["cell"]].value == edit["value"], "输出单元格与请求不符")
        if action == "recalculate":
            formulas = load_workbook(target, data_only=False)
            errors = [cell.coordinate for sheet in book for row in sheet for cell in row if cell.data_type == "e"]
            require(not errors, "重算结果含公式错误: " + ", ".join(errors[:10]))
            count = sum(cell.data_type == "f" for sheet in formulas for row in sheet for cell in row)
            return {"format": "xlsx", "formulaRecalculated": True, "formulaCount": count, "visualChecked": False}
        return {"format": "xlsx", "sheets": book.sheetnames, "formulaRecalculated": False, "visualChecked": False}
    if facts["format"] == "docx":
        from docx import Document
        doc = Document(target)
        return {"format": "docx", "paragraphs": len(doc.paragraphs), "visualChecked": False}
    if facts["format"] == "pptx":
        from pptx import Presentation
        return {"format": "pptx", "slides": len(Presentation(target).slides), "visualChecked": False}
    return {**facts, "visualChecked": False}


def json_value(value):
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    return value


def read_one(source, parameters, facts):
    offset, limit = parameters.get("offset", 0), parameters.get("limit", 50)
    require(type(offset) is int and offset >= 0 and type(limit) is int and 1 <= limit <= 100, "读取范围无效")
    kind = facts["format"]
    allowed = {"offset", "limit"} | ({"sheet"} if kind == "xlsx" else {"pages"} if kind == "pdf" else set())
    require(set(parameters) <= allowed, "此格式不支持提供的读取参数")
    if kind == "xlsx":
        from openpyxl import load_workbook
        book = load_workbook(source, read_only=True, data_only=False)
        sheet = book[parameters["sheet"]] if parameters.get("sheet") else book.active
        require(sheet.max_column <= 1000, "工作表列数超过单次读取上限")
        rows = [[json_value(c.value) for c in row] for row in sheet.iter_rows(min_row=offset + 1, max_row=min(sheet.max_row, offset + limit))] if offset < sheet.max_row else []
        return {"sheet": sheet.title, "sheets": book.sheetnames, "rows": rows, "total": sheet.max_row,
                "nextOffset": min(sheet.max_row, offset + len(rows)), "complete": offset + len(rows) >= sheet.max_row}
    if kind == "docx":
        from docx import Document
        paragraphs = [p.text for p in word_paragraphs(Document(source))]
        return {"paragraphs": paragraphs[offset:offset + limit], "total": len(paragraphs), "nextOffset": min(len(paragraphs), offset + limit), "complete": offset + limit >= len(paragraphs)}
    if kind == "pptx":
        from pptx import Presentation
        presentation = Presentation(source)
        slides = [{"slide": i + 1, "shapes": [{"shape": n + 1, "text": s.text if s.has_text_frame else "", "type": int(s.shape_type)} for n, s in enumerate(slide.shapes)]}
                  for i, slide in enumerate(presentation.slides) if offset <= i < offset + limit]
        return {"slides": slides, "total": len(presentation.slides), "nextOffset": min(len(presentation.slides), offset + limit), "complete": offset + limit >= len(presentation.slides)}
    from pypdf import PdfReader
    reader = PdfReader(source)
    selected = select_pages(parameters["pages"], len(reader.pages)) if parameters.get("pages") else list(range(offset, min(len(reader.pages), offset + limit)))
    pages = [{"page": i + 1, "text": reader.pages[i].extract_text() or ""} for i in selected]
    return {"pages": pages, "total": len(reader.pages), "pagesWithoutText": [p["page"] for p in pages if not p["text"].strip()],
            "note": "无文本页可能是扫描件或空白页；本操作不执行 OCR", "nextOffset": min(len(reader.pages), offset + limit), "complete": bool(parameters.get("pages")) or offset + limit >= len(reader.pages)}


def read_office(root, request):
    files = request.get("files")
    require(isinstance(files, list) and 1 <= len(files) <= 16, "每次读取需要 1–16 个文件")
    require(not request.get("overwrite") and not request.get("output") and not any(f.get("output") for f in files), "只读操作不接受输出或覆盖参数")
    if request["action"] == "inspect":
        require(not request.get("parameters") and not any(f.get("parameters") for f in files), "格式检查不接受内容修改或读取参数")
    items = []
    for file in files:
        try:
            source = safe_path(root, file["path"])
            facts = inspect_format(source)
            result = facts if request["action"] == "inspect" else read_one(source, {**request.get("parameters", {}), **file.get("parameters", {})}, facts)
            require(len(json.dumps(result, ensure_ascii=True)) <= 40000, "本次内容过长，请减小 limit 或按指定页读取")
            items.append({"path": file["path"], "status": "completed", "result": result})
        except Exception as error:
            items.append({"path": file.get("path"), "status": "failed", "error": str(error)})
    return {"status": "completed" if all(i["status"] == "completed" for i in items) else "partial", "items": items}
