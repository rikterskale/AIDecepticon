package controlplane

import (
	"testing"

	"github.com/rikterskale/AIDecepticon/sensor/internal/state"
)

func TestVerifyNodeSignedCommandVector(t *testing.T) {
	client := &Client{credentials: state.Credentials{
		SensorID:          "sen-vector",
		CommandSigningKey: "Y3Jvc3MtbGFuZ3VhZ2UtdGVzdC1rZXktMzItYnl0ZXMhIQ",
	}}
	command := Command{
		ID:        "cmd-vector",
		SensorID:  "sen-vector",
		Type:      "deploy_decoy",
		IssuedAt:  "2026-01-01T00:00:00.000Z",
		ExpiresAt: "2099-01-01T00:00:00.000Z",
		Signature: "34pBCARVWIS93_cPEyIO2Q95vlJsCo0jIbmv3CbfzJw",
		Payload: map[string]any{
			"banner":   "<h1>Admin</h1>",
			"id":       "decoy-1",
			"listen":   "127.0.0.1:0",
			"protocol": "http",
		},
	}
	if err := client.Verify(command); err != nil {
		t.Fatalf("verify Node-signed command: %v", err)
	}
}

func TestVerifyRejectsModifiedPayload(t *testing.T) {
	client := &Client{credentials: state.Credentials{
		SensorID:          "sen-vector",
		CommandSigningKey: "Y3Jvc3MtbGFuZ3VhZ2UtdGVzdC1rZXktMzItYnl0ZXMhIQ",
	}}
	command := Command{
		ID: "cmd-vector", SensorID: "sen-vector", Type: "deploy_decoy",
		IssuedAt: "2026-01-01T00:00:00.000Z", ExpiresAt: "2099-01-01T00:00:00.000Z",
		Signature: "34pBCARVWIS93_cPEyIO2Q95vlJsCo0jIbmv3CbfzJw",
		Payload:   map[string]any{"id": "attacker-modified"},
	}
	if err := client.Verify(command); err == nil {
		t.Fatal("expected modified command to fail verification")
	}
}
