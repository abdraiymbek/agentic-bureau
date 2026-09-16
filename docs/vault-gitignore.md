# Recommended `.gitignore` for a simple.directory vault

Most users will git-init their vault. The `.simple-directory/index.db` is rebuildable from the markdown — committing it would be churn-heavy. The `.simple-directory/config.toml` is *not* gitignored, since users may want vault-local config under version control.

Drop this snippet into `<vault>/.gitignore`:

```gitignore
# simple.directory-managed derived state — rebuildable from .md files
.simple-directory/index.db
.simple-directory/index.db-wal
.simple-directory/index.db-shm
.simple-directory/simple-directory.log
.simple-directory/recovery/        # appears at L7 (sync) — pre-merge snapshots
```

## What about `.assets/`?

Most PKM users want assets (images, PDFs) tracked in git so the vault stays self-contained. If you have very large binaries you'd rather not commit, you can add `.assets/` to your vault's `.gitignore`, but the recommended default is to keep them tracked.
