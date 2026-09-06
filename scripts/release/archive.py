"""Create portable release archives with executable permissions on Linux."""
import pathlib
import os
import sys
import tarfile
import time
import zipfile

source = pathlib.Path(sys.argv[1]).resolve(strict=True)
destination = pathlib.Path(sys.argv[2]).resolve()
build_epoch = int(os.environ.get("SOURCE_DATE_EPOCH", time.time()))
if not source.is_dir() or destination.is_relative_to(source):
    raise SystemExit("The archive must be outside the source directory")
for entry in source.rglob("*"):
    if entry.is_symlink() or not entry.resolve().is_relative_to(source):
        raise SystemExit(f"Unsafe archive entry: {entry}")


def portable(info):
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = build_epoch
    info.mode = 0o755 if info.isdir() or info.name.endswith(("/start.sh", "/runtime/bin/node")) else 0o644
    return info


if destination.suffix == ".zip":
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for entry in sorted(source.rglob("*")):
            if entry.is_file():
                archive.write(entry, entry.relative_to(source.parent).as_posix())
else:
    with tarfile.open(destination, "w:gz", compresslevel=6) as archive:
        archive.add(source, arcname=source.name, filter=portable)
print(destination.name)
