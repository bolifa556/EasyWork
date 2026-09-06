"""Extract only the runtime executable and license, without npm or SDK files."""
import pathlib
import shutil
import sys
import tarfile
import zipfile

archive_path = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2]).resolve()
prefix = sys.argv[3]
binary = "node.exe" if sys.argv[4] == "win32" else "bin/node"
if pathlib.PurePosixPath(prefix).name != prefix:
    raise SystemExit("Invalid runtime directory")
names = [f"{prefix}/{binary}", f"{prefix}/LICENSE"]
if archive_path.suffix == ".zip":
    with zipfile.ZipFile(archive_path) as archive:
        for name in names:
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(name) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
else:
    with tarfile.open(archive_path) as archive:
        for name in names:
            member = archive.getmember(name)
            if not member.isfile():
                raise SystemExit(f"Runtime entry is not a regular file: {name}")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
