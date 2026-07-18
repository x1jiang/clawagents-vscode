"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_BUG_REPORT_ISSUES =
  "https://github.com/x1jiang/clawagents-vscode/issues/new";

function resolveMailtoRecipient(cfgTo, envBug, envSender) {
  const raw = (cfgTo || "").trim() || (envBug || "").trim() || "";
  // EMAIL_SENDER must never be used as To.
  void envSender;
  return EMAIL_LIKE.test(raw) ? raw : "";
}

function buildIssueUrl(subjectShort, body, smtpError) {
  const title = encodeURIComponent(`[bug] ${subjectShort}`);
  const footer = `\n\n---\n_Filed via ClawAgents bug-report fallback (${smtpError})_`;
  let issueBody = encodeURIComponent(`${body.slice(0, 4000)}${footer}`);
  let issueUrl = `${DEFAULT_BUG_REPORT_ISSUES}?title=${title}&body=${issueBody}`;
  if (issueUrl.length > 7500) {
    issueBody = encodeURIComponent(
      `${body.slice(0, 1200)}${footer}\n\n_(Full report is on the clipboard — paste below.)_`,
    );
    issueUrl = `${DEFAULT_BUG_REPORT_ISSUES}?title=${title}&body=${issueBody}`;
  }
  if (issueUrl.length > 7500) {
    issueUrl = `${DEFAULT_BUG_REPORT_ISSUES}?title=${title}`;
  }
  return issueUrl;
}

test("EMAIL_SENDER alone must not become mailto To", () => {
  assert.equal(resolveMailtoRecipient("", "", "from@example.com"), "");
});

test("bugReportEmailTo wins over env and validates shape", () => {
  assert.equal(
    resolveMailtoRecipient("maintainer@example.com", "", "from@example.com"),
    "maintainer@example.com",
  );
  assert.equal(resolveMailtoRecipient("not-an-email", "", ""), "");
  assert.equal(resolveMailtoRecipient("", "bugs@example.com", ""), "bugs@example.com");
});

test("GitHub issue draft URL stays bounded and never mailto", () => {
  const shortUrl = buildIssueUrl("oops", "short body", "no smtp");
  assert.ok(shortUrl.startsWith(DEFAULT_BUG_REPORT_ISSUES));
  assert.ok(shortUrl.includes("title="));
  assert.ok(shortUrl.includes("body="));
  assert.ok(!shortUrl.includes("mailto:"));

  const longUrl = buildIssueUrl("huge", "x".repeat(20000), "timeout");
  assert.ok(longUrl.length <= 7600, `url too long: ${longUrl.length}`);
  assert.ok(!longUrl.includes("mailto:"));
});
