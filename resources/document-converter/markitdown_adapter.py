"""One-request stdio adapter for EASY CODE's private document converter."""

from __future__ import annotations

import json
import pathlib
import sys


def main() -> int:
    request = json.loads(sys.stdin.read())
    input_path = pathlib.Path(request["inputPath"]).resolve(strict=True)
    output_path = pathlib.Path(request["outputPath"]).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    from markitdown import MarkItDown

    result = MarkItDown().convert(str(input_path))
    markdown = result.text_content or ""
    output_path.write_text(markdown, encoding="utf-8", newline="\n")
    print(json.dumps({"ok": True, "characters": len(markdown)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # The Node host turns this bounded response into a UI error.
        print(json.dumps({"ok": False, "error": str(error)[:2000]}, ensure_ascii=False))
        raise SystemExit(1)
