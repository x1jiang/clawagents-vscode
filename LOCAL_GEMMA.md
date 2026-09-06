# Optional local Gemma setup

Select **Gemma Agentic Q4 (coordinator)** in Settings, then choose **Set up / start locally** and confirm the download. Selecting a provider, opening Settings, and starting VS Code do **not** install a runtime or model. You can instead enter a remote endpoint and skip local setup entirely.

Setup uses the extension host. On a MacBook it runs on the Mac; in a Remote SSH / WSL / container workspace it runs on that host. Install the extension on the remote host when using Remote SSH. Browser-only VS Code without a Node extension host cannot run a local model.

The model is the pinned **gemma4-v2-Q4_K_M.gguf** from [yuxinlu1's Gemma agentic v2 repository](https://huggingface.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF), revision `190a31365a6b80a692349be34ccdac730cad4fe4`. The model download is **7,381,381,664 bytes**. Allow at least **12 GB free disk space** and preferably **16 GB RAM**; CPU inference will generally be slower than GPU inference. The upstream model's benchmark claims are not guarantees for this Q4 setup.

## What setup does

1. Reuses an installed llama.cpp runtime when compatible (build 10809 or later) and probes its devices.
2. If needed, installs SHA-256-verified official **b10826** binaries inside extension storage. It never uses `sudo` or changes the system package manager.
3. Reuses the exact verified Hugging Face cache entry when present, otherwise downloads the Q4 file. Interrupted downloads resume, and the final file is promoted only after its size and SHA-256 match.
4. Starts a loopback-only server on an available port with the native Gemma Jinja tool template, one 16K context slot, and automatic GPU memory fitting. It retries startup on CPU if GPU startup fails.
5. Checks the served model's identity and then updates the selected Gemma endpoint. If the user switches providers or edits the endpoint during setup, the installer keeps the files and leaves those settings alone.

## Hardware support

| Host | Automatic path |
|---|---|
| Apple Silicon / Intel macOS | Official macOS binary; use Metal when the runtime detects it, otherwise CPU |
| Linux x86-64 / ARM64 | Try Vulkan for supported NVIDIA, AMD or Intel GPUs, then CPU; use an existing compatible CUDA/ROCm/SYCL runtime when available |
| Linux with CUDA toolkit | If the available binary has no GPU backend, try a CUDA source build before CPU |
| Other Unix / incompatible prebuilt ABI | Build the pinned source using the host's existing CMake and C++ compiler; provide an actionable message if those tools are missing |
| Windows x64 / ARM64 | Vulkan on x64 when available; CPU fallback |

GPU drivers must already be installed. Setup does not install drivers, CUDA toolkits or operating-system build tools. A source build can take several minutes. Other Unix systems must support the VS Code extension host, Python and llama.cpp; compatibility is not guaranteed for every OS/architecture combination.

## Controls and storage

Progress appears in Settings and in a cancellable VS Code notification. Runtime diagnostics appear in the ClawAgents output channel. **Cancel setup** preserves partial downloads. **Stop local Gemma** stops only the process owned by this extension window. Closing or reloading the extension stops its managed server; choose **Set up / start locally** again to reuse the files and restart it. It does not auto-start or auto-install on provider selection.

The command palette also has **ClawAgents: Set Up / Start Local Gemma** and **ClawAgents: Stop Local Gemma**. The setup command requires Gemma to be selected first.

Files live under the extension's global-storage `gemma-local` directory. A kernel file lock prevents competing installer writes across windows. Separate windows own separate server processes and ports. No cloud model credentials or user-supplied `LLAMA_ARG_*` overrides are forwarded to the managed server.

## Validation

The Mac smoke checks cover a fresh official-runtime download with checksum verification, cached-model reuse, a CPU source build with no optional UI download, Metal startup, CPU startup using the downloaded runtime, native tool calling and owned-process shutdown. Automated tests cover platform selection, missing build tools, safe extraction, download resume/integrity, cancellation, readiness, GPU-to-CPU retry and credential isolation. Linux/Windows/other-Unix selection paths are tested with fixtures; they are not hardware certifications.
