/** Env vars safe to forward into the sidecar / pip (avoid leaking secrets). */
const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERPROFILE",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "VIRTUAL_ENV",
  // Do not forward PYTHONPATH / PYTHONHOME / PYTHONSTARTUP — those can
  // inject code into the sidecar interpreter. Pick the binary via pythonPath.
  "PYTHONUSERBASE",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "CONDA_PYTHON_EXE",
  "CONDA_EXE",
  "PYENV_ROOT",
  "PYENV_VERSION",
  // Do not forward LD_*/DYLD_* or HTTP(S)_PROXY — poisoned shell profiles can
  // inject native libs or MITM provider traffic carrying API keys.
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
]);

export function curatedProcessEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (
      SAFE_ENV_KEYS.has(k) ||
      k.startsWith("LC_") ||
      k.startsWith("CONDA_") ||
      k.startsWith("PYENV_")
    ) {
      out[k] = v;
    }
  }
  return out;
}
