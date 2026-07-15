# Security Policy

## Supported versions

The project is currently pre-1.0. Security fixes are applied to the latest commit on the `main` branch.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose sensitive event data, bypass collector controls, or cause unsafe lure deployment. Send a private report to the repository owner and include:

- Affected version or commit.
- Reproduction steps using synthetic data.
- Security impact.
- Suggested mitigation, when available.

## Safety invariants

DeceptionFlow lures must not:

- Authenticate to a real service.
- Contain production data or real credentials.
- Permit lateral movement.
- Execute code on the interacting host.
- Collect payload content beyond approved metadata.
- Perform retaliation or exploitation.
