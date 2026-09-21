package decoy

import (
	"io"
	"net/http"
	"testing"
	"time"
)

func TestHTTPDecoyReportsInteraction(t *testing.T) {
	events := make(chan Event, 1)
	manager := NewManager(func(event Event) { events <- event })
	defer manager.Close()

	status, err := manager.Deploy(Spec{ID: "http-test", Name: "Finance portal", Protocol: "http", Listen: "127.0.0.1:0"})
	if err != nil {
		t.Fatalf("deploy HTTP decoy: %v", err)
	}
	response, err := http.Get("http://" + status.Address + "/admin")
	if err != nil {
		t.Fatalf("request HTTP decoy: %v", err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", response.StatusCode)
	}

	select {
	case event := <-events:
		if event.DecoyID != "http-test" || event.Protocol != "http" {
			t.Fatalf("unexpected event: %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for decoy event")
	}
}

func TestDeployIsIdempotent(t *testing.T) {
	manager := NewManager(nil)
	defer manager.Close()
	spec := Spec{ID: "ssh-test", Name: "Jump host", Protocol: "ssh", Listen: "127.0.0.1:0"}
	first, err := manager.Deploy(spec)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Deploy(spec)
	if err != nil {
		t.Fatal(err)
	}
	if first.Address != second.Address {
		t.Fatalf("idempotent deployment changed address: %s != %s", first.Address, second.Address)
	}
}
