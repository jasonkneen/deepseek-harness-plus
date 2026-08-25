# Agent Note: Full client copy rollout onto the typed locale seat

Status: implemented

English | [中文](2026-07-30-client-locale-full-rollout.zh.md)

## Problem

After the typed locale standard seat landed (`locale:` on register → framework-injected typed `t`), only four early adopters rode it; every other client package still shipped hardcoded, mixed-language literals. Migrating the rest required mechanisms the early adopters never touched: how registration-time text (nav rows, view-tab labels) refreshes on a language switch, and how the zero-Cordis ui-primitives atoms receive copy without depending on the runtime.

## Decision

**Registration-time text rides a label thunk.** A list registration's `label` accepts `SlotLabel = string | (() => string)`; owners projecting ledger rows resolve through `resolveSlotLabel` (never reading `options.label` raw) and make the read point follow the locale revision (outlets subscribe to the revision themselves; off-ledger projections such as the ui-settings nav fold the revision into their cache key and subscribe to both sources). Thunks evaluate per read, so a language switch causes zero ledger churn — no re-registration, versions stay put, and every `locale/change` re-registration wiring is deleted.

**Component copy rides the standard `t` seat; deep children take `t` as a plain prop** typed `XxxProps['t']`. The dictionary canon is unchanged: `zh satisfies Record<string, string>` is the key source and `en satisfies Record<XxxKey, string>` locks bilingual balance.

**Zero-Cordis atoms (ui-primitives) take copy as required props.** `HoverCard`, structured Tool blocks, JSON/Markdown renderers, `ConnectionBanner`, and modal chrome remain runtime-independent; localized plugins pass complete dictionary-driven label objects from their own `t` seat and memoize cache-sensitive objects on the `t` identity. The removal of language-bearing defaults and the complete prop inventory are owned by the [locale-owned copy decision](2026-08-23-locale-owned-client-ui-copy.md).

**Every product-authored UI phrase is translated.** Client fallbacks, design labels, trajectory inspection, accessibility names, and formatter units are dictionary-owned under the [locale-owned copy decision](2026-08-23-locale-owned-client-ui-copy.md). User/model/provider/wire text and protocol or code tokens remain verbatim data. Framework-free boot markup still runs before the locale service; the localized application replaces its product copy after activation.

**Derivation layers keep display text out of identity.** ui-workspace's `relativeTime` returns structured `{unit, n}` composed with dictionary templates by the renderer; blank session titles and the Ungrouped label derive from the `blank` flag / absent `workspaceId`, while internal values stay empty or stable; **blank rows are excluded from search entirely** (a bilingual display title cannot match a single-language query stably). Dates use no Intl: format templates live in the dictionaries (message clock `clock.md`/`clock.ymd`, workspace hover `date.ymd`) and the formatters take `t` as a parameter.

**Test and e2e doctrine**: `makeTranslate(...dicts)` (dsh-client-test-runtime) mirrors the service lookup chain (first-dict-wins, key fallback, `{name}` interpolation); component specs stub the `t` seat with it, typed against real props seats. Web e2e uniformly opens through `newEnglishPage` (an `en-US` browser) and the built-boot snapshot pins the same navigator language—goldens are immune to localization migrations; the settings language-switch scenario bypasses the helper and opens a `zh-CN` browser, since the provisional locale follows `navigator` before an explicit Host preference arrives ([browser-derived initial locale](../feature/2026-07-31-browser-derived-initial-locale.md)).

The "apply layer subscribes to `locale/change` and re-registers for fresh labels" mechanism in the [settings/locale/theme layering note](../../proposed/architecture/2026-07-25-client-settings-locale-theme.md) is superseded by this decision (thunk + revision lifecycle).

## Alternatives considered

- **Keep labels as strings and re-register on switch** (the early adopters' original shape): boot already registers once per package, and `locale/change` listeners re-registering amplifies into a storm; ledger version churn also busts every version-keyed projection cache. Thunks move the refresh cost to read points that already follow the revision.
- **A locale context/injection channel for ui-primitives**: breaks the zero-cordis boundary (atoms would depend on the runtime) and drags unlocalized consumers (ui-trajectory) along. Props let each consumer decide independently.
- **Translate external or wire error data**: rejected because provider and protocol diagnostics are evidence searched and compared verbatim. Product-authored surrounding failure chrome is translated; externally authored data is not.
- **`toLocaleString()`/Intl for dates**: follows the browser/OS language, not the app locale, guaranteeing mixed text after a switch; the dictionary templates are tiny and isomorphic to the message clock.
- **Blank rows matching search (against localized or stored titles)**: either choice yields "visible but unfindable" in one language; placeholder rows carry no information, so whole-row exclusion is the stable semantic.

## Consequences

- A language switch refreshes the whole UI instantly with zero re-registration; adopting a new package is three steps (dictionary + declare-merge + `locale: NS`), no hand-written glue.
- Cost: list-label consumers must know `resolveSlotLabel` (a raw `options.label` read can now hold a function); the `SlotLabel` type catches most misuse statically.
- ui-primitives require localized label props, so adding a primitive render site also adds an explicit copy owner; omission fails typechecking instead of selecting a hidden language.
- Pinning e2e to English means the zh copy surface is covered mainly by package-level component specs and the settings language-switch scenario; browser e2e no longer asserts zh copy. The opening/fallback locale (a browser naming no shipped language, or a non-browser run) is `en`, not zh — see [browser-derived initial locale](../feature/2026-07-31-browser-derived-initial-locale.md).
