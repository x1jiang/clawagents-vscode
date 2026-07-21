---
name: git-release-workflow
description: Rules and guidelines for Git branch management, CHANGELOG updates, PR workflow, and version tagging.
---

# Git Release Workflow Guidelines

Follow these strict workflow guidelines for all Git operations and releases in this repository:

## 1. Branch-First Push Policy (Never Push Directly to `main`)
- **Prohibition**: NEVER push commits directly to the `main` branch.
- **Workflow**:
  1. Always work on a dedicated feature or bugfix branch (e.g., `feature/fork-chat`, `bugfix/issue-description`).
  2. Commit changes to the feature branch and push to the remote feature branch first (`git push origin <branch-name>`).
  3. Merge changes into `main` only after full testing, verification, and PR review.

## 2. Mandatory CHANGELOG Updates
- Every time a `git commit` is made for functional or UI changes, update `CHANGELOG.md` on the current working branch prior to committing.
- **Formatting**:
  Follow the existing `CHANGELOG.md` version header and bullet point format:
  ```markdown
  ## <version>

  - Description of change 1.
  - Description of change 2.
  ```
- Keep descriptions clear, concise, and professional.

## 3. Version Tagging & Merging to `main`
- Release tags (e.g., `v1.0.137`) MUST be applied sequentially on the `main` branch when merging a release or PR.
- Bump the version in `package.json` when preparing a new version on `main`.
- Create annotated or lightweight git tags on `main` following the `v1.0.x` pattern (e.g., `git tag v1.0.137`).
- Push tags to remote using `git push origin v1.0.x` or `git push origin --tags`.
