# Documentation

Public documentation describes the current release only.

- [README (中文)](../README.md) ｜ [README (English)](../README.en.md): features, installation, limitations.
- [Getting started](USAGE.md): install, first run, LAN access, tunnel-based remote operation.
- [Tunnel deployment](TUNNEL.md): expose the guard through Cloudflare Tunnel / own server / Tailscale, per platform (Windows, Linux, macOS).
- [Deployment](DEPLOY.md): Host setup, guard exposure, operations.
- [Release process](RELEASE.md): CI/CD versioning, publishing controls, troubleshooting.
- [Architecture](ARCHITECTURE.md): data paths, identity, authorization, persistence.
- [Design contract](DESIGN.md): role semantics, state ownership, supported boundaries.
- [API permission matrix](API-MATRIX.md): every endpoint × role, generated from the build artifacts.
- [Technical notes](TECHNICAL.md): document scope and archive policy.

Internal plans, investigations, history, audits, and environment-specific acceptance notes are maintained locally under the ignored `dev/docs/` tree. They are not published as package content or treated as general release guarantees.
