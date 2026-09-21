# AIDecepticon roadmap

This roadmap turns AIDecepticon from the current GUI-first control-plane foundation into a production-grade, distributed deception platform. Milestones are ordered by dependency and operational risk rather than by UI visibility.

## Product invariants

Every milestone must preserve these rules:

1. Decoys are non-pivotable and never contain live production credentials.
2. A deception interaction is a high-confidence signal with complete provenance.
3. Every routine operator journey is available through the guided GUI.
4. Agents and sensors use least privilege, authenticated control channels, and signed instructions.
5. Automatic containment is explicit, scoped, reversible, and fully audited.

## Milestone 1 — Projection sensor MVP

Status: **MVP implemented; production hardening in progress**

- [x] Cross-platform Go sensor foundation suitable for static binaries and containers.
- [x] Single-use, expiring enrollment tokens created through the control-plane API and GUI.
- [x] Per-sensor bearer authentication after enrollment.
- [x] Optional mTLS client certificates and custom control-plane CA support.
- [x] Authenticated heartbeat, health, inventory, command polling, acknowledgement, and event ingestion.
- [x] Per-sensor HMAC-signed commands with expiry and replay-resistant command IDs.
- [x] Dynamic HTTP, SSH, PostgreSQL, Redis, SMB-connect, and generic TCP decoy listeners.
- [x] Immediate interaction forwarding into the control-plane incident workflow.
- [x] Local encrypted-transport enforcement for non-loopback control-plane URLs.
- [x] Container packaging and non-root runtime.
- [x] Unit and integration tests for enrollment, command signing, polling, acknowledgement, and telemetry.
- [x] Sigstore-attested release binaries for Windows, Linux, and macOS with embedded versions and checksums.
- [ ] Controller-driven upgrade and rollback.
- [ ] TPM/Keychain/libsecret-backed sensor credential storage.
- [ ] Production certificate authority integration and automatic mTLS certificate rotation.

Exit criteria: an operator can enroll a sensor from the GUI, deploy an isolated decoy through a signed command, see sensor health, and receive a high-confidence incident after interaction.

## Milestone 2 — Delivery safeguards and release engineering

Status: **CI baseline implemented; release hardening in progress**

- [x] CI for TypeScript checks, unit tests, production build, npm audit, Go formatting, vet, tests, and binary build.
- [x] Container build verification for the control plane and projection sensor.
- [x] CodeQL analysis for JavaScript/TypeScript and Go.
- [x] Dependabot coverage for npm, Go modules, and GitHub Actions.
- [x] Playwright end-to-end tests covering deployment, canary creation, and projection-sensor enrollment journeys.
- [x] SPDX SBOM generation and Sigstore-backed provenance/SBOM attestations for sensor releases.
- [ ] Signed containers and release binaries with verification instructions.
- [ ] Branch protection with required CI and security checks.
- [ ] Architecture decision records and a maintained threat model.
- [ ] Reproducible release workflow, semantic versions, changelog, and upgrade tests.

## Milestone 3 — Production control plane

Status: **Persistence, resilient delivery, enterprise access control, and governance implemented**

- [x] PostgreSQL persistence with ordered, versioned schema migrations and safe single-runner migration locking.
- [x] Redis-compatible sensor-command delivery queue with persistent source-of-truth recovery and local fallback.
- [x] Bounded retry/backoff policies, dead-letter handling, scheduled acknowledgement recovery, and guided GUI remediation.
- [x] OIDC Authorization Code + PKCE and signed SAML authentication with Redis sessions and MFA-aware policy enforcement.
- [x] Fine-grained RBAC for platform administrator, analyst, deception engineer, auditor, and scoped service roles.
- [x] Encrypted secret storage with local AES-256-GCM, HashiCorp Vault Transit, and AWS KMS providers, key rotation, server-side verification, and a guided GUI.
- [x] Append-only, HMAC-chained administrative and response audit trails with PostgreSQL mutation guards, automatic sensitive-field redaction, integrity verification, and a guided GUI.
- [ ] Multi-tenancy and MSSP organization boundaries.
- [ ] High availability, backups, disaster recovery, and zero-downtime upgrades.
- [ ] Prometheus metrics, OpenTelemetry traces, structured logs, and service-level objectives.

## Milestone 4 — Token and endpoint delivery

Status: **Planned**

- [ ] Windows, macOS, and Linux token builders.
- [ ] Honey documents for Office, PDF, archive, and developer file formats.
- [ ] Fake credentials for Windows Vault, SSH, browser, CLI, and application configuration paths.
- [ ] RDP, SSH, SMB/Samba, ODBC, database, and cloud connection breadcrumbs.
- [ ] Cloud keys, API tokens, OAuth client lures, and CI/CD secrets.
- [ ] Endpoint ransomware tripwires and advanced file-access detections.
- [ ] GPO/SCCM, Intune, Jamf, Ansible, and package-manager delivery.
- [ ] Placement groups, staged rollout, validation, revocation, and complete cleanup from the GUI.

## Milestone 5 — Functional SOC integrations

Status: **Planned**

- [ ] Splunk Enterprise Security, Elastic Security, and Microsoft Sentinel exporters.
- [ ] Syslog, CEF, LEEF, ECS, STIX 2.1, and TAXII support.
- [ ] CrowdStrike Falcon and Microsoft Defender endpoint isolation.
- [ ] Tines, Cortex XSOAR, Splunk SOAR, and generic signed-webhook playbooks.
- [ ] Firewall, NAC, identity, and cloud quarantine adapters.
- [ ] Provider credential scopes, dry runs, approval policies, rollback, and response audit logs.
- [ ] Integration health, delivery retry, dead-letter handling, and test-event workflow in the GUI.

## Milestone 6 — Multi-domain identity deception

Status: **Planned**

- [ ] Scoped read-only discovery across multiple forests and domains.
- [ ] Honey users, computers, SPNs, groups, trusts, service accounts, and privileged paths.
- [ ] Safe object lifecycle, uniqueness, cleanup, and replication awareness.
- [ ] Kerberoasting, AS-REP roasting, DCSync, directory reconnaissance, delegation abuse, and Golden SAML detections.
- [ ] Entra ID and hybrid identity deception.
- [ ] AI-assisted, environment-matched names and attributes with human approval.
- [ ] Identity attack-path visualization and recommended placement.

## Milestone 7 — Cloud-native deception

Status: **Planned**

- [ ] AWS, Azure, and GCP account/subscription/project onboarding.
- [ ] Agentless deployment through native cloud APIs.
- [ ] IAM identities, roles, policies, access keys, metadata, secrets, and storage lures.
- [ ] VM, container, Kubernetes, serverless, registry, and managed-database deception.
- [ ] Multi-account placement policy and infrastructure-as-code modules.
- [ ] Cloud event correlation, privilege-path analysis, and automated quarantine.
- [ ] Provider cost estimation, quotas, cleanup, and drift detection.

## Milestone 8 — Deception runtime breadth

Status: **Planned**

- [ ] High-fidelity SSH, SMB, RDP, HTTP/S, database, mail, VPN, and directory personas.
- [ ] Custom server, service, application, API, and asset templates.
- [ ] IT, OT, IoT, IoMT, and rugged-edge decoy packs.
- [ ] Layer 2 MITM detection for LLMNR, NBNS, mDNS, ARP, and relay behavior.
- [ ] Zero Trust private-application clones and access-policy bypass traps.
- [ ] Sandboxed medium- and high-interaction runtimes with capture, reset, and forensic export.
- [ ] Bring-your-own golden image with hardening validation.

## Milestone 9 — AI and GenAI deception

Status: **Planned**

- [ ] Synthetic model APIs, inference endpoints, vector stores, model registries, and training artifacts.
- [ ] Deceptive MCP servers, tools, resources, agent credentials, and tool outputs.
- [ ] Prompt-injection, tool-abuse, model-theft, secret-extraction, and agent-breakout detections.
- [ ] Behavioral analysis for machine-speed enumeration, parallel paths, and uniform dwell time.
- [ ] Safe AI recommendations for placement, personas, and coverage gaps.
- [ ] Explainable scoring with deterministic rules retained for every alert.
- [ ] Evaluation harness for human, scripted, and agentic attack sequences.

## Milestone 10 — Enterprise operations

Status: **Planned**

- [ ] Fleet scale testing and regional controller topology.
- [ ] Policy-as-code, full API coverage, SDKs, CLI, Terraform provider, and GitOps workflows.
- [ ] Air-gapped installation, offline updates, and private registry support.
- [ ] Accessibility conformance, localization, and guided onboarding for every role.
- [ ] Compliance mappings, retention controls, evidence exports, and legal hold.
- [ ] Performance, resilience, chaos, penetration, and third-party security testing.
- [ ] Stable 1.0 release with long-term support policy.

## Near-term delivery sequence

1. Complete the projection-sensor exit criteria and publish signed preview binaries.
2. Add PostgreSQL and the durable command queue before expanding fleet size.
3. Add multi-tenancy boundaries, backup/restore automation, and control-plane observability.
4. Deliver real endpoint token builders and one SIEM, one SOAR, and one EDR adapter.
5. Implement multi-domain AD and AWS as the first identity and cloud controllers.
6. Expand decoy protocols and AI-infrastructure deception behind the same sensor contract.
