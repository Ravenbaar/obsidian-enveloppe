# Fork development rules

- This is the public Enveloppe plugin fork. Never commit notes, private website configuration, tokens, vault paths, runtime settings or client databases.
- Keep master available for upstream tracking. The personal publishing build starts from upstream 7.8.2 on codex/publish-center; do not mix upstream 8.x changes into that stable release without separate compatibility testing.
- Preserve the AGPL-3.0 license and upstream attribution. Use Conventional Commits without Co-Authored-By trailers.
- Retain the plugin ID to preserve existing configuration and SecretStorage. Publishing state must never copy tokens or send GitHub credentials to public websites.
- New workflow dependencies must be pinned to full commits. Verify types, publication behavior tests and production build before delivery; distinguish simulated behavior, native Obsidian checks and actual deployment.
- PUBLISHING.md contains usage and maintenance instructions; changes to public documentation must contain only generic examples and non-sensitive evidence.
