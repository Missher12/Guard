"""Count Native tool traffic and summarize paired, offline Guard comparisons."""
import hashlib
import json
from pathlib import Path
from statistics import median
import sys

from tokenizers import Tokenizer


def summarize(samples, tokenizer):
    counts = []
    for sample in samples:
        corpus = [turn[field] for turn in sample["turns"] for field in ("schema", "call", "result")]
        counts.append(sum(len(result.ids) for result in tokenizer.encode_batch(corpus, add_special_tokens=False)))
    assert counts, "missing benchmark trials"
    return {"tokens": int(median(counts)),
            "elapsedMs": round(median(s["elapsedMs"] for s in samples), 3),
            **{key: int(median(s[key] for s in samples)) for key in ("calls", "toolFailures", "failedItems", "redRows")}}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: python scripts/count-comparison.py <tokenizer.json> <report.json> [more reports]")
    tokenizer_path = Path(sys.argv[1])
    tokenizer = Tokenizer.from_file(str(tokenizer_path))
    tokenizer_hash = hashlib.sha256(tokenizer_path.read_bytes()).hexdigest()
    reports = []
    for filename in sys.argv[2:]:
        report = json.loads(Path(filename).read_text(encoding="utf-8"))
        results = report.pop("results")
        reports.append({**report, "tokenizerSha256": tokenizer_hash,
                        "results": {task: {side: summarize(samples, tokenizer) for side, samples in pair.items()}
                                    for task, pair in results.items()}})
    print(json.dumps(reports, ensure_ascii=False, indent=2))
