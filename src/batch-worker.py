"""Fixed file/Office operations. Invoked only through the host's sandboxed subprocess."""
import contextlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unicodedata
import uuid

from worker_common import MAX_BYTES, require, linked, safe_path, version


def path_key(path):
    # Conservatively reject case/Unicode aliases across both supported platforms.
    return unicodedata.normalize("NFC", str(path)).casefold()


def replace_text(path, edits):
    raw = path.read_bytes()
    require(b"\0" not in raw, "二进制文件不能作为文本替换")
    text = raw.decode("utf-8", errors="strict")
    require(isinstance(edits, list) and 1 <= len(edits) <= 100, "需要 1–100 项文本替换")
    for edit in edits:
        old, new, count = edit.get("oldText"), edit.get("newText"), edit.get("count")
        require(isinstance(old, str) and old and isinstance(new, str), "替换文本无效")
        require(type(count) is int and count > 0, "必须指定正整数匹配数量 count")
        require(text.count(old) == count, "匹配数量不符，未修改文件")
        text = text.replace(old, new)
    result = text.encode("utf-8")
    require(len(result) <= MAX_BYTES, "输出超过 64 MiB 限制")
    return result


def sources_of(op):
    return op.get("sources", [op["source"]])


def inputs_of(root, op, sources):
    if op.get("kind") == "office" and op.get("action") == "edit":
        return sources + [safe_path(root, edit["image"]) for edit in op["parameters"].get("pictures", [])]
    return sources


def preflight(root, operations):
    require(isinstance(operations, list) and 1 <= len(operations) <= 100, "每批需要 1–100 项明确操作")
    items, reads, writes = [], [], []
    for index, op in enumerate(operations):
        row = {"operation": op, "status": "pending", "index": index}
        items.append(row)
        try:
            kind = op.get("kind")
            require(kind in {"copy", "move", "rename", "replace_text", "office"}, "未知操作")
            if kind != "office":
                allowed = {"kind", "source", "edits"} if kind == "replace_text" else {"kind", "source", "destination"}
                require(set(op) <= allowed, "此文件操作不支持提供的参数")
                require(kind == "replace_text" or op.get("destination"), "复制、移动和重命名需要明确目标")
            sources = [safe_path(root, p) for p in sources_of(op)]
            inputs = inputs_of(root, op, sources)
            row["expected"] = [version(p) for p in inputs]
            if kind == "office":
                from office.operations import validate_operation
                validate_operation(op, sources, root)
            target = safe_path(root, op.get("destination", op["source"]))
            overwrite = kind == "replace_text" or (kind == "office" and op.get("overwrite") is True)
            if overwrite:
                require(target == sources[0], "覆盖只能用于原文件")
                require(sources[0].stat().st_mode & 0o222, "原文件只读")
            else:
                require(not target.exists(), "目标已存在，未覆盖: " + str(target))
            if kind in {"move", "rename"}:
                require(sources[0].stat().st_mode & 0o222, "源文件只读")
                parent = target.parent
                while not parent.exists():
                    parent = parent.parent
                require(parent.stat().st_dev == sources[0].stat().st_dev, "跨磁盘移动请先复制并核对，再单独处理源文件")
            if kind == "replace_text":
                replace_text(sources[0], op.get("edits"))
            row["target"] = str(target.relative_to(root))
            row["overwrite"] = overwrite
            reads.append((index, {path_key(p) for p in inputs}))
            writes.append((index, path_key(target)))
            if kind in {"move", "rename"}:
                writes.append((index, path_key(sources[0])))
        except Exception as error:
            row.update(status="failed", error=str(error))
    for index, target in writes:
        if any(j != index and (target == other or target.startswith(other + os.sep) or other.startswith(target + os.sep))
               for j, other in writes) or any(j != index and target in paths for j, paths in reads):
            items[index].update(status="failed", error="批次中有重复、重叠或相互依赖的目标，请拆成顺序批次")
    return items


def atomic_json(path, value):
    fd, temp = tempfile.mkstemp(prefix=".record-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


@contextlib.contextmanager
def lock_store(store):
    lock = store / ".lock"
    require(not linked(lock), "批次锁不能是链接")
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "r+b") as stream:
        if os.name == "nt":
            import msvcrt
            stream.write(b"0")
            stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def summarize(record, status=None):
    counts = {name: 0 for name in ["completed", "skipped", "failed", "pending", "uncertain"]}
    rows = []
    for row in record["items"]:
        counts[row["status"]] += 1
        rows.append({key: row[key] for key in ["index", "status", "target", "error", "result"] if key in row})
    complete = not any(counts[name] for name in ["failed", "pending", "uncertain"])
    return {"id": record.get("id"), "status": status or ("completed" if complete else "partial"),
            "counts": counts, "items": rows}


def recover(root, row):
    target = safe_path(root, row["target"])
    try:
        proved = version(target) == row.get("published")
        if row["operation"]["kind"] in {"move", "rename"}:
            proved = proved and not safe_path(root, row["operation"]["source"]).exists()
        if proved:
            row["status"] = "completed"
            row.pop("error", None)
        else:
            row["error"] = "执行效果尚不能确认，请检查目标文件；不会自动重放"
    except (OSError, ValueError):
        row["error"] = "执行效果尚不能确认，请检查目标文件；不会自动重放"


def execute_item(root, row, save, runtime):
    op = row["operation"]
    sources = [safe_path(root, p) for p in sources_of(op)]
    inputs = inputs_of(root, op, sources)
    require([version(p) for p in inputs] == row["expected"], "源文件或替换图片在读取后发生变化，未修改")
    source, target = sources[0], safe_path(root, row["target"])
    if not row["overwrite"]:
        require(not target.exists(), "目标已存在，未覆盖")
    safe_path(root, str(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    safe_path(root, str(target))
    if op["kind"] in {"move", "rename"}:
        row.update(status="uncertain", published=version(source))
        save()
        os.link(source, target)
        require(version(source) == row["expected"][0], "移动中源文件改变；已停止，请核对两个路径")
        source.unlink()
    else:
        fd, temporary = tempfile.mkstemp(prefix=".dsh-guard-", suffix=target.suffix, dir=target.parent)
        os.close(fd)
        temp = Path(temporary)
        try:
            if op["kind"] == "copy":
                shutil.copyfile(source, temp)
                require(temp.stat().st_size == source.stat().st_size, "复制输出大小不符")
            elif op["kind"] == "replace_text":
                content = replace_text(source, op["edits"])
                if content == source.read_bytes():
                    row.update(status="skipped", result={"reason": "内容没有变化"})
                    return
                temp.write_bytes(content)
            else:
                from office.operations import prepare_output
                row["result"] = prepare_output(op, sources, temp, root, runtime)
            require([version(p) for p in inputs] == row["expected"], "源文件或替换图片在处理时发生变化，未覆盖")
            require(temp.stat().st_size <= MAX_BYTES, "输出超过 64 MiB 限制")
            os.chmod(temp, stat.S_IMODE(source.stat().st_mode))
            with temp.open("rb") as stream:
                os.fsync(stream.fileno())
            row.update(status="uncertain", published=version(temp))
            save()
            safe_path(root, str(target))
            if row["overwrite"]:
                require(version(target) == row["expected"][0], "原文件发生变化，未覆盖")
                os.replace(temp, target)
            else:
                os.link(temp, target)  # Exclusive publication: never replace an existing name.
        finally:
            temp.unlink(missing_ok=True)
    row.update(status="completed")
    row.pop("error", None)


def run(payload):
    root = Path(payload["root"]).resolve(strict=True)
    require(root.is_dir(), "会话目录不可用")
    session = payload.get("session")
    require(isinstance(session, str) and session, "需要当前会话身份")
    request = payload["request"]
    family = payload.get("family", "files")
    if request.get("action") in {"resume", "status"}:
        require(set(request) <= {"action", "id"}, "续做或查看状态只接受原批次 ID，不能更换参数")
    if family == "office" and request.get("action") in {"inspect", "read"}:
        from office.operations import read_office
        return read_office(root, request)
    store = root / ".dsh-guard"
    require(not linked(store), "批次记录目录不能是链接")
    if request.get("action") in {"list", "status"}:
        records = []
        if store.exists():
            if request["action"] == "status":
                identity = request.get("id", "")
                require(str(uuid.UUID(identity)) == identity, "批次 ID 无效")
                paths = [store / (identity + ".json")]
            else:
                paths = sorted(store.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:1000]
            offset = request.get("offset", 0)
            require(type(offset) is int and 0 <= offset <= 1000, "批次分页 offset 无效")
            matched = 0
            for file in paths:
                require(not linked(file), "批次记录不能是链接")
                require(file.stat().st_size <= 2 * 1024 * 1024, "批次记录过大")
                record = json.loads(file.read_text(encoding="utf-8"))
                if record.get("session") == session and record.get("family") == family:
                    matched += 1
                    if matched <= offset:
                        continue
                    summary = summarize(record)
                    records.append(summary if request["action"] == "status" else {k: summary[k] for k in ["id", "status", "counts"]})
                    if len(records) == 20:
                        break
        if request["action"] == "status":
            require(records, "当前会话没有这个批次")
            return records[0]
        return {"status": "completed", "items": records, "complete": len(records) < 20,
                "nextOffset": request.get("offset", 0) + len(records)}
    store.mkdir(mode=0o700, exist_ok=True)
    with lock_store(store):
        if request.get("action") == "resume":
            identity = request.get("id", "")
            require(isinstance(identity, str) and str(uuid.UUID(identity)) == identity, "批次 ID 无效")
            record_path = safe_path(root, str(store / (identity + ".json")), internal=True)
            require(record_path.stat().st_size <= 2 * 1024 * 1024, "批次记录过大")
            record = json.loads(record_path.read_text(encoding="utf-8"))
            require(record["session"] == session and record["family"] == family, "批次不属于当前会话或工具")
            require(record["root"] == str(root) and record["rootIdentity"] == [str(root.stat().st_dev), str(root.stat().st_ino)], "会话目录已被替换")
        else:
            operations = request.get("operations")
            if family == "office":
                from office.operations import make_operations
                operations = make_operations(root, request)
            else:
                require(request.get("action") == "run", "action 必须是 run 或 resume")
            on_error = request.get("onError", "stop")
            require(on_error in {"stop", "continue"}, "onError 必须是 stop 或 continue")
            record = {"id": str(uuid.uuid4()), "root": str(root), "rootIdentity": [str(root.stat().st_dev), str(root.stat().st_ino)], "onError": on_error,
                      "session": session, "family": family, "items": preflight(root, operations)}
            if any(row["status"] == "failed" for row in record["items"]):
                record["id"] = None
                return summarize(record, "failed")
            record_path = store / (record["id"] + ".json")
        save = lambda: atomic_json(record_path, record)
        if family == "office" and not payload.get("runtime", {}).get("officeCli") and any(
                row["status"] not in {"completed", "skipped"} and row["operation"].get("action") in {"export_pdf", "recalculate"}
                for row in record["items"]):
            return {"status": "needs-office-runtime", "id": record["id"]}
        save()
        for row in record["items"]:
            if row["status"] in {"completed", "skipped"}:
                continue
            if row["status"] == "uncertain":
                recover(root, row)
                save()
                if row["status"] == "uncertain":
                    break
                continue
            try:
                row["status"] = "pending"
                execute_item(root, row, save, payload.get("runtime", {}))
            except Exception as error:
                row["error"] = str(error)
                if row["status"] != "uncertain":
                    row["status"] = "failed"
                save()
                if row["status"] == "failed" and record.get("onError") == "continue":
                    continue
                break
            save()
        return summarize(record)


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        require(len(raw) <= 2 * 1024 * 1024, "请求超过 2 MiB 限制")
        output = run(json.loads(raw))
    except Exception as error:
        output = {"status": "failed", "error": str(error), "items": []}
    print(json.dumps(output, ensure_ascii=True, allow_nan=False))
