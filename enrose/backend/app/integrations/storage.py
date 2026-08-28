"""Media storage behind one interface.

`S3Storage` targets any S3-compatible endpoint (AWS S3, Cloudflare R2).
`LocalStorage` writes to disk so the product runs with no cloud account at all.
Selection is by configuration; the caller records which provider handled the file.
"""

from __future__ import annotations

import os
import shutil
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from app.config import settings


@dataclass
class StoredFile:
    key: str
    url: str
    provider: str
    size_bytes: int


class Storage(ABC):
    name: str

    @abstractmethod
    def put(self, fileobj: BinaryIO, *, key: str, content_type: str | None = None) -> StoredFile: ...

    @abstractmethod
    def url_for(self, key: str) -> str: ...

    @abstractmethod
    def delete(self, key: str) -> bool: ...

    @staticmethod
    def build_key(client_id: uuid.UUID, filename: str, prefix: str = "assets") -> str:
        safe = "".join(c for c in filename if c.isalnum() or c in "._-") or "file"
        return f"{prefix}/{client_id}/{uuid.uuid4().hex[:12]}-{safe}"


class LocalStorage(Storage):
    """Disk-backed storage for development and self-hosting."""

    name = "local"

    def __init__(self, root: str | None = None, public_base: str | None = None) -> None:
        self.root = Path(root or settings.storage_local_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.public_base = (public_base or f"{settings.api_base_url}/api/v1/assets/file").rstrip("/")

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        # Reject any key that escapes the storage root.
        if not str(path).startswith(str(self.root)):
            raise ValueError("Invalid storage key")
        return path

    def put(self, fileobj: BinaryIO, *, key: str, content_type: str | None = None) -> StoredFile:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as out:
            shutil.copyfileobj(fileobj, out)
        return StoredFile(
            key=key, url=self.url_for(key), provider=self.name, size_bytes=path.stat().st_size
        )

    def url_for(self, key: str) -> str:
        return f"{self.public_base}/{key}"

    def delete(self, key: str) -> bool:
        path = self._path(key)
        if path.exists():
            path.unlink()
            return True
        return False

    def read(self, key: str) -> bytes:
        return self._path(key).read_bytes()


class S3Storage(Storage):
    """S3-compatible object storage (AWS S3, Cloudflare R2)."""

    name = "s3"

    def __init__(self) -> None:
        try:
            import boto3
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("boto3 is required for S3 storage") from exc

        self._bucket = settings.storage_bucket
        self._client = boto3.client(
            "s3",
            region_name=settings.storage_region or None,
            endpoint_url=settings.storage_endpoint_url or None,
            aws_access_key_id=settings.storage_access_key_id or None,
            aws_secret_access_key=settings.storage_secret_access_key or None,
        )

    def put(self, fileobj: BinaryIO, *, key: str, content_type: str | None = None) -> StoredFile:
        extra = {"ContentType": content_type} if content_type else {}
        self._client.upload_fileobj(fileobj, self._bucket, key, ExtraArgs=extra or None)
        head = self._client.head_object(Bucket=self._bucket, Key=key)
        return StoredFile(
            key=key, url=self.url_for(key), provider=self.name, size_bytes=head.get("ContentLength", 0)
        )

    def url_for(self, key: str) -> str:
        if settings.storage_public_base_url:
            return f"{settings.storage_public_base_url.rstrip('/')}/{key}"
        # No public base configured, so hand back a time-limited signed URL.
        return self._client.generate_presigned_url(
            "get_object", Params={"Bucket": self._bucket, "Key": key}, ExpiresIn=3600
        )

    def delete(self, key: str) -> bool:
        self._client.delete_object(Bucket=self._bucket, Key=key)
        return True


def get_storage() -> Storage:
    if settings.storage_live:
        return S3Storage()
    return LocalStorage()


def probe_media(path: str) -> dict[str, float | int | None]:
    """Best-effort media metadata via ffprobe.

    Returns nulls when FFmpeg is unavailable rather than guessing — a fabricated
    duration would corrupt the footage analyst's cut points.
    """
    import json
    import subprocess

    if not shutil.which("ffprobe"):
        return {"duration_s": None, "width": None, "height": None}
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_format", "-show_streams", path,
            ],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout
        data = json.loads(out)
        duration = float(data.get("format", {}).get("duration", 0)) or None
        video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
        return {
            "duration_s": duration,
            "width": video.get("width"),
            "height": video.get("height"),
        }
    except (subprocess.SubprocessError, ValueError, KeyError, OSError):
        return {"duration_s": None, "width": None, "height": None}
