# Support SHA-1 and SHA-256 object formats

V1 opens repositories using either Git object format reported by system Git: `sha1` or `sha256`. Laneway treats object IDs as opaque values associated with that format and tests every format-sensitive behaviour against both; it rejects unknown formats with an explanation. Format-insensitive Git behaviour need not be duplicated. Opening a SHA-256 repository does not imply remote or provider interoperability, which each consuming action validates when required.
