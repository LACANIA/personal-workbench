# personal-safe-fs

An out-of-tree DeepSeek Harness Cordis plugin that registers three model-facing tools:

- `personal_read`
- `personal_glob`
- `personal_grep`

Each request resolves an existing target to its canonical filesystem path before checking the configured allowlist. Search output is bounded before it reaches the model. The plugin has no write operation and never invokes a shell.

The Profile supplies `policyPath`; the policy document uses JSON-compatible YAML syntax so parsing requires no extra package.
