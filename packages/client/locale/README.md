# @deepseek-ai/dsh-client-locale

English | [中文](README.zh.md)

Locale plugin: LocaleRuntime — the preference stored as `locale.preference` in `$DSH_HOME/settings.yaml`; when that explicit Host value is absent, a fresh browser starts provisionally in the first registered language `navigator` asks for (full-tag then primary-subtag matching, with `en` when none match). The Host read runs after plugin activation so an unavailable settings service cannot block the page; its result replaces the provisional browser value live. A saved external locale waits for its definition to register rather than becoming active while unavailable. The Client keeps Host settings persistence disabled on non-loopback pages, so their locale selection remains process-local even though Connection authenticates every API method. `locale/change` fires on switches, and the plugin points `<html lang>` at the external language id or the built-in language's document tag on activation and on every switch. Product-authored Client UI text must enter through these typed dictionaries or an already-localized primitive prop; `verify-client-ui-i18n` enforces that source ownership ([decision](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md)). The [Host-backed preferences decision](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md) owns the persistence boundary.

The package ships only `zh` and `en`. External client plugins add a selectable language with `ctx.effect(() => ctx.locale.addLanguage({ id, label, fallback }))` and add its dictionaries through the existing `register(ns, locale, dict)` form; definitions and dictionaries may register in either order. Unloading the definition removes it from the selector and returns an active selection to the available browser/default locale. An external id is a non-empty ASCII BCP 47-style tag used for persistence, dictionary lookup, browser matching, and `<html lang>`. Its fallback must already be registered, and the resulting chain must terminate at `en`; unknown targets, duplicate ids, and cycles fail at registration. For each key, lookup walks the chain in the requested namespace, repeats it in `common`, then displays the key. The typed `register(ns, { zh, en })` form remains checked against `LocaleNamespaceMap` and requires both built-in dictionaries. LocaleRuntime implements the slot system's `LocaleFace` and installs itself through `ctx.slots.installLocale`, backing the framework-injected `t` standard seat (`Translate`/`TranslateNS` are ui-slots types; import them from there — this package only re-exports them for dictionary owners).

## Language-pack registration

Register the definition and each translated namespace as effects owned by the language-pack plugin:

```js
export const inject = ['locale']

export function apply(ctx) {
  ctx.effect(
    () => ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }),
    'my-locale: language',
  )
  ctx.effect(
    () => ctx.locale.register('common', 'ja', {
      cancel: 'キャンセル',
      close: '閉じる',
    }),
    'my-locale: common dictionary',
  )
}
```

## Model Experience

None, as the locale registry serves browser UI copy; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Registry-held text reads its translation once** — copy captured at registration time outside the slot render path (e.g. the `/model` command description in the command registry) keeps the language it was registered under until re-registration; slot-rendered copy follows switches live.
- **Language packs own language-specific behavior** — the registry supplies selection, persistence, browser matching, key fallback, and `<html lang>`; it does not add plural rules or bidirectional layout.
