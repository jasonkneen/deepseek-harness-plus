# dsh-util-workspace-path

English | [中文](README.zh.md)

Browser-safe path helpers shared by Workspace-facing client and controller packages. The package joins Workspace-relative paths, abbreviates POSIX home directories for display, and derives Workspace titles from POSIX or Windows paths. It has no Cordis service or runtime state.

## Known Limitations and Deferred Work

- **Resolution is lexical** — it recognizes POSIX absolute paths, Windows drive paths, and UNC paths but does not access a filesystem or canonicalize `.` and `..` segments.
- **Home abbreviation is POSIX-only** — Windows paths remain unchanged because a portable browser cannot infer Windows home-path equivalence safely.
