# Security policy

## Reporting a vulnerability

Please do not disclose security issues through a public issue. Use GitHub's private vulnerability reporting for this repository when available. Include the affected version, reproduction steps, impact, and any suggested mitigation. Maintainers should acknowledge a report within five business days.

## Secure deployment baseline

- Set a strong `CONTROL_PLANE_API_KEY` before exposing the API beyond a single-user local environment.
- Set `SENSOR_COMMAND_SIGNING_KEY` to at least 32 random bytes. Production startup fails when it is absent or undersized so projected sensors never inherit the public development key.
- Terminate TLS at a trusted reverse proxy and restrict administrative access through an identity-aware gateway.
- Set `CORS_ORIGIN` to the exact administrative console origin.
- Keep the data directory on encrypted storage with access restricted to the service identity.
- Require TLS and scoped service credentials for remote PostgreSQL and Redis instances; keep both services on private networks and never publish their ports directly.
- Enable OIDC or SAML for shared deployments, require MFA evidence, and map only trusted identity-provider groups to AIDecepticon roles.
- Map only trusted identity-provider claims to organization IDs, scope API credentials with `CONTROL_PLANE_API_ORGANIZATIONS`, and test cross-organization denial before onboarding managed customers.
- Store `SESSION_SECRET`, OIDC client secrets, SAML certificates, secret and backup encryption keyrings, audit signing keys, and scoped API credentials in the deployment secret manager rather than source control or container images.
- Prefer Vault Transit or AWS KMS for provider credentials. Local AES-256-GCM mode requires an externally managed `SECRET_LOCAL_KEYS` keyring; never store that keyring beside the encrypted data or in a container image.
- Retain retired secret, backup, and audit key IDs until every dependent secret, archive, or audit event has aged out. Removing a historical key prevents decryption or integrity verification.
- Ship `administrative_audit_events` to immutable external retention. PostgreSQL triggers block application-level updates, deletes, and truncation, while the HMAC chain exposes offline tampering.
- Use HTTPS for authenticated deployments. SAML POST binding always requires HTTPS and OIDC production startup rejects an HTTP public URL.
- Store encrypted archives off-host and separately from `BACKUP_ENCRYPTION_KEYS`. Validate them regularly, preserve every referenced secret-provider and audit-signing key, and test full restoration in an isolated environment before expanding the sensor fleet. Redis is delivery acceleration and session state; PostgreSQL or JSON remains the durable control-plane source of truth.
- Never embed live production credentials in a deception asset.
- Deny decoys outbound access except for the explicit telemetry channel to the control plane.
- Run projected workloads in isolated networks, namespaces, accounts, or subscriptions with no route back into production.
- Treat automatic endpoint or identity containment as a privileged action requiring scoped provider credentials and an approval policy.
- Rotate API credentials, review the audit trail, and test restoration procedures regularly.

## Supported versions

Until the first stable release, only the latest commit on the default branch receives security fixes.
