# File V2 blob store

`FileV2BlobStore` stores `<sha256>.blob` payloads and matching `<sha256>.json` metadata under its configured root. Reads and quota accounting must verify each path with `lstat` and reject symlinks or other non-regular files before consuming metadata or payload bytes.
