"""Measure the exact local samples emitted by bench.js with DeepSeek's tokenizer."""
import json
from pathlib import Path
import subprocess
import sys

from tokenizers import Tokenizer
from verify_v4 import verify

root = Path(__file__).resolve().parents[1]
verify(sys.argv[1])
tokenizer = Tokenizer.from_file(sys.argv[1])
samples = json.loads(subprocess.check_output(
    ["node", str(root / "scripts" / "bench.js"), "--json", *sys.argv[2:]], cwd=root, encoding="utf-8"
))
print("task             side   header  results  sum  failed  probes")
for task, pair in samples.items():
    for side, sample in pair.items():
        header, *results = tokenizer.encode_batch(
            [sample["header"], *sample["results"]], add_special_tokens=False
        )
        a, b = len(header.ids), sum(len(result.ids) for result in results)
        print(f"{task:16} {side:6} {a:6} {b:8} {a+b:4} {sample['failures']:7} {sample['probes']:7}")
