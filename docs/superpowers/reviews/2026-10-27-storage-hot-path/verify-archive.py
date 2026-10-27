"""Freeze file byte hashes, then verify working bytes AND staged/committed blobs.

python verify-archive.py --write
git add <evidence and driver>
python verify-archive.py                 # index
python verify-archive.py --ref HEAD      # committed bytes
The manifest excludes itself; no measurement files are reformatted.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MANIFEST = HERE / "integrity.json"
ORIGINALS = {
    "docs/superpowers/reviews/2026-10-27-storage-optimization-baseline.json":
        "463f36cf5fffc3d4ba303e3a94e06f551f397c66d68db2032d31ed9aefebfc6d",
    "docs/superpowers/reviews/2026-10-27-storage-optimization-baseline-context.json":
        "6e5961ced820d3d6baa0a882f2cd0a180d3535bb527ed886a8d77d7a5d853450",
}
DRIVER = "packages/server/src/application/session/execution/__test__/tool-operation-hot-path.bench.mjs"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if "--write" in sys.argv:
        paths = [p for p in HERE.rglob("*") if p.is_file() and p != MANIFEST]
        paths += [ROOT / p for p in [*ORIGINALS, DRIVER]]
        files = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in sorted(paths)}
        for name, expected in ORIGINALS.items():
            assert files[name] == expected, ("Original baseline changed", name)
        MANIFEST.write_text(json.dumps({"algorithm": "sha256", "files": files}, indent=2) + "\n",
                            encoding="utf-8", newline="\n")
        print("Recorded", len(files), "files")
    else:
        ref = sys.argv[sys.argv.index("--ref") + 1] if "--ref" in sys.argv else ""
        files = json.loads(MANIFEST.read_bytes())["files"]
        for name, expected in files.items():
            assert sha((ROOT / name).read_bytes()) == expected, ("Working bytes differ", name)
            blob = subprocess.check_output(["git", "-C", str(ROOT), "show", ref + ":" + name])
            assert sha(blob) == expected, ("Git bytes differ", name)
        manifest_blob = subprocess.check_output(["git", "-C", str(ROOT), "show",
            ref + ":" + MANIFEST.relative_to(ROOT).as_posix()])
        assert manifest_blob == MANIFEST.read_bytes(), "Manifest Git bytes differ"
        print("Verified", len(files), "working files and", ref or "index", "blobs; original baselines unchanged")
        print("Manifest SHA256:", sha(manifest_blob))


if __name__ == "__main__":
    main()
