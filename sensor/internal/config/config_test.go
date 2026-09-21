package config

import "testing"

func TestRejectsRemotePlaintextController(t *testing.T) {
	t.Setenv("AID_CONTROLLER_URL", "http://192.0.2.10:8787")
	t.Setenv("AID_ALLOW_INSECURE_CONTROL_PLANE", "false")
	if _, err := Load(); err == nil {
		t.Fatal("expected remote plaintext controller to be rejected")
	}
}

func TestAllowsLoopbackController(t *testing.T) {
	t.Setenv("AID_CONTROLLER_URL", "http://127.0.0.1:8787")
	if _, err := Load(); err != nil {
		t.Fatalf("expected loopback controller to be allowed: %v", err)
	}
}
