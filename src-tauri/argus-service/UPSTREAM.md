# argus-service

Placeholder porting record. A1 completes this file.

- Upstream: [Argus](https://github.com/Ray-lea/Argus), version 0.3.4.
- Upstream license: AGPL-3.0-or-later; this crate keeps the AGPL-3.0 terms and
  the project as a whole is AGPL-3.0-only.
- Scope: the minimal privileged service (install, server, pipe, protocol,
  security, process operations, ETW network and disk snapshots). The PawnIO
  driver, sensors, task-manager replacement, admin helpers, handle queries and
  legacy migration are deliberately not ported.
- A0 created the crate skeleton and the frozen client/status surface only. B2
  ports the service.
