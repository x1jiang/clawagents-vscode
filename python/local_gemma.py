"""Opt-in local Gemma installer. Standard library only; never runs on import.

Invoked by the extension after an explicit setup action. All files live in the
extension's storage, apart from read-only reuse of a verified Hugging Face cache.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import signal
import ssl
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import urllib.error
import urllib.parse
import zipfile

TAG = "b10826"
MIN_BUILD = 10809
REPO = "yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF"
REVISION = "190a31365a6b80a692349be34ccdac730cad4fe4"
MODEL_FILE = "gemma4-v2-Q4_K_M.gguf"
MODEL_SIZE = 7_381_381_664
MODEL_SHA = "0b9506cab36f7f818e34f9c0f5a3d6568d0b37100f3a3e1092e2eec3c4c96791"
SOURCE_SIZE = 37_334_592
SOURCE_SHA = "3bc8d55616e7dd1447283327631be9a9e7414e24f371303dfa0529668e4b1aed"
ASSETS = json.loads(Path(__file__).with_name("gemma_runtime_assets.json").read_text())


def emit(message: str, **fields):
    print(json.dumps({"message": message, **fields}), flush=True)


def allowed_url(url: str) -> bool:
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or "").lower()
    return (
        u.scheme == "https"
        and not u.username
        and not u.password
        and (
            host
            in {
                "github.com",
                "api.github.com",
                "codeload.github.com",
                "release-assets.githubusercontent.com",
                "huggingface.co",
            }
            or host.endswith(".huggingface.co")
            or host.endswith(".hf.co")
        )
    )


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_url(newurl):
            raise ValueError("Download redirect left the approved runtime/model hosts")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


def verified(path: Path, size: int, sha: str) -> bool:
    return path.is_file() and path.stat().st_size == size and digest(path) == sha


def download(url: str, dest: Path, size: int, sha: str):
    """Resume only a matching byte range; never expose an unverified final file."""
    if not allowed_url(url):
        raise ValueError("Unapproved download URL")
    if verified(dest, size, sha):
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    context = ssl.create_default_context()
    # python.org macOS installs may have no default CA bundle. Reuse the
    # existing sidecar certifi dependency; never disable certificate checks.
    if not os.getenv("SSL_CERT_FILE") and not os.getenv("SSL_CERT_DIR"):
        try:
            import certifi

            context.load_verify_locations(certifi.where())
        except ImportError:
            pass
    opener = urllib.request.build_opener(
        SafeRedirect(), urllib.request.HTTPSHandler(context=context)
    )
    for attempt in range(3):
        offset = part.stat().st_size if part.exists() else 0
        if offset >= size:
            if offset == size and digest(part) == sha:
                part.replace(dest)
                return
            part.unlink()
            offset = 0
        if shutil.disk_usage(dest.parent).free < size - offset + 512 * 1024 * 1024:
            raise RuntimeError(
                "Not enough free disk space for this download (plus 512 MB headroom)"
            )
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "ClawAgents-local-Gemma",
                "Accept-Encoding": "identity",
            },
        )
        if offset:
            req.add_header("Range", f"bytes={offset}-")
        try:
            with opener.open(req, timeout=30) as response:
                if offset and response.status == 206:
                    if not response.headers.get("Content-Range", "").startswith(
                        f"bytes {offset}-"
                    ):
                        raise ValueError("Server returned an incorrect resume range")
                elif response.status == 200:
                    offset = 0
                else:
                    raise ValueError(f"Unexpected download status {response.status}")
                received = offset
                last = 0.0
                with part.open("ab" if offset else "wb") as f:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        received += len(block)
                        if received > size:
                            raise ValueError("Download exceeds its pinned size")
                        f.write(block)
                        if time.monotonic() - last > 1:
                            emit(
                                f"Downloading {dest.name}: {received / size:.0%}",
                                bytes=received,
                                total=size,
                            )
                            last = time.monotonic()
            if not verified(part, size, sha):
                if part.stat().st_size == size:
                    part.unlink()
                    raise ValueError("SHA-256 verification failed")
                raise OSError("Download ended early; retrying from the last byte")
            part.replace(dest)
            return
        except (OSError, urllib.error.URLError) as exc:
            if attempt == 2:
                raise RuntimeError(
                    "Download interrupted; run setup again to resume"
                ) from exc
            emit("Download interrupted; resuming…")
            time.sleep(attempt + 1)


def safe_target(root: Path, name: str) -> Path:
    parts = PurePosixPath(name.replace("\\", "/"))
    if parts.is_absolute() or ".." in parts.parts or any(":" in p for p in parts.parts):
        raise ValueError("Unsafe archive path")
    target = root.joinpath(*parts.parts)
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("Archive path escapes installation directory")
    return target


def unpack(archive: Path, root: Path):
    """No archive-controlled writes outside root, special files, or zip symlinks."""
    root.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            for member in z.infolist():
                dest = safe_target(root, member.filename)
                if stat.S_ISLNK(member.external_attr >> 16):
                    raise ValueError("Archive contains a symlink")
                if member.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(member) as src, dest.open("wb") as out:
                        shutil.copyfileobj(src, out)
    else:
        with tarfile.open(archive) as tar:
            links = []
            for member in tar.getmembers():
                dest = safe_target(root, member.name)
                if member.isdir():
                    dest.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as src, dest.open("wb") as out:
                        shutil.copyfileobj(src, out)
                    dest.chmod(member.mode & 0o755)
                elif member.issym():
                    # Official Unix runtime archives include shared-library links.
                    target = safe_target(
                        root, str(PurePosixPath(member.name).parent / member.linkname)
                    )
                    links.append((dest, target))
                else:
                    raise ValueError("Archive contains an unsupported special file")
            while links:
                pending = []
                for dest, target in links:
                    if target.is_file():
                        dest.symlink_to(os.path.relpath(target, dest.parent))
                    else:
                        pending.append((dest, target))
                if len(pending) == len(links):
                    raise ValueError("Archive symlink target is missing or cyclic")
                links = pending


def run(command: list[str], timeout=30) -> str:
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        check=True,
    )
    return result.stdout


def probe(binary: str) -> tuple[bool, list[str]]:
    try:
        version = run([binary, "--version"])
        match = re.search(r"(?:build\s*[:=]?\s*|\bversion:\s*)(\d{4,})", version, re.I)
        # Version 0.4.0 builds report the build number in parentheses.
        if not match:
            match = re.search(r"\((\d{4,})\)", version)
        if not match or int(match[1]) < MIN_BUILD:
            return False, []
        output = run([binary, "--list-devices"])
        devices = re.findall(
            r"^\s*((?:MTL|Metal|CUDA|Vulkan|HIP|ROCm|SYCL)\w*)\s*:", output, re.M | re.I
        )
        return True, devices
    except (OSError, subprocess.SubprocessError):
        return False, []


def asset_candidates(system: str, machine: str) -> list[str]:
    arch = {"aarch64": "arm64", "arm64": "arm64", "amd64": "x64", "x86_64": "x64"}.get(
        machine.lower()
    )
    if not arch:
        return []
    if system == "Darwin":
        return [f"llama-{TAG}-bin-macos-{arch}.tar.gz"]
    if system == "Linux":
        return [
            f"llama-{TAG}-bin-ubuntu-vulkan-{arch}.tar.gz",
            f"llama-{TAG}-bin-ubuntu-{arch}.tar.gz",
        ]
    if system == "Windows":
        gpu = [f"llama-{TAG}-bin-win-vulkan-x64.zip"] if arch == "x64" else []
        return gpu + [f"llama-{TAG}-bin-win-cpu-{arch}.zip"]
    return []


def find_binary(root: Path) -> str | None:
    name = "llama-server.exe" if os.name == "nt" else "llama-server"
    return next((str(p.resolve()) for p in root.rglob(name) if p.is_file()), None)


def build_runtime(root: Path) -> str:
    """Other Unix / incompatible libc: build with existing compiler tools, no sudo."""
    root = root.resolve()
    build = root / f"build-{TAG}"
    cached = find_binary(build) if build.exists() else None
    if cached and probe(cached)[0]:
        return cached
    if not shutil.which("cmake") or not any(
        shutil.which(c) for c in ["c++", "g++", "clang++"]
    ):
        raise RuntimeError(
            "No compatible runtime binary. Install CMake and a C++ compiler on this host, then retry local setup."
        )
    if build.exists():
        shutil.rmtree(build)
    source = root / "downloads" / f"{TAG}-source.tar.gz"
    download(
        f"https://api.github.com/repos/ggml-org/llama.cpp/tarball/{TAG}",
        source,
        SOURCE_SIZE,
        SOURCE_SHA,
    )
    source_dir = root / "source"
    if source_dir.exists():
        shutil.rmtree(source_dir)
    unpack(source, source_dir)
    project = next(source_dir.iterdir())
    build = root / f"build-{TAG}"
    variants = ["CUDA", "CPU"] if shutil.which("nvcc") else ["CPU"]
    for variant in variants:
        emit(f"Building llama.cpp for {variant}; this can take several minutes")
        flags = [
            "-DGGML_CUDA=" + ("ON" if variant == "CUDA" else "OFF"),
            "-DGGML_NATIVE=OFF",
            "-DGGML_METAL=OFF",
            "-DGGML_VULKAN=OFF",
            "-DLLAMA_OPENSSL=OFF",
            "-DLLAMA_BUILD_UI=OFF",
            "-DLLAMA_USE_PREBUILT_UI=OFF",
            "-DLLAMA_BUILD_NUMBER=10826",
            "-DLLAMA_BUILD_COMMIT=73a43d1",
            "-DBUILD_SHARED_LIBS=OFF",
        ]
        try:
            run(["cmake", "-S", str(project), "-B", str(build), *flags], timeout=300)
            run(
                [
                    "cmake",
                    "--build",
                    str(build),
                    "--config",
                    "Release",
                    "--target",
                    "llama-server",
                    "-j",
                    str(min(os.cpu_count() or 2, 4)),
                ],
                timeout=1800,
            )
            binary = find_binary(build)
            if binary and probe(binary)[0]:
                return binary
        except (OSError, subprocess.SubprocessError) as exc:
            detail = str(getattr(exc, "stdout", "") or exc)[-2000:]
            emit(f"{variant} build did not succeed: {detail}")
    raise RuntimeError(
        "llama.cpp could not be built on this host. Install a compatible llama-server and retry setup."
    )


def prepare_runtime(root: Path) -> tuple[str, list[str]]:
    cpu = None
    existing = shutil.which("llama-server")
    if existing:
        usable, devices = probe(existing)
        if usable and devices:
            emit("Using the installed compatible llama.cpp runtime")
            return str(Path(existing).resolve()), devices
        if usable:
            cpu = str(Path(existing).resolve())
    for name in asset_candidates(platform.system(), platform.machine()):
        meta = ASSETS[name]
        archive = root / "downloads" / name
        dest = root / "runtimes" / name.split(".tar")[0].removesuffix(".zip")
        binary = find_binary(dest) if dest.exists() else None
        if not binary or not probe(binary)[0]:
            emit(f"Installing runtime: {name}")
            download(
                f"https://github.com/ggml-org/llama.cpp/releases/download/{TAG}/{name}",
                archive,
                meta["size"],
                meta["sha256"],
            )
            if dest.exists():
                shutil.rmtree(dest)
            unpack(archive, dest)
            binary = find_binary(dest)
        if binary:
            usable, devices = probe(binary)
            if usable and devices:
                return binary, devices
            if usable:
                cpu = binary
    if cpu and platform.system() == "Linux" and shutil.which("nvcc"):
        try:
            binary = build_runtime(root)
            return binary, probe(binary)[1]
        except RuntimeError as exc:
            emit(f"CUDA build unavailable; using CPU: {exc}")
    if cpu:
        return cpu, []
    binary = build_runtime(root)
    return binary, probe(binary)[1]


def prepare_model(root: Path) -> Path:
    emit("Checking for an existing Gemma Q4 model and verifying its SHA-256")
    hf = Path(
        os.environ.get("HF_HUB_CACHE")
        or Path(os.environ.get("HF_HOME") or Path.home() / ".cache/huggingface") / "hub"
    )
    cached = (
        hf
        / ("models--" + REPO.replace("/", "--"))
        / "snapshots"
        / REVISION
        / MODEL_FILE
    )
    if verified(cached, MODEL_SIZE, MODEL_SHA):
        emit("Reusing the verified Hugging Face model cache")
        return cached.resolve()
    model = root / "models" / MODEL_FILE
    download(
        f"https://huggingface.co/{REPO}/resolve/{REVISION}/{MODEL_FILE}",
        model,
        MODEL_SIZE,
        MODEL_SHA,
    )
    return model.resolve()


def setup_lock(root: Path):
    """Kernel-owned lock survives cancellation cleanly; no stale PID heuristics."""
    handle = (root / "setup.lock").open("a+b")
    try:
        if os.name == "nt":
            import msvcrt

            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError as exc:
        handle.close()
        raise RuntimeError(
            "Local Gemma setup is already running in another window."
        ) from exc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    lock = setup_lock(root)

    def cancelled(signum, frame):
        raise SystemExit(130)

    signal.signal(signal.SIGTERM, cancelled)
    try:
        binary, devices = prepare_runtime(root)
        model = prepare_model(root)
        manifest = {
            "binary": binary,
            "model": str(model),
            "devices": devices,
            "model_sha256": MODEL_SHA,
            "runtime_tag": TAG,
        }
        temp = root / "manifest.json.tmp"
        temp.write_text(json.dumps(manifest, indent=2))
        temp.replace(root / "manifest.json")
        emit("Gemma Q4 files are ready", ready=manifest)
    finally:
        lock.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        emit(str(exc), error=True)
        sys.exit(1)
