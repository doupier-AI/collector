"""Download only missing or invalid public Issue #122 source PDFs, then verify them."""
from __future__ import annotations
import hashlib
import json
import urllib.request
from pathlib import Path
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "sources" / "manifest.json"

def valid(path: Path, item: dict) -> bool:
    if not path.exists() or path.stat().st_size != item["bytes"]:
        return False
    if hashlib.sha256(path.read_bytes()).hexdigest().upper() != item["expectedSha256"]:
        return False
    return len(PdfReader(path).pages) == item["pages"]

def main() -> None:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for item in data["sources"]:
        target = ROOT / "sources" / item["cacheFile"]
        if valid(target, item):
            print(f"verified {target.name}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".download")
        try:
            with urllib.request.urlopen(item["downloadUrl"], timeout=60) as response, temporary.open("wb") as output:
                expected_bytes = item["bytes"]
                content_length = response.headers.get("Content-Length")
                if content_length is not None and int(content_length) != expected_bytes:
                    raise RuntimeError(
                        f"Unexpected Content-Length for {item['id']}: "
                        f"{content_length} (expected {expected_bytes})"
                    )
                while chunk := response.read(min(1024 * 1024, expected_bytes + 1 - output.tell())):
                    output.write(chunk)
                    if output.tell() > expected_bytes:
                        raise RuntimeError(f"Download exceeded manifest byte length: {item['id']}")
            if not valid(temporary, item):
                raise RuntimeError(f"Downloaded file did not match manifest: {item['id']}")
            temporary.replace(target)
            print(f"downloaded and verified {target.name}")
        finally:
            temporary.unlink(missing_ok=True)

if __name__ == "__main__":
    main()
