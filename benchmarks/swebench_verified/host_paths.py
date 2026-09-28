"""Native host filesystem paths. Never use extended Windows paths inside Docker."""
import os
from pathlib import Path


def host_path(value: Path) -> Path:
    """Use extended-length paths for all descendants, even with long paths disabled."""
    value = Path(os.path.abspath(value))
    if os.name != "nt" or str(value).startswith("\\\\?\\"):
        return value
    text = str(value)
    return Path("\\\\?\\UNC\\" + text[2:] if text.startswith("\\\\") else "\\\\?\\" + text)
