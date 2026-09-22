"""One-request stdio adapter for EASY CODE's private document converter."""

from __future__ import annotations

import json
import pathlib
import sys
from urllib.parse import urljoin, urlparse


def prepare_web_html(input_path: pathlib.Path, source_url: str) -> str | None:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(input_path.read_bytes(), "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else None
    base_tag = soup.find("base", href=True)
    base_url = urljoin(source_url, base_tag["href"]) if base_tag else source_url
    if urlparse(base_url).scheme not in ("http", "https"):
        base_url = source_url
    for element in soup.find_all(["a", "img", "source"]):
        for attribute in ("href", "src", "data-src"):
            value = element.get(attribute)
            if not isinstance(value, str) or not value.strip():
                continue
            resolved = urljoin(base_url, value.strip())
            if urlparse(resolved).scheme in ("http", "https"):
                element[attribute] = resolved
    input_path.write_bytes(str(soup).encode("utf-8"))
    return title


def main() -> int:
    request = json.loads(sys.stdin.read())
    input_path = pathlib.Path(request["inputPath"]).resolve(strict=True)
    output_path = pathlib.Path(request["outputPath"]).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    from markitdown import MarkItDown

    html_title = None
    if request.get("sourceUrl") and input_path.suffix.lower() in (".html", ".htm"):
        html_title = prepare_web_html(input_path, request["sourceUrl"])
    result = MarkItDown().convert(str(input_path))
    markdown = result.text_content or ""
    output_path.write_text(markdown, encoding="utf-8", newline="\n")
    print(json.dumps({"ok": True, "characters": len(markdown), "title": html_title or result.title}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # The Node host turns this bounded response into a UI error.
        print(json.dumps({"ok": False, "error": str(error)[:2000]}))
        raise SystemExit(1)
