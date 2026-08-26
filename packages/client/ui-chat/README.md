---
description: "Browser Chat target that renders Session conversation nodes, details, historical images, actions, localization, and scroll state."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

## Summary

The browser Chat target for Conversation assembly. It registers Chat event definitions and snapshot construction, supplies `useChat`, renders transcript nodes and details, and owns Chat-specific stores, actions, localization, and scroll restoration; historical image URLs resolve through the Conversation-owned per-session cache (`ctx.uiConversation.imageUrl`). Its Assistant and Turn Tail definitions fold packed historical Assistant runs without expanding their members.

## Table of Contents

- [System prompt row](#system-prompt-row)
- [Turn token usage](#turn-token-usage)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="system-prompt-row"></a>
## System prompt row

Chat shows a collapsed `System prompt` row for each non-empty initial or resumed request, explicit message-series start, or real system-field change. It does not repeat the row for same-series config-only or tool-only changes, tool steps, or retries. The row appears before that request's user messages, matching the provider envelope, and expands to the exact model-visible text with its original line breaks. A partial history window renders a non-initial header conservatively until the preceding page arrives; a header without a system prompt creates no row.

-----

<a id="turn-token-usage"></a>
## Turn token usage

A completed Turn shows an expandable usage row only when the loaded window includes `turn/start` and every started model attempt reports safe, exact usage. The row omits unavailable optional buckets. Incomplete or contradictory accounting hides the complete disclosure instead of presenting a partial total.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The view reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation likewise represents only loaded Turns; loading an earlier page preserves existing Turn marks and redistributes the complete loaded set in a compact rail without an unloaded-history placeholder. Marks stay 10px apart until the loaded set exceeds the available height, then compress to fit.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
