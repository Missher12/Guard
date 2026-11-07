import os
from pathlib import Path
import stat

MAX_BYTES = 64 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def linked(path):
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def safe_path(root, value, internal=False):
    require(isinstance(value, str) and value and "\0" not in value, "路径不能为空")
    p = Path(value)
    p = p if p.is_absolute() else root / p
    require(".." not in p.parts, "路径不能包含 ..")
    try:
        relative = p.relative_to(root)
    except ValueError:
        raise ValueError("路径超出当前会话目录")
    require(relative.parts, "操作目标必须是文件")
    for part in relative.parts:
        require(internal or part.casefold() != ".dsh-guard", "不能操作批次记录目录")
        if os.name == "nt":
            require(":" not in part and not part.endswith((".", " ")) and not Path(part).is_reserved(), "Windows 路径含有歧义或保留设备名")
    current = root
    for part in relative.parts:
        current /= part
        require(not linked(current), "不能经过符号链接或目录联接: " + str(current))
    return p


def version(path):
    s = path.stat()
    require(stat.S_ISREG(s.st_mode), "仅支持普通文件: " + str(path))
    require(s.st_size <= MAX_BYTES, "文件超过 64 MiB 限制")
    # JSON consumers (including the host) cannot represent nanoseconds as a JS number.
    return [str(s.st_dev), str(s.st_ino), str(s.st_size), str(s.st_mtime_ns), str(s.st_mode)]
