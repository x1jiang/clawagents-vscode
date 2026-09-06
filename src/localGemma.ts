import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { randomBytes } from "crypto";

export type GemmaManifest = { binary: string; model: string; devices: string[] };
export type GemmaState = { phase: "idle" | "preparing" | "starting" | "running" | "error"; message: string; endpoint?: string };

/** No model credentials, user LLAMA_ARG flags, or shell startup code reach this server. */
export function localGemmaEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "HF_HOME", "HF_HUB_CACHE", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (source[key]) out[key] = source[key];
  }
  out.PYTHONUNBUFFERED = "1";
  return out;
}

export function gemmaServerArgs(manifest: GemmaManifest, port: number, cpu = false, alias = "gemma4-agentic-v2"): string[] {
  return ["--model", manifest.model, "--alias", alias, "--host", "127.0.0.1", "--port", String(port),
    "--ctx-size", "16384", "--parallel", "1", "--jinja", "--temp", "0", "--top-p", "0.95", "--top-k", "64", "--repeat-penalty", "1.1",
    "--n-gpu-layers", cpu || !manifest.devices.length ? "0" : "auto", "--fit", "on",
    ...(cpu || !manifest.devices.length ? ["--device", "none"] : [])];
}

export function validManifest(value: unknown): value is GemmaManifest {
  const m = value as GemmaManifest;
  return !!m && typeof m.binary === "string" && path.isAbsolute(m.binary) && typeof m.model === "string" && path.isAbsolute(m.model) &&
    Array.isArray(m.devices) && m.devices.every(d => typeof d === "string") && fs.existsSync(m.binary) && fs.existsSync(m.model);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}

/** Upper bound on one readiness probe; the socket timeout below only covers idle gaps. */
const PROBE_DEADLINE_MS = 4000;

export async function serverHasModel(port: number, alias: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (value: boolean) => { if (!settled) { settled = true; clearTimeout(guard); resolve(value); } };
    const req = http.get({ host: "127.0.0.1", port, path: "/v1/models", timeout: 1500 }, response => {
      let data = "";
      // `destroy()` without an error emits only `close`, never `end`/`error`;
      // an oversized body from a port-race neighbour used to hang this
      // promise — and with it setup, cancel and stop — until window reload.
      response.on("data", b => { data += String(b); if (data.length > 65536) { response.destroy(); done(false); } });
      response.on("error", () => done(false));
      response.on("close", () => done(false));
      response.on("end", () => {
        try { done(response.statusCode === 200 && JSON.parse(data).data?.some((m: { id?: string; aliases?: string[] }) => m.id === alias || (Array.isArray(m.aliases) && m.aliases.includes(alias))) === true); }
        catch { done(false); }
      });
    });
    const guard = setTimeout(() => { req.destroy(); done(false); }, PROBE_DEADLINE_MS);
    guard.unref();
    req.on("timeout", () => { req.destroy(); done(false); });
    req.on("error", () => done(false));
    req.on("close", () => done(false));
  });
}

function stopProcess(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already stopped */ }
      }
    }, 3000);
    timer.unref();
  }
}

export class LocalGemmaManager {
  private child?: ChildProcess;
  private inFlight?: Promise<string>;
  private controller?: AbortController;
  private state: GemmaState = { phase: "idle", message: "Local Gemma has not been started." };
  constructor(private root: string, private script: string, private log: (line: string) => void,
              private changed: (state: GemmaState) => void = () => {}) {}

  get status(): GemmaState { return this.state; }
  private update(state: GemmaState): void { this.state = state; this.changed(state); }

  /** The caller must have received an explicit local-setup action. Never called on selection. */
  setup(python: string, signal?: AbortSignal): Promise<string> {
    if (this.state.phase === "running" && this.child?.exitCode === null && !this.child.signalCode) return Promise.resolve(this.state.endpoint!);
    if (this.inFlight) return this.inFlight;
    const controller = this.controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    this.inFlight = this.prepareAndStart(python, controller.signal).catch(err => {
      this.update({ phase: controller.signal.aborted ? "idle" : "error", message: controller.signal.aborted ? "Setup cancelled. Run setup again to resume downloads." : String(err.message || err) });
      throw err;
    }).finally(() => { signal?.removeEventListener("abort", cancel); this.inFlight = undefined; this.controller = undefined; });
    return this.inFlight;
  }

  private async prepareAndStart(python: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error("Setup cancelled");
    this.update({ phase: "preparing", message: "Preparing Gemma Q4 runtime and model…" });
    const manifest = await new Promise<GemmaManifest>((resolve, reject) => {
      const child = this.child = spawn(python, [this.script, "--root", this.root], {
        env: localGemmaEnv(), cwd: path.dirname(this.script), detached: process.platform !== "win32", windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let pending = "", detail = "", ready: unknown;
      const cancel = () => stopProcess(child);
      signal.addEventListener("abort", cancel, { once: true });
      child.stdout?.on("data", buf => {
        pending += buf.toString();
        if (pending.length > 65536) { detail = "Installer output exceeded limit"; stopProcess(child); return; }
        const lines = pending.split(/\r?\n/); pending = lines.pop() || "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (typeof event.message === "string") {
              detail = event.message.slice(0, 2000); this.log(detail);
              this.update({ phase: "preparing", message: detail });
            }
            if (event.ready) ready = event.ready;
          } catch { this.log(line.slice(0, 2000)); }
        }
      });
      child.stderr?.on("data", buf => { detail = buf.toString().slice(-2000); this.log(detail); });
      child.once("error", reject);
      child.once("close", code => {
        signal.removeEventListener("abort", cancel);
        if (this.child === child) this.child = undefined;
        if (signal.aborted) reject(new Error("Setup cancelled"));
        else if (code === 0 && validManifest(ready)) resolve(ready);
        else reject(new Error(detail || `Gemma installer exited with code ${code}`));
      });
    });
    let gpuError: unknown;
    for (const cpu of manifest.devices.length ? [false, true] : [true]) {
      if (signal.aborted) throw new Error("Setup cancelled");
      try { return await this.start(manifest, cpu, signal); }
      catch (err) {
        gpuError = err;
        if (signal.aborted || cpu) break;
        this.log(`GPU startup failed; trying CPU. ${String(err)}`);
      }
    }
    throw gpuError;
  }

  private async start(manifest: GemmaManifest, cpu: boolean, signal: AbortSignal): Promise<string> {
    const port = await freePort();
    // A random alias proves readiness came from this process, not a port-race neighbour.
    const alias = `gemma4-agentic-v2-${randomBytes(8).toString("hex")}`;
    const mode = cpu ? "CPU" : manifest.devices.map(device => /^MTL|^Metal/i.test(device) ? "Metal GPU" : /^CUDA/i.test(device) ? "CUDA GPU" : /^Vulkan/i.test(device) ? "Vulkan GPU" : device).join(", ");
    this.update({ phase: "starting", message: `Loading Gemma Q4 on ${mode}…` });
    const child = this.child = spawn(manifest.binary, gemmaServerArgs(manifest, port, cpu, `gemma4-agentic-v2,${alias}`), {
      env: localGemmaEnv(), cwd: path.dirname(manifest.binary), detached: process.platform !== "win32", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let detail = "", failure: Error | undefined;
    const collect = (b: Buffer) => { detail = (detail + b.toString()).slice(-4000); this.log(b.toString().slice(-2000)); };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    child.once("error", err => { failure = err; });
    child.once("exit", code => {
      if (this.child === child && this.state.phase === "running") {
        this.child = undefined;
        this.update({ phase: "error", message: `Local Gemma stopped (exit ${code}). Run local setup to restart.` });
      }
    });
    const cancel = () => stopProcess(child);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        if (signal.aborted) throw new Error("Setup cancelled");
        if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(failure?.message || detail || "Gemma server exited during startup");
        if (await serverHasModel(port, alias)) {
          const endpoint = `http://127.0.0.1:${port}/v1`;
          this.update({ phase: "running", message: `Gemma Q4 running on ${mode}.`, endpoint });
          return endpoint;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      throw new Error(`Gemma took too long to start. ${detail}`);
    } catch (err) {
      stopProcess(child);
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("close", () => resolve()); setTimeout(resolve, 4000).unref();
      });
      if (this.child === child) this.child = undefined;
      throw err;
    } finally { signal.removeEventListener("abort", cancel); }
  }

  stop(): void {
    this.controller?.abort();
    if (this.child) stopProcess(this.child);
    this.child = undefined;
    this.update({ phase: "idle", message: "Local Gemma stopped. Downloaded files are kept for next time." });
  }
  dispose(): void { this.stop(); }
}
