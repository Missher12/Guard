"""Reproduce the bounds that permit lossless-in-count output folding."""
import hashlib
import json
from pathlib import Path
import re
import sys


def verify(path):
    raw = Path(path).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == "89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614", "unexpected tokenizer revision"
    spec = json.loads(raw)
    assert spec["normalizer"] == {"type": "Sequence", "normalizers": []}
    assert spec["model"]["type"] == "BPE"
    assert spec["pre_tokenizer"]["pretokenizers"][-1]["add_prefix_space"] is False
    assert all(not t["lstrip"] and not t["rstrip"] for t in spec["added_tokens"])

    # The ByteLevel alphabet is a reversible mapping of bytes to Unicode.
    direct = [*range(33, 127), *range(161, 173), *range(174, 256)]
    rest = sorted(set(range(256)) - set(direct))
    codes = dict(zip(map(chr, direct + list(range(256, 256 + len(rest)))), direct + rest))
    added = {t["content"] for t in spec["added_tokens"]}
    vocab = {bytes(codes[c] for c in v) for v in spec["model"]["vocab"] if v not in added}
    vocab.update(s.encode() for s in added)
    assert all(bytes([b]) in vocab for b in range(256)), "upper bound needs single-byte fallback"
    assert max(map(len, vocab)) == 128
    # Concatenating tokens can merge these groups, never create more of them.
    # C2 A0 encodes NBSP; the four vocab exceptions are sequences of NBSP and spaces.
    def groups(piece):
        return sum(bool(g.strip(b"\xc2\xa0")) for g in re.split(rb"[ \t\r\n]+", piece))
    assert max(groups(v) for v in vocab) == 1


if __name__ == "__main__":
    verify(sys.argv[1])
    print("Verified DeepSeek V4 byte and group bounds for every vocabulary token.")
