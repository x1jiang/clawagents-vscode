"""Installer tests use fixture downloads and never fetch a model."""

import hashlib
import io
import tarfile

import pytest
import local_gemma as g


@pytest.mark.parametrize(
    "system,machine,gpu,cpu",
    [
        ("Darwin", "arm64", "macos-arm64", "macos-arm64"),
        ("Darwin", "x86_64", "macos-x64", "macos-x64"),
        ("Linux", "x86_64", "ubuntu-vulkan-x64", "ubuntu-x64"),
        ("Linux", "aarch64", "ubuntu-vulkan-arm64", "ubuntu-arm64"),
        ("Windows", "AMD64", "win-vulkan-x64", "win-cpu-x64"),
    ],
)
def test_platform_candidates_have_verified_assets(system, machine, gpu, cpu):
    names = g.asset_candidates(system, machine)
    assert gpu in names[0]
    assert cpu in names[-1]
    for n in names:
        assert len(g.ASSETS[n]["sha256"]) == 64
        assert g.ASSETS[n]["size"] > 0


def test_other_unix_uses_source_fallback():
    assert g.asset_candidates("FreeBSD", "amd64") == []
    assert g.asset_candidates("Linux", "riscv64") == []


@pytest.mark.parametrize(
    "url",
    [
        "http://huggingface.co/x",
        "https://github.com.evil.test/x",
        "https://user:secret@github.com/x",
        "file:///tmp/model",
    ],
)
def test_download_hosts_fail_closed(url):
    assert not g.allowed_url(url)


def test_download_host_positive_control():
    assert g.allowed_url("https://release-assets.githubusercontent.com/file")
    assert g.allowed_url("https://cas-bridge.xethub.hf.co/file")


@pytest.mark.parametrize("device", ["MTL0", "CUDA0", "Vulkan0", "HIP0", "SYCL0"])
def test_real_device_probe_ignores_blas(monkeypatch, device):
    monkeypatch.setattr(
        g,
        "run",
        lambda args, **kw: "version: 0.4.0 (build 10809, commit abc)"
        if "--version" in args
        else f"Available devices:\n BLAS: Accelerate\n {device}: GPU (123 MiB free)",
    )
    assert g.probe("/runtime/server") == (True, [device])


def test_cpu_probe_and_outdated_runtime(monkeypatch):
    monkeypatch.setattr(
        g,
        "run",
        lambda args, **kw: "version: 0.4.0 (build 10809)"
        if "--version" in args
        else "Available devices:\n BLAS: CPU",
    )
    assert g.probe("server") == (True, [])
    monkeypatch.setattr(g, "run", lambda args, **kw: "version: 9000")
    assert g.probe("server") == (False, [])


def test_existing_gpu_skips_install(monkeypatch, tmp_path):
    monkeypatch.setattr(g.shutil, "which", lambda _: "/installed/llama-server")
    monkeypatch.setattr(g, "probe", lambda _: (True, ["CUDA0"]))
    monkeypatch.setattr(g, "download", lambda *a: pytest.fail("unexpected download"))
    assert g.prepare_runtime(tmp_path) == ("/installed/llama-server", ["CUDA0"])


def test_unix_missing_build_tools_is_actionable(monkeypatch, tmp_path):
    monkeypatch.setattr(g.shutil, "which", lambda _: None)
    with pytest.raises(RuntimeError, match="CMake and a C\\+\\+ compiler"):
        g.build_runtime(tmp_path)


@pytest.mark.parametrize(
    "name", ["../outside", "/outside", "C:/outside", "..\\outside"]
)
def test_archive_traversal_rejected(tmp_path, name):
    with pytest.raises(ValueError):
        g.safe_target(tmp_path, name)


def test_unpack_regular_file_and_safe_library_symlink(tmp_path):
    archive = tmp_path / "files.tar.gz"
    with tarfile.open(archive, "w:gz") as t:
        info = tarfile.TarInfo("bin/lib.so.1")
        info.size = 2
        t.addfile(info, io.BytesIO(b"OK"))
        alias = tarfile.TarInfo("bin/alias.so")
        alias.type = tarfile.SYMTYPE
        alias.linkname = "lib.so"
        t.addfile(alias)
        link = tarfile.TarInfo("bin/lib.so")
        link.type = tarfile.SYMTYPE
        link.linkname = "lib.so.1"
        t.addfile(link)
    g.unpack(archive, tmp_path / "out")
    assert (tmp_path / "out/bin/lib.so").read_bytes() == b"OK"


def test_unpack_bad_symlink_rejected(tmp_path):
    archive = tmp_path / "bad.tar"
    with tarfile.open(archive, "w") as t:
        link = tarfile.TarInfo("escape")
        link.type = tarfile.SYMTYPE
        link.linkname = "../outside"
        t.addfile(link)
    with pytest.raises(ValueError):
        g.unpack(archive, tmp_path / "out")


class Response(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}


def fake_download(monkeypatch, data, status=200, headers=None):
    requests = []

    class Opener:
        def open(self, req, **kwargs):
            requests.append(req)
            return Response(data, status, headers)

    monkeypatch.setattr(g.urllib.request, "build_opener", lambda *a: Opener())
    return requests


def test_resume_download_checks_range_and_hash(monkeypatch, tmp_path):
    dest = tmp_path / "model"
    dest.with_suffix(".part").write_bytes(b"abc")
    requests = fake_download(monkeypatch, b"def", 206, {"Content-Range": "bytes 3-5/6"})
    g.download(
        "https://huggingface.co/file", dest, 6, hashlib.sha256(b"abcdef").hexdigest()
    )
    assert requests[0].get_header("Range") == "bytes=3-"
    assert dest.read_bytes() == b"abcdef"
    assert not dest.with_suffix(".part").exists()


def test_range_ignored_restarts_without_appending(monkeypatch, tmp_path):
    dest = tmp_path / "model"
    dest.with_suffix(".part").write_bytes(b"bad")
    fake_download(monkeypatch, b"abcdef")
    g.download(
        "https://huggingface.co/file", dest, 6, hashlib.sha256(b"abcdef").hexdigest()
    )
    assert dest.read_bytes() == b"abcdef"


def test_bad_hash_never_promotes_model(monkeypatch, tmp_path):
    dest = tmp_path / "model"
    fake_download(monkeypatch, b"abcdef")
    with pytest.raises(ValueError, match="SHA-256"):
        g.download("https://huggingface.co/file", dest, 6, "0" * 64)
    assert not dest.exists()
    assert not dest.with_suffix(".part").exists()


def test_resume_wrong_range_rejected(monkeypatch, tmp_path):
    dest = tmp_path / "model"
    dest.with_suffix(".part").write_bytes(b"abc")
    fake_download(monkeypatch, b"def", 206, {"Content-Range": "bytes 0-2/6"})
    with pytest.raises(ValueError, match="incorrect resume range"):
        g.download(
            "https://huggingface.co/file",
            dest,
            6,
            hashlib.sha256(b"abcdef").hexdigest(),
        )
    assert not dest.exists()


def test_cached_model_verified_before_reuse(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "cache"))
    file = (
        tmp_path
        / "cache"
        / ("models--" + g.REPO.replace("/", "--"))
        / "snapshots"
        / g.REVISION
        / g.MODEL_FILE
    )
    file.parent.mkdir(parents=True)
    file.write_bytes(b"fixture")
    monkeypatch.setattr(g, "MODEL_SIZE", 7)
    monkeypatch.setattr(g, "MODEL_SHA", hashlib.sha256(b"fixture").hexdigest())
    monkeypatch.setattr(g, "download", lambda *a: pytest.fail("cache should be reused"))
    assert g.prepare_model(tmp_path / "storage") == file.resolve()


def test_setup_lock_is_exclusive_and_released(tmp_path):
    first = g.setup_lock(tmp_path)
    try:
        with pytest.raises(RuntimeError, match="another window"):
            g.setup_lock(tmp_path)
    finally:
        first.close()
    second = g.setup_lock(tmp_path)
    second.close()


def test_source_build_pins_version_and_disables_optional_downloads(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(
        g.shutil, "which", lambda name: "/tools/" + name if name != "nvcc" else None
    )
    monkeypatch.setattr(g, "download", lambda *args: None)

    def unpack(archive, dest):
        (dest / "project").mkdir(parents=True)

    monkeypatch.setattr(g, "unpack", unpack)
    binary = tmp_path / f"build-{g.TAG}" / "llama-server"
    commands = []

    def run(args, **kw):
        commands.append(args)
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.write_bytes(b"fixture")
        return ""

    monkeypatch.setattr(g, "run", run)
    monkeypatch.setattr(g, "probe", lambda _: (True, []))
    assert g.build_runtime(tmp_path) == str(binary.resolve())
    configure = commands[0]
    assert "-DLLAMA_BUILD_NUMBER=10826" in configure
    assert "-DLLAMA_BUILD_UI=OFF" in configure
    assert "-DLLAMA_USE_PREBUILT_UI=OFF" in configure
    assert "-DGGML_CUDA=OFF" in configure
    assert "-DLLAMA_OPENSSL=OFF" in configure
    commands.clear()
    assert g.build_runtime(tmp_path) == str(binary.resolve())
    assert commands == []
