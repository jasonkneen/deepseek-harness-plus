# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

The browser Chat target for Conversation assembly. It registers Chat event definitions and snapshot construction, supplies `useChat`, renders transcript nodes and details, and owns Chat-specific stores, actions, localization, historical images, and scroll restoration.

## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

- **The view reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page.
