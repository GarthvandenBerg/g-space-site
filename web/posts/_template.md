---
title: Your post title
date: 2026-01-31
tags: kubernetes, gitops
summary: One or two sentences shown on the card. Optional; defaults to the first paragraph.
# readTime: 5     <- optional; calculated from word count if left out
# draft: true     <- optional; hides the post until you remove it
---

Write the post in Markdown. Files starting with an underscore are ignored.

## A heading

Normal paragraphs, **bold**, *italic*, ~~strikethrough~~, `inline code` and [links](https://example.com).

---

## Lists and tables

- Bullet lists
- Work too

| Host | Role | Notes |
|:---|:---:|---:|
| **kirk** | Primary host | Runs 2 control planes + 1 worker |
| **picard** | Secondary host | Runs 1 control plane + 1 worker |
| **QDevice** | Quorum device | Runs external monitoring |

```yaml
securityContext:
  runAsNonRoot: true
  allowPrivilegeEscalation: false
```
