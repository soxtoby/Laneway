# Support SHA-1 and SHA-256 object formats

V1 opens repositories using either Git object format reported by system Git: `sha1` or `sha256`. Workbench treats object IDs as opaque values associated with that format and tests Git-facing behaviour against both; it rejects unknown formats with an explanation. Opening a SHA-256 repository does not imply remote or provider interoperability, which each consuming action validates when required.
