#!/usr/bin/env python3
"""Send ClawAgents bug reports using alpaca_deploy email credentials.

Reads JSON from stdin:
  {
    "text": "...",
    "screenshots": [{"name": "shot.png", "media_type": "image/png", "data": "<base64>"}],
    "meta": {"vscode": "...", "clawagents": "...", "workspace": "..."}
  }

Credential source (same as alpaca_deploy EMAIL_CONFIG):
  alpaca_deploy/.env → EMAIL_SENDER, EMAIL_PASSWORD, RECIPIENT_EMAILS, EMAIL_SMTP_*

When alpaca_deploy.utils.helpers is importable, text-only reports use send_alert_email.
Otherwise (and always for attachments) uses the same SMTP login pattern.

Exit 0 on success; print JSON {"ok": true/false, "detail": "..."} to stdout.
"""

from __future__ import annotations

import base64
import json
import os
import smtplib
import sys
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path


def _resolve_alpaca_root() -> Path | None:
    env = (os.environ.get("ALPACA_DEPLOY_ROOT") or "").strip()
    if env:
        p = Path(env).expanduser()
        if p.is_dir():
            return p
    here = Path(__file__).resolve()
    candidates = [
        here.parents[3] / "alpaca_deploy",
        here.parents[2] / "alpaca_deploy",
        Path.home() / "Dropbox" / "cursor_projects" / "mac" / "alpaca_deploy",
    ]
    for p in candidates:
        if p.is_dir():
            return p
    return None


def _parse_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        k = k.strip()
        v = v.strip().strip("'").strip('"')
        if k:
            out[k] = v
    return out


def _email_config_from_alpaca(root: Path) -> dict:
    """Mirror alpaca_deploy.config.settings.EMAIL_CONFIG without importing it."""
    file_env = _parse_dotenv(root / ".env")

    def get(key: str, default: str = "") -> str:
        return (os.environ.get(key) or file_env.get(key) or default).strip()

    password = get("EMAIL_PASSWORD")
    recipients = [
        e.strip()
        for e in get("RECIPIENT_EMAILS", "xiaoqian.jiang@gmail.com").split(",")
        if e.strip()
    ]
    enabled = get("EMAIL_ENABLED", "true").lower() == "true" and bool(password)
    return {
        "enabled": enabled,
        "sender_email": get("EMAIL_SENDER", "xiaoqian.jiang@gmail.com"),
        "sender_password": password,
        "recipient_emails": recipients,
        "smtp_server": get("EMAIL_SMTP_SERVER", "smtp.gmail.com"),
        "smtp_port": int(get("EMAIL_SMTP_PORT", "587") or "587"),
    }


def _result(ok: bool, detail: str) -> int:
    print(json.dumps({"ok": ok, "detail": detail}))
    return 0 if ok else 1


def _send_smtp(
    *,
    cfg: dict,
    subject: str,
    body: str,
    screenshots: list[dict],
) -> None:
    sender = cfg.get("sender_email")
    password = cfg.get("sender_password")
    recipients = cfg.get("recipient_emails") or []
    if isinstance(recipients, str):
        recipients = [recipients]
    if not (sender and password and recipients):
        raise RuntimeError("EMAIL_SENDER / EMAIL_PASSWORD / RECIPIENT_EMAILS incomplete")

    msg = MIMEMultipart()
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain", "utf-8"))

    for i, shot in enumerate(screenshots[:6]):
        raw_b64 = shot.get("data") or ""
        if not isinstance(raw_b64, str) or not raw_b64.strip():
            continue
        try:
            payload = base64.b64decode(raw_b64, validate=False)
        except Exception:
            continue
        if not payload or len(payload) > 12 * 1024 * 1024:
            continue
        name = str(shot.get("name") or f"screenshot-{i + 1}.png")
        media = str(shot.get("media_type") or "image/png")
        maintype, _, subtype = media.partition("/")
        if maintype != "image":
            maintype, subtype = "image", "png"
        part = MIMEBase(maintype, subtype or "png")
        part.set_payload(payload)
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", "attachment", filename=name)
        msg.attach(part)

    server = cfg.get("smtp_server") or "smtp.gmail.com"
    port = int(cfg.get("smtp_port") or 587)
    with smtplib.SMTP(server, port, timeout=30) as smtp:
        smtp.starttls()
        smtp.login(sender, password)
        smtp.send_message(msg)


def _try_alpaca_send_alert(root: Path, subject: str, body: str) -> bool | None:
    """Return True/False if helpers imported; None if import unavailable."""
    root_s = str(root)
    if root_s not in sys.path:
        sys.path.insert(0, root_s)
    # Load .env into os.environ so settings sees credentials if helpers import settings.
    for k, v in _parse_dotenv(root / ".env").items():
        os.environ.setdefault(k, v)
    try:
        from utils.helpers import send_alert_email  # type: ignore
    except Exception:
        return None
    try:
        return bool(send_alert_email(subject, body))
    except Exception:
        return False


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        return _result(False, f"invalid stdin JSON: {exc}")

    text = (payload.get("text") or "").strip()
    if not text:
        return _result(False, "bug report text is empty")

    screenshots = payload.get("screenshots") or []
    if not isinstance(screenshots, list):
        screenshots = []
    meta = payload.get("meta") or {}
    if not isinstance(meta, dict):
        meta = {}

    root = _resolve_alpaca_root()
    if root is None:
        return _result(
            False,
            "alpaca_deploy not found — set ALPACA_DEPLOY_ROOT or clawagents.alpacaDeployPath",
        )

    cfg = _email_config_from_alpaca(root)
    if not cfg.get("sender_password"):
        return _result(False, "EMAIL_PASSWORD missing in alpaca_deploy/.env")

    lines = [
        "ClawAgents bug report",
        "=" * 40,
        text,
        "",
        "— Meta —",
    ]
    for key in ("vscode", "extension", "clawagents", "workspace", "platform"):
        if meta.get(key):
            lines.append(f"{key}: {meta[key]}")
    lines.append(f"alpaca_deploy: {root}")
    body = "\n".join(lines)
    subject_short = text[:72].replace("\n", " ")
    subject = f"[clawagents-bug] {subject_short}"

    try:
        if not screenshots:
            used = _try_alpaca_send_alert(root, subject_short, body)
            if used is True:
                return _result(True, "sent via alpaca_deploy.send_alert_email")
            # Fall through to SMTP (import failed or send returned False)

        _send_smtp(cfg=cfg, subject=subject, body=body, screenshots=screenshots)
        n = len(screenshots)
        detail = (
            f"sent via alpaca_deploy EMAIL_* SMTP ({n} screenshot(s))"
            if n
            else "sent via alpaca_deploy EMAIL_* SMTP"
        )
        return _result(True, detail)
    except Exception as exc:
        return _result(False, f"send error: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
