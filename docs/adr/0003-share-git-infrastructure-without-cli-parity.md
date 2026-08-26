# Share Git infrastructure without CLI parity

Repository entry and Workbench actions share in-process infrastructure for selecting and running system Git, validating action-specific prerequisites, and redacting failures. Electron main owns GUI-only open, clone, and initialization flows; the Workbench Engine exposes coarse-grained, scriptable Workbench actions rather than duplicating Git commands. Each caller validates only the repository facts its action requires, caching them for that process only; one application-wide Git executable override takes precedence over `PATH`.
