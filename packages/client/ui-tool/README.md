# @deepseek-ai/dsh-client-ui-tool

English | [中文](README.zh.md)

Client Tool presentation plugin. `ui-conversation` dispatches each ordered `tool-call` Conversation Node through the matching key of `conversation.chat.node`; this package renders its root and Code Dispatch children, then dispatches every atomic call through the keyed `tool.call.toolview` slot. Unregistered Tool names use the generic card.

Business UI packages register only their wire Tool names and atomic views. They do not pair Session events, rebuild the transcript, or own root/subcall topology. The Runtime remains authoritative for call/result pairing, lifecycle, and recursive `subCalls` projection; the conversation view remains authoritative for ChatFlow placement.

## Rendering contract

`ToolCallTree` receives one root `ToolCallBlock` that already contains recursive `subCalls`, selection state, the session `cwd`, and Host callbacks for opening files and inspecting calls. It recursively walks the standard call blocks and sends the root and children at every depth through the same atomic dispatch path, without subscribing to a separate parent-to-children map.

Each root and child wrapper preserves the `data-chat-anchor-key="call:<id>"` and `data-chat-call-id` DOM contract used for paging and selection.

The package also fills `conversation.details.tool` with `ToolDetails`. Row and Details renderers share one pure card model for each terminal, read, diff, search, and web card. These models validate raw call arguments, result content, failure state, persisted metadata, the existing Code Dispatch `parentCallId`, and Session path facts; unsupported or malformed inputs fall back to flattened Tool result text.

Generic rows classify known Tool names into search, read, shell, write, edit, code, or generic variants. Running, successful, failed, and interrupted lifecycle states come only from the frozen call/result slice. File paths resolve against the session `cwd` only when the user invokes the Host open-file callback; presentation code does not read Session services.

## Atomic Tool views

An owning business package registers its wire Tool name into `tool.call.toolview`:

```ts ignore-check
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({
    name: 'tool.call.toolview',
    key: '<wire tool name>',
  }, BusinessToolRow))
```

The owner payload is `ToolCallOwnerProps`: `callId`, `toolName`, the frozen `block`, optional `cwd` and `home`, and plain `openFile`/`inspect` callbacks. A Code Dispatch block retains its event's `parentCallId`; the field is absent on a root Session call, so row and Details card models preserve the generic flattened form for descendants without another placement flag. Path summaries relativize to the Session cwd first, then replace a leftover POSIX Host home with `~`; `filePath` and Host open keep the authored filesystem path. The registration receives the normal Session slot runtime share but no React node or Runtime service.

This package currently owns the generic fallback and the built-in shell/pwsh, read, write/edit, running `str_replace_editor` `create`/`str_replace`, grep/glob, web, todo, question, and Code Dispatch presentations. Structured cards derive directly from first-party raw event fields; Host `presentCall`/`presentResult` values never enter the Client. Foreground one-shot shell results use terminal cards. Settled persistent-shell results use the expandable generic input/output card because reset and partial-output diagnostics do not always describe one process exit status; background acknowledgements remain collapsed. `ui-skill` demonstrates a business-owned registration for `skill`.

Card-specific limits and fallback rules remain in the owning [terminal](../../../.agents/notes/implemented/feature/2026-07-28-web-terminal-card.md), [diff](../../../.agents/notes/implemented/feature/2026-07-30-web-diff-card.md), [read](../../../.agents/notes/implemented/feature/2026-07-30-web-read-card-frontend.md), [search](../../../.agents/notes/implemented/feature/2026-07-30-web-search-card.md), and [web](../../../.agents/notes/implemented/feature/2026-07-30-web-result-card-frontend.md) notes.

## Model Experience

None, as this package renders already logged Tool calls and results without altering model requests, Tool execution, or session events.

#### KV Cache effect

None. The package is client-only presentation.

## Known Limitations and Deferred Work

- The Host excludes `run_code` from Code Mode program bindings, so production events produce one dispatch level; the recursive Runtime/UI contract supports nesting.
- First-party Tool views are colocated here and can move to their owning business packages independently through the keyed slot.
- Tool titles, row chrome, and every Cordis-free primitive label reuse the `ui-conversation` locale namespace; presenter models retain locale keys or data rather than rendered wording.
