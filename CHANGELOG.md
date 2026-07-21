## 1.0.135

- Require `clawagents>=6.20.44` — Mantle frontier models (GPT-5.x / Grok) use
  base `…/openai/v1` (fixes bare `…/openai` → HTTP 404 on Responses). GPT-5.6
  Sol is only in `us-east-1` / `us-east-2`.

## 1.0.134

- Mantle catalog list prices from AWS Bedrock US Standard for Grok, DeepSeek,
  Kimi, GLM, GPT-OSS / Safeguard (dropdown `· $in/$out per 1M` + cost estimates).

## 1.0.133

- Require `clawagents>=6.20.43` — Mantle `xai.grok-4.3` uses `/openai/v1`
  Responses (fixes Berm `access_denied` on plain `…/v1` chat). Catalog label
  and `mantleWireApiForModel` mark Grok as openai/v1 + responses.

## 1.0.132

- Require `clawagents>=6.20.42` for lower-churn patch recovery, explicit refusal
  of unauthorized unsandboxed execution, sandbox-compatible gcloud guidance,
  profile-preserving command auto-backgrounding, and retained PTY exit screens.

## 1.0.131

- Require `clawagents>=6.20.41` so repeated same-name skill calls advance the
  pending load, disallowed tools get accurate boundary guidance, and nonzero
  `npm audit` reports are classified as security findings without unsafe retry.
  External-action policy is framework-generic, and reconciliation commands
  cannot mutate state or repeat the action they are meant to verify.

## 1.0.130

- Require `clawagents>=6.20.40` — external publish/deploy actions now require
  approved pre-action verification and post-action reconciliation. Attempts
  consume authorization before execution, so failures, crashes, and timeouts
  cannot permit unsafe retries or premature completion.

## 1.0.129

- Require `clawagents>=6.20.39` so Context Mode rejects binary inputs to
  `ctx_execute_file` before UTF-8 decoding, gives actionable routing guidance,
  and avoids duplicating MCP error details in the tool card.

## 1.0.128

- Require `clawagents>=6.20.38` — stable OpenAI prompt-cache affinity, incremental
  token ledger, TTFT/RSS telemetry, Gemini cache-read accounting, and bounded
  streaming exec head/tail output.

## 1.0.127

- Install the existing `pty` extra (`pexpect` + `pyte`) in managed sidecars so
  interactive commands such as `gcloud auth login` can start successfully.

## 1.0.126

- Require `clawagents>=6.20.37` so approved Plan invariants remain enforceable
  in Act mode: publish/deploy commands now require fresh successful verification
  gates after the latest edit, with pending/corrupt contracts failing closed.

## 1.0.125

- Require `clawagents>=6.20.36` — permit one literal `/tmp/<name>` cleanup while retaining destructive-delete guards for broad, dynamic, and system paths.
- Avoid false encoded-Python blocks, normalize empty `grep`/`rg` searches, and add quarantine/missing-file recovery guidance.
- Distinguish a missing runtime executable (for example `kinit`) from secondary cleanup failures such as a missing `kdestroy`.
- Report the exact failed SEARCH/REPLACE hunk and reject invalid JSON before `apply_patch` writes it.
- Show the first differing character for near matches and distinguish Markdown list items from table rows instead of reporting a rounded 100% similarity.
- Explain empty `&&`-chain failures whose useful output was redirected to a log, without treating advisory safety warnings as the cause.
- Separate missing-input root causes from empty-JSON cascade errors in shell loops and preserve successful iterations in the diagnosis.
- Treat `ModuleNotFoundError` as an interpreter/environment mismatch and recommend same-interpreter virtualenv checks before installation.

## 1.0.124

- Add failure discipline for authentication, missing packages, patch rereads, and secret-safe `.env` handling.
- Require `clawagents>=6.20.35` — default three-failure rethink guard, structured failure classification, shell-secret redaction, and heredoc-safe shell sessions.

## 1.0.123

- Prefer engine `output` / `ui_output` over short `preview` for tool cards (shows stderr on long execute failures).
- Require `clawagents>=6.20.34` — 8KB UI tool results, execute failure reorder, single-file Codex `apply_patch`.

## 1.0.122

- **CRLF-safe API keys / `.env`:** `sanitizeApiKey` and workspace dotenv strip `\r`/`\n` so Windows CRLF secrets cannot corrupt headers or SMB passwords.
- Require `clawagents>=6.20.33` — `/tmp` `write_file` sandbox parity + secret CR scrub + `python3` verify preference.

## 1.0.121

- Hide OpenViking (and ByteRover) from Skills Settings preview — not used; already excluded at runtime.

## 1.0.120

- **Graphify UX hardened:** Build graph defaults to `extract --code-only` (offline); verify `graph.json` after run; Augment = `update`; Use existing `graphify-out`; Settings panel with status + explicit actions.
- Sidecar `GET /graphify/status`; package probe no longer fails when clawagents heavy imports lack openai.
- Require clawagents≥6.20.32.

## 1.0.119

- **Native Graphify companion** (clawagents≥6.20.31): settings toggle, MCP `query_graph` / path tools, diagnostics, Ensure Companions installs `graphifyy[mcp]` into sidecar Python.
- Commands: Graphify Extract/Update Workspace; optional Append AGENTS.md block.
- Graph path: `.clawagents/graphify/graph.json` (or custom / `graphify-out/`).

## 1.0.118

- Extension-managed Python virtualenv by default; custom interpreter remains available.
- Multi-root workspace selector with root-scoped sidecar, `.env`, chats, and trust state.
- Revisioned settings acknowledgements prevent stale saves from replacing newer edits; sync logic extracted and tested.
- VSIX excludes test suites and local Ruff caches.

## 1.0.117

- **Overlap-safe read reuse** (clawagents≥6.20.30): stub only when the new range is fully contained; partial overlaps fetch fresh content.
- **Accurate tokens:** sidecar installs `accurate-tokens` (tiktoken); diagnostics report active estimator.
- **Long-session scale:** paginated UI logs (tail/before), transcript virtualization + load-older, bounded SSE queue.
- Mode tool profiles (read-only / coding / goal); CI release gate (typecheck, Node/Python tests, VSIX, floor).

## 1.0.116

- Per-request cost summing (no false >272K cliff on run totals); request/max/long-context stats
- Three-number token header: current · run · next est; require clawagents≥6.20.29

## 1.0.115

- **Luna efficiency:** reject compact that grows context; charge compact usage/cost; context meter uses last-request tokens (not run-cumulative); GPT-5.6 >272K long-context pricing (2× input / 1.5× output); tool-efficiency turn guidance.
- Require `clawagents>=6.20.28` — economic compaction threshold + GPT-5.6 harness.

## 1.0.114

- **Cache-aware usage/cost:** thread `cached_input_tokens` / `cache_creation_tokens` into usage payload + UI; `estimate_usd` applies cache-read discount (and write premium). Header shows **cache N%** when hits are reported.
- Require `clawagents>=6.20.27` — `UsageEvent` exposes cache fields.

## 1.0.113

- **Plan mode (Grok Build parity):** explore + `write_plan` → `exit_plan_mode` shows Approve / Request changes / Reject; Approve unlocks the run and switches to Act.
- Require `clawagents>=6.20.26` — UI Plan maps to engine `PermissionMode.PLAN` with plan-file exemptions.


## 1.0.112

- Default Auto-approve: **Edit** + **Execute** on (Web/Browser still off).


## 1.0.111

- Require `clawagents>=6.20.25` — YAML skill frontmatter + nested shlex guard.

## 1.0.110

- Hotfix: restore Bedrock kwargs under `elif use_bedrock` (1.0.108 nested them under `else`, leaving a dangling `elif` → sidecar SyntaxError).

## 1.0.109

- Require `clawagents>=6.20.24` — Bedrock geo id tighten + skill drain preflight.
- `applyBedrockMode` resets `wire_api` to `auto` for bag/iam (not only mantle).

## 1.0.108

- Require `clawagents>=6.20.23` — skill tool filtering + aliases, apply_patch matching, MCP reconnect/timeout, compaction tool_calls_meta fix; clear `pendingSettingsPatch` on save error; Bedrock AWS env clear + wire_api reset on leave.

## 1.0.107

- Require `clawagents>=6.20.22` — Responses retry de-nest, `$ref`/`anyOf` schemas, model-prefix classifiers; post-install floor re-probe.

## 1.0.106

- Require `clawagents>=6.20.21` — nested array-of-object MCP/tool schemas (Gemini 400 fix); model-identity system prompt line.

## 1.0.105

- Require `clawagents>=6.20.20` — `use_skill(continue=true)`, code-before-html crush, `retrieve_tool_result` under skill gate.

## 1.0.104

- Hard heal: never show vendor-mismatched models in the header (e.g. ``llama3.1`` under OpenAI); sidecar ``load_settings`` rewrites leftovers on disk.

## 1.0.103

- Require `clawagents>=6.20.19` — never crush skill/control-plane tool outputs; post-edit syntax gate on write tools.

## 1.0.102

- Auto-heal saved model leftovers that cannot belong to the selected provider (e.g. ``llama3.1`` under OpenAI → preferred GPT) on load — not only on Provider switch.

## 1.0.101

- Require `clawagents>=6.20.18` — chat_mode↔sandbox contract, failed-tool no-crush, EPERM auto-retry under Full access.
- Sidecar passes `chat_mode` / `allow_full_access` into `create_claw_agent` (no ad-hoc sandbox_profile=off).

## 1.0.100

- Composer Auto-approve panel: **Full access** checkbox (same as Settings) — enables Edit/Execute, sets ``mode=full_access``, disables OS sandbox for gcloud/deploy.

## 1.0.99

- Require `clawagents>=6.20.17` — seatbelt ``/dev/null`` allow + clearer sandbox hints.
- ``mode=full_access`` + Settings → Allow Full Access now sets ``sandbox_profile=off`` (gcloud/deploy can use ``~/.config``).
- Checkbox label clarifies Full Access also disables the OS sandbox.

## 1.0.98

- Provider switch: reset incompatible leftover models (e.g. Ollama ``llama3.1`` when switching to OpenAI) instead of sending them to api.openai.com (404).
- Sidecar: clear error when Provider=OpenAI + Model is an Ollama-style id.

## 1.0.97

- Require `clawagents>=6.20.16` — ``snapshot_diff`` ``showing 40 of N`` file-cap note.

## 1.0.96

- Require `clawagents>=6.20.15` — skill-loading auto-continuation (no refusal loop / mid-load deadlock); ``use_skill(abort=true)``.

## 1.0.95

- Require `clawagents>=6.20.14` — strict apply_patch (empty REPLACE / fence guard), ``snapshot_diff``, code crush floor, /tmp sandbox allow.

## 1.0.94

- Require `clawagents>=6.20.13` — clearer non-repo git notices, hashline malformed-anchor samples, execute git-128 interpretation (fewer scary fails outside git repos).

## 1.0.93

- **Cost estimates:** Mantle/Bedrock Claude uses commercial Global rates ($5/$25 Opus), not the GovCloud row ($6/$30) that was scraped from the pricing page by mistake.

## 1.0.92

- **Catalog merge:** on zero curated∩live overlap, prefer the live ``/models`` list instead of advertising the full unconfirmed curated set.

## 1.0.91

- **Cost estimates for Bedrock / Mantle:** price table + prefix strip so Mantle ids match (Opus briefly used GovCloud \$6/\$30 by mistake; corrected to commercial Global \$5/\$25 in 1.0.93). Unknown models omit ``~$0.00`` instead of faking zero.

## 1.0.90

- Require `clawagents>=6.20.12` — Mantle GPT-5.6 Luna / Responses omit deprecated ``temperature``; bare ``gpt-5.6-*`` → ``openai.gpt-5.6-*`` (fixes 400 + 404).

## 1.0.89

- Require `clawagents>=6.20.11` — Claude Opus 4.7+ / Mantle Messages omit deprecated ``temperature`` (fixes 400 on Opus 4.8).

## 1.0.88

- **Key-flag hardening:** host `collectKeyFlags()` (SecretStorage + `.env` + shell) attached to every `settings` / `verify_result` after save/clear; webview no longer parses "saved"/"cleared" from detail text (that falsely cleared OpenAI after Clear when `.env` still had a key).
- **Catalog probe:** present OpenAI/Anthropic/Gemini credentials stay `available` even if live `/models` returns 401 REJECTED.
- **Probe keys** for Test connection resolve the same SecretStorage → `.env` → shell order as sidecar spawn.
- Fallback catalog no longer marks Ollama as "(no key)".

## 1.0.87

- **Provider menu "(no key)"**: honor host SecretStorage / workspace `.env` over a stale sidecar catalog probe (OpenAI can show no key while turns still work).
- **Chat header**: show effective provider next to the model picker (e.g. OpenAI · GPT-5.6 Luna).

## 1.0.86

- Require `clawagents>=6.20.10` (canonical model classifier + PromptHook/PROVIDER fixes).
- **Send/settings race:** flush pending save before send; host awaits `saveSettingsChain`.
- **Bedrock availability:** IAM / Mantle / Gateway use separate cred flags (not one OR).
- **provider=auto** applies Bedrock/Mantle wiring for Bedrock-shaped models.
- Test-endpoint probe serialized + abandoned-URL guard; Ollama switch live-probes.
- Fix `apac.` geo prefix in webview classifier (was `ap.`).

## 1.0.85

- Require `clawagents>=6.20.9` (capabilities contract + workspace-scoped tool artifacts).
- **No legacy turn lock / chdir:** sidecar always uses `workspace=`; refuses older wheels without it.
- **PATH Python sync opt-in:** `syncPathPythons` defaults off and confirms before upgrading other interpreters.
- **Bridge:** Gemini shim only when `GET /capabilities` lacks `gemini_array_items` (no unconditional monkeypatch).
- **Protocol types:** webview re-exports `src/protocol.ts` (single source).
- Extract `providerCatalog.ts` + `autoOpenFiles.ts`; README companion defaults aligned.

## 1.0.84

- Require `clawagents>=6.20.8` (artifact path containment + raw tool archival).
- **No silent global installs:** `ensureCompanions` defaults off; npm/brew installs ask for confirmation; pip `--break-system-packages` requires consent.
- **Parallel turns:** pass `workspace=` to the agent and skip process-wide `chdir`/turn lock when supported.
- **Chat search:** stream UI logs with chat/hit caps (no full JSONL load per chat).
- Sidecar pip includes `media` (Pillow) for image attach resize.
- README / requirements version docs aligned to the floor constant.

## 1.0.83

- **Provider-switch hardening (all vendors):** leaving Bedrock clears Mantle/BAG Base URL, resets `bedrock_mode` + `wire_api`; host never force-restores Mantle under OpenAI/Anthropic/Gemini; webview ignores stale pushes that hijack back to Bedrock.
- **Sidecar:** drop stale Mantle/BAG URLs for non-Bedrock providers; Mantle auth no longer falls back to `OPENAI_API_KEY`; `resolve_api_key` prefers provider over model-name heuristics; catalog will not probe Mantle as OpenAI custom base.

## 1.0.82

- **Fix OpenAI after Mantle:** switching Provider to OpenAI no longer keeps/restores the Mantle Base URL (was causing 404 / 401 invalid bearer). Clears Mantle URL + resets `bedrock_mode`; sidecar ignores Mantle hosts for non-Bedrock providers.

## 1.0.81

- **Provider menu:** separate choices for **AWS Bedrock (IAM)**, **AWS Bedrock Mantle**, and **AWS Bedrock Gateway** (each sets `bedrock_mode` + Base URL). Access-mode segment still works as a shortcut.

## 1.0.80

- **Bug report fallback:** when no SMTP/mailto recipient is set, open a GitHub issue draft (never empty `mailto:?`). Harden: validate email shape; never use `EMAIL_SENDER` as To; bound GitHub draft URL length; safe `openExternal`.
- **Send gated on API key:** composer Send / Enter and slash-free turns require a provider key; slash commands still work; Enter defers to `send()` (no double-gate).
- **`autoOpenChangedFiles` polish:** debounce multi-file edits; quiet failures go to Sidecar log; `preserveFocus`; skip secret/`..` paths; dispose clears timer.
- Starter chips send current `autoApprove` / interaction / caveman / goal (no stale host state).
- README: **ClawAgents: Set API Key** (was a non-existent “Set Provider Credential”).
- Require `clawagents>=6.20.7` (centralized secret-path module).

## 1.0.79

- Require `clawagents>=6.20.6` (dead handoffs, Mantle multi-path, DX/efficiency).
- **Streaming perf:** memoized `TranscriptItem` rows — only the active assistant message re-parses markdown on each token.
- **Cheap `/providers`:** `probe=0` no longer hits localhost Ollama (`/api/tags`); live check stays on `probe=1`.
- **`pushReady` SecretStorage:** one `getApiKeyEnv()` per ready push instead of ~5 duplicate reads.
- **Persist payload:** webview stops shipping full transcript on debounce (host only stores draft/mode/flags).
- **Panel nav a11y:** top Chat/History/Settings/Diagnostics tabs use `role="tablist"` + `aria-selected`.
- Also includes 1.0.76–1.0.78: Mantle Messages/Responses routing, Access mode UI, settings/Mantle race fixes, bug-report Marketplace fallback, `autoOpenChangedFiles`, empty-key UX.

## 1.0.78

- **Bug report for Marketplace users:** SMTP via `EMAIL_*` env / optional settings; mailto + clipboard fallback when SMTP unavailable; removed internal infra strings from UI.
- **`clawagents.autoOpenChangedFiles`:** opens agent-edited files in the editor when enabled.
- **No-API-key UX:** disable empty-state chips; banner links to Settings and **Set API key** (`clawagents.setApiKey`).
- **Bug-report modal a11y:** focus textarea on open; Esc closes and stops dictation.
- **Sidecar error banner:** Restart Sidecar button beside install instructions.

## 1.0.77

- **Settings autosave convergence:** accept host Mantle URL/`bedrock_mode` normalization; tag save echoes with `saveOutcome: "ok"`; block unsolicited IAM pushes from demoting Mantle.
- **Sidecar start:** skip PATH Python floor sync / `--break-system-packages` upgrades on every restart (Install/Doctor/activation still sync once per floor).
- **Interject race:** if a mid-turn redirect lands after the run ends, queue drains immediately (`drainQueueIfIdle`); `stranded_interject` no longer silently dropped in the webview.
- Scroll-to-bottom only while the user is near the bottom; confirm before delete chat / restore checkpoint.
- npm tests track `MIN_CLAWAGENTS_VERSION` dynamically (6.20.5).

## 1.0.76

- **Fix Mantle Claude chat 400:** `anthropic.*` no longer forced through `/v1/chat/completions`. Routes Claude → Mantle `/anthropic/v1/messages`, GPT-5.x → `/openai/v1/responses`, others → chat completions. Requires `clawagents>=6.20.5`.
- Access mode: segmented Native IAM / Mantle / Gateway control (clearer than the dropdown).
- Mantle default model: `openai.gpt-oss-20b` (chat-safe).

## 1.0.75

- Require `clawagents>=6.20.4` (cancel kills orphan execute; bg shell-session sync)
- **Settings save reliability:** stop optimistic commit before host confirms (blocked retries after stale echoes); trust-modal Cancel applies prior settings via `saveOutcome: "cancelled"`

## 1.0.74

- **Fix Mantle model dropdown showing Native IAM models:** when Access mode is Mantle, chat model list uses Mantle IDs (live `/models` on catalog change + after Test endpoint). Client fallback no longer shows Nova/Claude US while in Mantle mode.
- Status line: in Mantle mode, stop implying IAM is required

## 1.0.73

- **Fix Mantle Access mode snapping back to Native IAM:** stale `settings` echoes no longer overwrite a newer Mantle/BAG choice; Access mode saves immediately; `bedrock_mode` / `base_url` are critical save-verify keys

## 1.0.72

- **Hard-stop settings save loop:** autosave commits a settings fingerprint; host echoes cannot re-PUT. Providers/skills refresh only when those keys actually change.
- Note: install this VSIX into the editor you use (Cursor was still on 1.0.10 while VS Code had 1.0.69)

## 1.0.71

- **Fix settings/skills save storm:** preferred-model effect no longer replaces Mantle/custom models missing from the cheap (`probe=0`) catalog — that looped `PUT /settings` + `GET /skills` forever.
- Autosave skips identical payloads; skills preview refreshes only when skill-related keys change

## 1.0.70

- **Auto-upgrade PATH Pythons on install/reinstall:** `ensureSidecarDeps` / Install Python Deps / Doctor / sidecar start also upgrade other PATH interpreters below the clawagents floor (Homebrew/conda). Setting `clawagents.syncPathPythons` (default on).
- pip retry with `--break-system-packages` for Homebrew/Debian PEP 668 (`externally-managed-environment`)
- PATH probe uses `which -a` so every matching interpreter is checked

## 1.0.69

- **Fix sidecar hang / socket exhaustion (root cause):** settings autosave was calling `GET /providers` with live Mantle/OpenAI `/models` probes on every keystroke. Concurrent probes stampeded the sidecar thread pool → hung event loop → `ETIMEDOUT` / `EADDRNOTAVAIL`.
  - `/providers` defaults to cheap catalog (`probe=0`); live probes only with `?probe=1` (ready / open Settings)
  - Serialize settings saves; post-save catalog refresh never probes
  - Reuse sidecar only if `/health` responds; invalidate + restart on transport errors
  - HTTP `Connection: close` to avoid keep-alive pileups
- AWS Bedrock settings: **Native IAM** vs **Mantle / OneHUB** (`bedrock-mantle.<region>.api.aws/v1` + Mantle API key) vs optional **BAG**. Mantle hosts trusted; curated Mantle models + live `/models` merge.
- Compact: immediate “Compacting…” ack; compact HTTP timeout 180s; progress chip

## 1.0.68

- Require `clawagents>=6.20.3` (execute/sandbox hardening)

## 1.0.67

- Require `clawagents>=6.20.2` (fix seatbelt execute `shlex` crash)

## 1.0.66

- Require `clawagents>=6.20.1` (Grok harness hardening: trailer markers, sticky caps, grep/pty bounds)

## 1.0.65

- Require `clawagents>=6.20.0` (Grok harness: edit depth, execute stream/env, hashline_grep, PTY routing)

## 1.0.64

- Caveman mode on by default (one-time migrate for existing workspaces; toggle still sticky after that)

## 1.0.63

- Mic: pick device once per session, then reuse; ⌥/Alt+Mic to change

## 1.0.62

- Bug report email: subject `[ClawAgents-bug-report] …`; send only to `EMAIL_SENDER` (not alpaca trading `RECIPIENT_EMAILS`); stop using `send_alert_email` (`[alpaca-autotrading]` prefix)

## 1.0.61

- Bug report email: parse alpaca_deploy `.env` quoted values + trailing `#` comments (Gmail 535 was from swallowing the comment into `EMAIL_PASSWORD`)

## 1.0.60

- Restore full composer placeholder hints (mic / paste / attach / send / Esc stop)

## 1.0.59

- **Pick mic, then dictate:** Mic opens a microphone QuickPick, sets it as the system input, then starts OS dictation.
  - **macOS:** Bundled `bin/darwin-*/mac_audio_input` (CoreAudio; no Xcode CLT). Then **Edit → Start Dictation…** (Fn Fn). Optional fallbacks: Homebrew `SwitchAudioSource`, or `swift` + source script.
  - **Windows:** Voice typing (**Win+H**). Mic list/switch via optional `AudioDeviceCmdlets` (else ffmpeg list + Sound settings link).

## 1.0.58

- **Mic → Apple Dictation:** Mic triggers macOS **Edit → Start Dictation…** (same as Fn Fn). Text goes into the focused composer/bug-report box. No ffmpeg, Whisper, or OpenAI key. May need Accessibility allowed for Cursor once.

## 1.0.57

- Auto-install falls back to the GitHub release wheel when PyPI lacks `clawagents>=6.19.0` (fixes sidecar fail after fresh VSIX)

## 1.0.56

- Bug report comment button: type / speak / screenshot → email via alpaca_deploy `send_alert_email` + SMTP attachments
- Setting `clawagents.alpacaDeployPath` (or `ALPACA_DEPLOY_ROOT`)

## 1.0.55

- Require `clawagents>=6.19.0` (companion floors + doctor probes)
- Auto-ensure companions on sidecar start (`clawagents.ensureCompanions`, default on): `npm i -g context-mode@latest`, `brew install/upgrade rtk`
- Command: **ClawAgents: Ensure Companions (context-mode / rtk)**
- Doctor reports companion versions; diagnostics check context-mode semver + rtk
- Caveman toggle injects full JuliusBrussee/caveman skill (vendored)
- Composer Mic/Send as compact overlay icon buttons

## 1.0.54

- Require `clawagents>=6.18.0` (hashline edit, RTK wrap, shell-session cwd, auto-bg on execute timeout, aggressive tool crush)

## 1.0.53

- **PATH pin:** sidecar prepends `dirname(clawagents.pythonPath)` so shell `python3`/`pip` match the sidecar (fixes Homebrew/conda drift)
- **Doctor:** command `ClawAgents: Doctor (Python versions)` + startup warning when PATH Pythons are outdated
- Require `clawagents>=6.17.9` (doctor reports multi-interpreter drift)

## 1.0.52

- Require `clawagents>=6.17.8` (secret rewind filter, webhook DNS pin, full stream breakers)

## 1.0.51

- Confirm before destructive rewind
- Stop stranded-redirect race; stop mic when sidebar hidden
- Voice: navigator language + cloud-STT disclosure; fix interim typing dup
- Require `clawagents>=6.17.7`

## 1.0.50

- Surface rewind failures (`ok: false`) instead of claiming success
- Pin sidecar floor to `clawagents>=6.17.6` (P1 security hardening)

## 1.0.49 — 2026-07-16

- Require `clawagents>=6.17.5` (skill allowed-tools / grep / apply_patch fixes)

## 1.0.48 — 2026-07-16

- Require `clawagents>=6.17.4` (Act mode no longer inherits Goal verifier)
- Switching Goal→Act/Plan pauses active disk-backed goal; Goal resumes it
- Compact meter reset (from prior fix in tree)

# Changelog

## 1.0.47 — 2026-07-16

- Require `clawagents>=6.17.3` (Tier-2 hook/hunk/rewind/bwrap wiring + complete→chat fix)
- Rewind passes `chat_id` so conversation truncates with files

## 1.0.46 — 2026-07-15

- Require `clawagents>=6.17.1` (circuit-breaker probe-lease, interject synthetic turns)
- **Voice dictation** — Mic button + ⌃␣ / F8 (Web Speech API → composer draft)
- Stranded mid-turn redirects promote to the front of the send queue (not dropped on Stop)

## 1.0.45 — 2026-07-15

- Require `clawagents>=6.17.0` (smart memory, PTY sessions, structured output, doom-loop, session rewind)
- **Rewind** panel (`/rewind`) — restore workspace files to a prior prompt snapshot
- Sidecar `/rewind` list + restore endpoints

## 1.0.44 — 2026-07-15

- Require `clawagents>=6.16.0` (ATLAS removed; Goal is the only long-horizon path)
- Remove ATLAS UI, settings, and `atlas-skill` pip dep
- Permission `ask` rules route to the approval UI; interject targets `chat_id` and appends (no overwrite-drop)
- Hunk path traversal hardened (workspace-relative only)

## 1.0.43 — 2026-07-15

- Require `clawagents>=6.15.0` (Goal autopilot product, OS sandbox enforce, deny-wins permissions, prefire compaction, best-of-n)
- Composer: **Goal** button before Plan (wires `goal_mode`)
- Mid-turn **Redirect** (interject without Stop); draft Enter while busy redirects
- **Review** panel for attributed hunk accept/reject (`/hunks`)

## 1.0.42 — 2026-07-15

- Require `clawagents>=6.14.2` (Grok-aligned skill strategy: `when-to-use`, path gates, `$ARGUMENTS` / `${SKILL_DIR}`, hot reload, compaction `invoked_skills`)
- Settings → Skills: show **Use when** and path-gate globs in the detected-skills list

## 1.0.41 — 2026-07-14

- ATLAS: move toggle to composer **Auto-approve** (compact, like Caveman); **off by default** after A/B cost experiments
- Settings Advanced only points to the Auto-approve location (no long ATLAS install blurb)

## 1.0.40 — 2026-07-14

- Model picker lists only providers with a saved/valid key (no phantom catalogs)
- Default model: **gpt-5.6-luna** + medium effort when OpenAI is available, else **gemini-3.5-flash**
- Stock OpenAI: merge curated models with live `/v1/models` for the saved key

## 1.0.39 — 2026-07-14

- ATLAS treated as built-in (Settings copy + soft-skip if runtime not ready); still on by default and auto-installed with sidecar deps

## 1.0.38 — 2026-07-14

- Settings: **ATLAS** is on by default (uncheck to disable)
- Auto-install pinned `atlas-skill` (and deps probe requires `atlas_runtime`) so default-on does not fail-closed on missing package

## 1.0.37 — 2026-07-14

- Fix: restore Settings `atlas` default key (required for ATLAS checkbox persistence)

## 1.0.36 — 2026-07-14

- Require `clawagents>=6.13.1` (ATLAS fail-closed gates)
- Pin ATLAS install hints to commit `3a917f3e0b993e3bfd77f652b013193aed167964`

## 1.0.35 — 2026-07-14

- Settings: opt-in **ATLAS (smarter failure checks)** checkbox — forwards `atlas=True` to clawagents≥6.13 when supported; needs `atlas-skill` from GitHub and optional workspace `atlas.json`

## 1.0.34 — 2026-07-14

- Security: permission grants live in user-owned state (not `.clawagents/` in the repo)
- Security: validate webview→host messages before they reach extension authority
- Sidecar startup: generation-gated restarts; pin `clawagents` / FastAPI deps with upper bounds
- Checkpoint restore: validate `chat_id` paths; register cancel only after request validation

## 1.0.33 — 2026-07-14

- Fix: unrelated Settings autosaves no longer wipe a prior URL-bound gateway approval in SecretStorage / process memory
- Fix: gateway “Trust and save” modal only appears when Base URL actually changes (not on checkbox / wire_api autosaves)

## 1.0.32 — 2026-07-14

- Security: workspace files cannot self-grant gateway/MCP/full-access/skill-root trust (SecretStorage + URL-bound gateway trust)
- Fix: local image/file attachments stage reliably for remote extension hosts (ack-gated transfer)
- Skills catalog preview uses an invalidating content snapshot (no rebuild on every refresh)
- Require `clawagents>=6.12.13` (skill retrieval / paged `use_skill` / intersecting `allowed-tools`)

## 1.0.31 — 2026-07-14

- Image + PDF/DOCX attachments in chat (model sees pixels / document content)
- Require `clawagents>=6.12.12` (`invoke(images=)` / `invoke(files=)`); pip spec + version gate enforce it

## 1.0.30 — 2026-07-13

- Require `clawagents>=6.12.10` (`disable-model-invocation` + skill loader fixes); pip spec + version gate enforce it
- Skills: load `~/.clawagents/skills`; Settings preview shows unavailable skills with reasons and loader warnings
- Fix sidecar restart race (stale exit listener / concurrent starts sharing one spawn)
- Fix Stop: clearing the queue so follow-ups do not auto-restart
- Fix chat stuck on "Running…" when SSE ends without done/error (keep-alive + idle timeout)
- Single "ClawAgents Sidecar" output channel

## 1.0.29 — 2026-07-13

- Require `clawagents>=6.12.9` (skill loader precedence, safer requires parsing, resource disclosure)

## 1.0.28 — 2026-07-13

- Fix context meter: show latest prompt size vs window (was summing every tool-loop round → false 100%)

## 1.0.27 — 2026-07-13

- Skills: auto-load personal homes (`~/.codex/skills`, `~/.claude/skills`, `~/.agents/skills`) so cohort/workflow skills are available without manual folder registration
- Require `clawagents>=6.12.8` for per-turn skill ranking + stronger `use_skill` activation

## 1.0.26 — 2026-07-13

- Fix: auto editor Context is no longer written into chat history (only what you typed is shown)
- Fix: `.env` and other secret-like files are omitted from auto Context / +Sel snippets
- Context checkbox defaults off (`clawagents.includeContextByDefault`); check it when you want editor snippets

## 1.0.25 — 2026-07-13

- Skills: require `clawagents>=6.12.7` for dynamic skill-catalog budget (~1.5% of context, floor 4k / ceiling 16k chars) with description-first truncation

## 1.0.24 — 2026-07-13

- Skills: require `clawagents>=6.12.6` so `list_skills` is registered (overflow catalog) while full skill bodies still load only via `use_skill`

## 1.0.23 — 2026-07-13

- Cleaner API-key handling: pass host SecretStorage key as explicit `api_key=` every turn; sidecar sets `CLAWAGENTS_SKIP_DOTENV=1` so clawagents never reloads workspace `.env` mid-process (requires `clawagents>=6.12.5`)

## 1.0.22 — 2026-07-13

- Fix: UI / SecretStorage API keys no longer get overwritten by workspace `.env` on the second chat turn (`CLAWAGENTS_DOTENV_OVERRIDE=0` + spawn-secret restore; requires `clawagents>=6.12.4` for the library-side fix)

## 1.0.21 — 2026-07-13

- Harden settings: single source of truth (`DEFAULTS` + `sanitize_patch`); remove duplicate `SettingsBody` so new keys cannot be silently dropped
- Persist `agent_mode` / `action_mode`; webview verifies patched keys after save
- Diagnostics warn on custom HTTPS + TLS verify on / Wire API auto; chat preflight if custom gateway has no model

## 1.0.20 — 2026-07-13

- Fix Settings save: `wire_api`, `reasoning_effort`, and `ssl_verify` were dropped by the API body schema (UI snapped back; chat kept hitting Chat Completions → 404 on Responses-only gateways)

## 1.0.19 — 2026-07-13

- Custom OpenAI-compatible Base URL: probe `/v1/models` and fill the model dropdown from the gateway (fixes header stuck on **default** / Provider **OpenAI (no key)**)
- Refresh provider catalog after Save settings; Wire API + TLS verify save immediately

## 1.0.18 — 2026-07-13

- Settings: API keys live only on each Provider card (OpenAI / Anthropic / Gemini / Bedrock) + Tavily under Browser/web — removed duplicate Set/Clear/Verify from Advanced

## 1.0.17 — 2026-07-13

- OpenAI compatible gateways: **Wire API** (auto / Responses / Chat Completions) + **Verify TLS** settings
- Effort selector saves immediately (no longer stuck on Medium)
- Requires `clawagents>=6.12.3` for Responses-only proxies (e.g. Codex gateways)

## 1.0.16 — 2026-07-13

- OpenAI GPT-5.5/5.6: auto-route to Responses API via `clawagents>=6.12.2` so Effort applies with tools (Ollama/BAG stay on Chat Completions)

## 1.0.15 — 2026-07-12

- Model dropdown: only list models for providers with credentials that pass a live key check (auto no longer dumps every catalog entry)
- Remove DeepSeek R1 from Bedrock catalog
- Bedrock availability no longer unlocked by `OPENAI_API_KEY` alone; Ollama only when local daemon responds

## 1.0.14 — 2026-07-12

- Remove Cline attribution from README / LICENSE / NOTICE

## 1.0.13 — 2026-07-12

- Secondary Side Bar flame icon: teal (`#2DD4BF`) so it’s visible on dark themes and distinct from Claude (orange) / Codex (white)

## 1.0.12 — 2026-07-12

- **Effort** selector for GPT-5.5/5.6 and o-series (Light / Medium / High / Extra High / None) — header + Settings; requires `clawagents>=6.12.1`

## 1.0.11 — 2026-07-12

- **VS Code**: Secondary Side Bar + editor title Open button (same pattern as Claude Code / Codex) so the flame icon appears in the right strip
- Install target clarified: use VS Code (`code --install-extension`), not only Cursor

## 1.0.10 — 2026-07-12

- **Cursor**: show ClawAgents on the left **Activity Bar** (Claude/Codex title-bar icons are Cursor built-ins — third-party extensions cannot join that strip)
- **VS Code**: keep Secondary Side Bar on the right when the auxiliary bar is available

## 1.0.9 — 2026-07-12

- Show ClawAgents in the right Secondary Side Bar strip: themeable SVG icon, editor title-bar Open button, reveal panel on startup (`clawagents.revealOnStartup`)

## 1.0.8 — 2026-07-12

- Settings provider dropdown: hide builtin `Profile: bedrock-gateway` (duplicate of **AWS Bedrock**; gateway mode stays on the Bedrock card)

## 1.0.7 — 2026-07-12

- **AWS Bedrock native IAM** — select Bedrock, pick AWS model IDs (Claude / Nova / Llama / GPT-OSS / …), leave Base URL empty
- Settings: AWS region + profile; optional BAG/LiteLLM gateway section
- Forward `AWS_*` credentials into the sidecar; require `clawagents[bedrock]≥6.12.0`

## 1.0.6 — 2026-07-12

- Settings: guided setup cards for **OpenAI** (Official / Ollama / BAG / Fix URL → /v1) and **Gemini** (inline key + verify)
- OpenAI provider fully supports OpenAI-compatible endpoints (including BAG as Base URL)
- Shared `set_provider_key` + `test_compatible_endpoint` for OpenAI / BAG probes

## 1.0.5 — 2026-07-12

- Settings: dedicated **Bedrock Access Gateway** card — Local preset (`http://localhost:8000/api/v1`), Fix URL → `/api/v1`, inline gateway API key, Test connection

## 1.0.4 — 2026-07-12

- Settings: **AWS Bedrock (gateway)** provider + selectable Bedrock model IDs (Claude / Nova / GPT-OSS)
- Bedrock requires an OpenAI-compatible **Base URL** (LiteLLM or Bedrock Access Gateway); store the gateway token via Set API key
- clawagents: route `anthropic.*` model IDs through OpenAI provider when `base_url` is set (fixes Bedrock gateway example)

## 1.0.3 — 2026-07-12

- Restore ClawAgents to the right **Secondary Side Bar** (1.0.2 Activity Bar move hid the icon for many users)
- Drag-and-drop: VS Code requires **holding Shift** to drop into a webview; placeholder/+Attach clarify this; harden URI parsing; **+Attach** file picker

## 1.0.2 — 2026-07-12

- Move ClawAgents icon to the left **Activity Bar** (was Secondary Side Bar) — reverted in 1.0.3
- Settings → **Clear API key…** / command **ClawAgents: Clear API Key…** (per provider or all)
- Header: last checkpoint time on **Checkpoints**; context % bar on **Compact**
- Settings panel **autosaves** (~0.5s debounce); MCP/base-URL trust prompts only when newly enabling

## 1.0.1 — 2026-07-11

- Settings → **Set API key…** includes **Tavily** (SecretStorage → `TAVILY_API_KEY`) for `web_search`
- Auto-approve: separate **Web** (fetch/search) and **Browser** (Playwright) checkboxes
- Browser tools remain opt-in under Settings; clearer install hint when load fails

## 1.0.115

- **Luna efficiency:** reject compact that grows context; charge compact usage/cost; context meter uses last-request tokens (not run-cumulative); GPT-5.6 >272K long-context pricing (2× input / 1.5× output); tool-efficiency turn guidance.
- Require `clawagents>=6.20.28` — economic compaction threshold + GPT-5.6 harness.

## 1.0.114

- **Cache-aware usage/cost:** thread `cached_input_tokens` / `cache_creation_tokens` into usage payload + UI; `estimate_usd` applies cache-read discount (and write premium). Header shows **cache N%** when hits are reported.
- Require `clawagents>=6.20.27` — `UsageEvent` exposes cache fields.

## 1.0.113

- **Plan mode (Grok Build parity):** explore + `write_plan` → `exit_plan_mode` shows Approve / Request changes / Reject; Approve unlocks the run and switches to Act.
- Require `clawagents>=6.20.26` — UI Plan maps to engine `PermissionMode.PLAN` with plan-file exemptions.


## 1.0.112

- Default Auto-approve: **Edit** + **Execute** on (Web/Browser still off).


## 1.0.111

- Require `clawagents>=6.20.25` — YAML skill frontmatter + nested shlex guard.

## 1.0.110

- Hotfix: restore Bedrock kwargs under `elif use_bedrock` (1.0.108 nested them under `else`, leaving a dangling `elif` → sidecar SyntaxError).

## 1.0.109

- Require `clawagents>=6.20.24` — Bedrock geo id tighten + skill drain preflight.
- `applyBedrockMode` resets `wire_api` to `auto` for bag/iam (not only mantle).

## 1.0.108

- Require `clawagents>=6.20.23` — skill tool filtering + aliases, apply_patch matching, MCP reconnect/timeout, compaction tool_calls_meta fix; clear `pendingSettingsPatch` on save error; Bedrock AWS env clear + wire_api reset on leave.

## 1.0.107

- Require `clawagents>=6.20.22` — Responses retry de-nest, `$ref`/`anyOf` schemas, model-prefix classifiers; post-install floor re-probe.

## 1.0.103

- Require `clawagents>=6.20.19` — never crush skill/control-plane tool outputs; post-edit syntax gate on write tools.

## 1.0.102

- Auto-heal saved model leftovers that cannot belong to the selected provider (e.g. ``llama3.1`` under OpenAI → preferred GPT) on load — not only on Provider switch.

## 1.0.101

- Require `clawagents>=6.20.18` — chat_mode↔sandbox contract, failed-tool no-crush, EPERM auto-retry under Full access.
- Sidecar passes `chat_mode` / `allow_full_access` into `create_claw_agent` (no ad-hoc sandbox_profile=off).

## 1.0.100

- Composer Auto-approve panel: **Full access** checkbox (same as Settings) — enables Edit/Execute, sets ``mode=full_access``, disables OS sandbox for gcloud/deploy.

## 1.0.99

- Require `clawagents>=6.20.17` — seatbelt ``/dev/null`` allow + clearer sandbox hints.
- ``mode=full_access`` + Settings → Allow Full Access now sets ``sandbox_profile=off`` (gcloud/deploy can use ``~/.config``).
- Checkbox label clarifies Full Access also disables the OS sandbox.

## 1.0.98

- Provider switch: reset incompatible leftover models (e.g. Ollama ``llama3.1`` when switching to OpenAI) instead of sending them to api.openai.com (404).
- Sidecar: clear error when Provider=OpenAI + Model is an Ollama-style id.

## 1.0.97

- Require `clawagents>=6.20.16` — ``snapshot_diff`` ``showing 40 of N`` file-cap note.

## 1.0.96

- Require `clawagents>=6.20.15` — skill-loading auto-continuation (no refusal loop / mid-load deadlock); ``use_skill(abort=true)``.

## 1.0.95

- Require `clawagents>=6.20.14` — strict apply_patch (empty REPLACE / fence guard), ``snapshot_diff``, code crush floor, /tmp sandbox allow.

## 1.0.94

- Require `clawagents>=6.20.13` — clearer non-repo git notices, hashline malformed-anchor samples, execute git-128 interpretation (fewer scary fails outside git repos).

## 1.0.93

- **Cost estimates:** Mantle/Bedrock Claude uses commercial Global rates ($5/$25 Opus), not the GovCloud row ($6/$30) that was scraped from the pricing page by mistake.

## 1.0.92

- **Catalog merge:** on zero curated∩live overlap, prefer the live ``/models`` list instead of advertising the full unconfirmed curated set.

## 1.0.91

- **Cost estimates for Bedrock / Mantle:** price table + prefix strip so Mantle ids match (Opus briefly used GovCloud \$6/\$30 by mistake; corrected to commercial Global \$5/\$25 in 1.0.93). Unknown models omit ``~$0.00`` instead of faking zero.

## 1.0.90

- Require `clawagents>=6.20.12` — Mantle GPT-5.6 Luna / Responses omit deprecated ``temperature``; bare ``gpt-5.6-*`` → ``openai.gpt-5.6-*`` (fixes 400 + 404).

## 1.0.89

- Require `clawagents>=6.20.11` — Claude Opus 4.7+ / Mantle Messages omit deprecated ``temperature`` (fixes 400 on Opus 4.8).

## 1.0.88

- **Key-flag hardening:** host `collectKeyFlags()` (SecretStorage + `.env` + shell) attached to every `settings` / `verify_result` after save/clear; webview no longer parses "saved"/"cleared" from detail text (that falsely cleared OpenAI after Clear when `.env` still had a key).
- **Catalog probe:** present OpenAI/Anthropic/Gemini credentials stay `available` even if live `/models` returns 401 REJECTED.
- **Probe keys** for Test connection resolve the same SecretStorage → `.env` → shell order as sidecar spawn.
- Fallback catalog no longer marks Ollama as "(no key)".

## 1.0.87

- **Provider menu "(no key)"**: honor host SecretStorage / workspace `.env` over a stale sidecar catalog probe (OpenAI can show no key while turns still work).
- **Chat header**: show effective provider next to the model picker (e.g. OpenAI · GPT-5.6 Luna).

## 1.0.86

- Require `clawagents>=6.20.10` (canonical model classifier + PromptHook/PROVIDER fixes).
- **Send/settings race:** flush pending save before send; host awaits `saveSettingsChain`.
- **Bedrock availability:** IAM / Mantle / Gateway use separate cred flags (not one OR).
- **provider=auto** applies Bedrock/Mantle wiring for Bedrock-shaped models.
- Test-endpoint probe serialized + abandoned-URL guard; Ollama switch live-probes.
- Fix `apac.` geo prefix in webview classifier (was `ap.`).

## 1.0.0 — 2026-07-11

- Graduate from Marketplace **Preview** (`preview` flag removed)
- First stable 1.x line; still requires **clawagents ≥ 6.11.1**

## 0.5.21 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.11.1** (CodeAct sandbox + checkpoint ref hardening)
- Do not forward library `approval_required` into the webview (avoids double permission prompts; sidecar uses `before_tool`)

## 0.5.20 — 2026-07-11

- UI polish: clearer header toolbar, context meter chip, Checkpoints/Compact actions
- Checkpoint panel restyle with Files / Chat / Both restore controls
- Softer composer and tab chrome within VS Code theme tokens

## 0.5.19 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.11.0** (shadow restore modes, always-on rules, modes, CodeAct, evals)
- Context meter + `/compact` + compact_progress visibility
- Checkpoint timeline with files / conversation / both restore
- Settings: agent persona mode + CodeAct action mode

## 0.5.18 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.8** (compaction budget escalation + message-identity fix)
- Per-run cancellation tokens (cancel no longer races concurrent turns; disconnect cancels only that run)
- `/cancel` unblocks pending `ask_user` prompts
- Capture previous cwd inside the turn lock (fixes chdir restore race)
- Configurable MCP `mcp.json` server timeout (default 60s, was SDK 5s)
- Gemini array-schema shim self-disables when upstream already fixed
- Release builds minify the extension bundle

## 0.5.17 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.7** (peer harness pack)
- Sidecar: `GET /checkpoints`, `POST /checkpoints/restore` for shadow-git undo

## 0.5.16 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.6** (context headroom: crushers, tiered read, cache-stable prompts, failure→AGENTS.md)

## 0.5.15 — 2026-07-11

- Remove **OpenViking** toggle/skill (default cloud embeddings not allowed); selection box is Edit/Execute/Web/Caveman only

## 0.5.14 — 2026-07-11

- Remove **ByteRover** toggle/skill (cloud LLM provider not allowed); OpenViking remains opt-in

## 0.5.13 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.5** (Gemini history 400 recovery + signature fidelity)

## 0.5.12 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.4** (Gemini 3 `function_call.id` + `thought_signature` replay — fixes remaining FR/FC 400s)

## 0.5.11 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.3** (Gemini `function_response` turn purity — fixes follow-on 400s after 6.10.2)
- Sidecar probe fails closed until the remote Python package meets the floor

## 0.5.10 — 2026-07-11

- Require clawagents ≥ **6.10.2** (Gemini turn-hygiene fix for function-call 400s)

## 0.5.9 — 2026-07-11

- Fix `AskUserTool() takes no arguments` when sidecar still has clawagents &lt; 6.10.1
- Require / auto-upgrade to `clawagents>=6.10.1` (webview `ask_fn` HITL)

## 0.5.8 — 2026-07-11

### Security (second harden pass)
- Orphan/stale `allow_always` can no longer create `path=* tool=*` grants; refuse open-ended grants
- Confine `diff_snapshot` / `openPath` under the workspace; validate snapshot ids
- Drop provider base-URL keys from workspace `.env` allowlist (Settings + trust flag only)
- MCP: workspace `mcp.json` opt-in; allowlisted launchers; loopback URLs only; sanitize child env
- Ignore committed wildcard permission grants; demote `full_access` unless Settings opt-in
- Drop `HTTP_PROXY` / `LD_LIBRARY_PATH` from sidecar env; pip uses curated env
- External skill dirs require opt-in; server-side base_url trust check

## 0.5.7 — 2026-07-11

### Security
- Allowlist workspace `.env` keys (no `PYTHONSTARTUP` / `PYTHONPATH` injection into sidecar)
- Ignore absolute `clawagents.pythonPath` from workspace settings; prefer User/Remote
- Gate unknown/MCP tools in Plan and approval (no longer auto-allowed)
- “Allow always” grants match full relative paths only (not basename)
- Harden `atomic_write_json` against tmp symlink TOCTOU; confine instruction/skill/snapshot resolves
- Warn on non-localhost `base_url` (save + load); MCP defaults to off

### Other
- Pricing estimates use longest-prefix match (`gpt-5.5-pro` ≠ `gpt-5.5`)
- Light dependency upper pins; grant/path unit tests

## 0.5.6 — 2026-07-11

- Auto-install/upgrade Python deps (`clawagents[gemini,anthropic,mcp]`, fastapi, uvicorn, pydantic) on remote/local when missing or too old
- New command: **ClawAgents: Install/Upgrade Python Dependencies**

## 0.5.5 — 2026-07-11

- Fix crash on older PyPI clawagents: only pass `skills_exclude` / kwargs that `create_claw_agent` supports

## 0.5.4 — 2026-07-11

- Remote/SSH: probe Python before spawn, longer health timeout, surface real sidecar errors in UI
- Forward conda/pyenv env into sidecar; offline provider fallback when catalog is empty

## 0.5.3 — 2026-07-11

- Marketplace metadata cleanup (preview flag, softer listing copy) to clear false-positive “suspicious content” scans
- Avoid embedding secret-looking regex literals in the bundled extension host

## 0.5.2 — 2026-07-11

- Return 400 (not 500) when `/chat/stream` receives an invalid `chat_id`

## 0.5.1 — 2026-07-11

- `+File` inserts only `@path` (agent reads the file) instead of pasting full contents
- Drag-and-drop workspace files onto the draft to attach `@path` refs

## 0.5.0 — 2026-07-11

First Marketplace-ready release.

### Security
- Fail-closed sidecar auth when the gateway session key is missing
- Lock sidecar bind address to loopback
- Validate `chat_id` / `snapshot_id` and confine snapshot restore to the workspace
- Curate env vars passed to the sidecar; redact secrets in the Output channel
- Safer Auto-approve defaults (edit / execute / web off); auto interaction no longer forces full approve
- Restrict `open_file` to workspace folders; stronger CSP nonce + `connect-src 'none'`

### Publishing
- Marketplace metadata: icon, repository, bugs, homepage, gallery banner
- End-user README and first-run Python dependency check
- PyPI-oriented install errors (no monorepo-only paths)

## 0.4.15

- Fix Gemini 400 errors from tool schemas missing array `items` (Context Mode / MCP)

## 0.4.14

- Sanitize provider credentials; Gemini verify via query param; start sidecar before verify

## 0.4.13 and earlier

- Skills folders UI, Gemini models, ByteRover / OpenViking toggles, Context Mode, multi-provider settings
