# AIDecepticon projection sensor

The projection sensor is a small Go service that receives signed commands from the AIDecepticon control plane and projects isolated deception services into an authorized network segment.

## Security model

- Enrollment uses a single-use token with a maximum 60-minute lifetime.
- The controller returns a unique bearer credential and per-sensor command-verification key.
- Every command is HMAC signed, scoped to one sensor, expires after five minutes, and has a unique ID.
- Remote plaintext controller URLs are rejected unless the explicit development override is enabled.
- Custom CA bundles and mTLS client certificates are supported.
- Credentials are stored with owner-only permissions; production deployments should use an OS keystore or mounted secret volume.
- Decoys listen only on explicitly commanded addresses and never receive production credentials from the controller.

## Build

```bash
go test ./...
go build -o bin/aidecepticon-sensor ./cmd/aidecepticon-sensor
```

Or build the non-root container:

```bash
docker build -t aidecepticon-sensor ./sensor
```

Tagged releases publish attested binaries for Windows, Linux, and macOS on AMD64 and ARM64 where supported. Verify the downloaded binary's checksum and its Sigstore-backed GitHub provenance before running it:

```bash
sha256sum --check aidecepticon-sensor-linux-amd64.sha256
gh attestation verify aidecepticon-sensor-linux-amd64 --repo rikterskale/AIDecepticon
```

Each binary also ships with an SPDX JSON SBOM. Release builds embed the tag as the sensor version reported to the controller.

## Enroll

Create a one-time enrollment token from **Protected surfaces → Add sensor** in the GUI, then run:

```bash
docker run --rm --network host \
  -e AID_CONTROLLER_URL=http://localhost:8787 \
  -e AID_ENROLLMENT_TOKEN=<one-time-token> \
  -e AID_SENSOR_NAME=edge-east-01 \
  -v aidecepticon-sensor-state:/var/lib/aidecepticon \
  aidecepticon-sensor
```

For a controller on another host, use HTTPS. For mTLS, mount the certificate material and configure:

- `AID_TLS_CERT_FILE`
- `AID_TLS_KEY_FILE`
- `AID_TLS_CA_FILE`

Other settings include `AID_SENSOR_ID`, `AID_STATE_PATH`, `AID_POLL_INTERVAL`, and `AID_HEARTBEAT_INTERVAL`.

## Supported MVP decoys

- HTTP portal
- SSH banner service
- PostgreSQL authentication service
- Redis authentication service
- SMB connection sentinel
- Generic TCP service

HTTP requests and TCP connections are converted to high-confidence incidents immediately. The runtime captures bounded protocol metadata only; it does not execute attacker-supplied content.
