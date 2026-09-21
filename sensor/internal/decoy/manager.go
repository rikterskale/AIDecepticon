package decoy

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Spec struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Protocol string         `json:"protocol"`
	Listen   string         `json:"listen"`
	Banner   string         `json:"banner,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

type Status struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Protocol  string `json:"protocol"`
	Address   string `json:"address"`
	StartedAt string `json:"startedAt"`
}

type Event struct {
	DecoyID     string
	DecoyName   string
	Protocol    string
	Source      string
	Destination string
	Metadata    map[string]any
}

type Reporter func(Event)

type instance struct {
	spec   Spec
	status Status
	stop   func(context.Context) error
}

type Manager struct {
	mu        sync.RWMutex
	instances map[string]*instance
	reporter  Reporter
}

func NewManager(reporter Reporter) *Manager {
	return &Manager{instances: make(map[string]*instance), reporter: reporter}
}

func (manager *Manager) Deploy(spec Spec) (Status, error) {
	if spec.ID == "" || spec.Name == "" || spec.Listen == "" {
		return Status{}, errors.New("decoy id, name, and listen address are required")
	}
	spec.Protocol = strings.ToLower(spec.Protocol)
	if !supportedProtocol(spec.Protocol) {
		return Status{}, fmt.Errorf("unsupported decoy protocol %q", spec.Protocol)
	}

	manager.mu.Lock()
	defer manager.mu.Unlock()
	if current, exists := manager.instances[spec.ID]; exists {
		if current.spec.Protocol == spec.Protocol && current.spec.Listen == spec.Listen && current.spec.Name == spec.Name {
			return current.status, nil
		}
		return Status{}, fmt.Errorf("decoy %s already exists with a different specification", spec.ID)
	}
	if len(manager.instances) >= 100 {
		return Status{}, errors.New("sensor decoy limit reached")
	}

	var created *instance
	var err error
	if spec.Protocol == "http" {
		created, err = manager.deployHTTP(spec)
	} else {
		created, err = manager.deployTCP(spec)
	}
	if err != nil {
		return Status{}, err
	}
	manager.instances[spec.ID] = created
	return created.status, nil
}

func (manager *Manager) Stop(id string) error {
	manager.mu.Lock()
	current, exists := manager.instances[id]
	if exists {
		delete(manager.instances, id)
	}
	manager.mu.Unlock()
	if !exists {
		return fmt.Errorf("decoy %s not found", id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return current.stop(ctx)
}

func (manager *Manager) Snapshot() []Status {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	statuses := make([]Status, 0, len(manager.instances))
	for _, current := range manager.instances {
		statuses = append(statuses, current.status)
	}
	return statuses
}

func (manager *Manager) Close() {
	manager.mu.Lock()
	instances := manager.instances
	manager.instances = make(map[string]*instance)
	manager.mu.Unlock()
	for _, current := range instances {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = current.stop(ctx)
		cancel()
	}
}

func (manager *Manager) deployHTTP(spec Spec) (*instance, error) {
	listener, err := net.Listen("tcp", spec.Listen)
	if err != nil {
		return nil, fmt.Errorf("listen for HTTP decoy: %w", err)
	}
	address := listener.Addr().String()
	banner := spec.Banner
	if banner == "" {
		banner = "<!doctype html><title>Operations Portal</title><h1>Operations Portal</h1><p>Authentication required.</p>"
	}
	server := &http.Server{
		ReadHeaderTimeout: 4 * time.Second,
		ReadTimeout:       6 * time.Second,
		WriteTimeout:      6 * time.Second,
		IdleTimeout:       10 * time.Second,
		MaxHeaderBytes:    16 << 10,
		Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			manager.report(Event{
				DecoyID: spec.ID, DecoyName: spec.Name, Protocol: spec.Protocol,
				Source: request.RemoteAddr, Destination: address,
				Metadata: map[string]any{"method": request.Method, "path": request.URL.Path, "userAgent": request.UserAgent(), "host": request.Host},
			})
			response.Header().Set("Content-Type", "text/html; charset=utf-8")
			response.Header().Set("Server", "nginx")
			response.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(response, banner)
		}),
	}
	go func() { _ = server.Serve(listener) }()
	return &instance{
		spec:   spec,
		status: Status{ID: spec.ID, Name: spec.Name, Protocol: spec.Protocol, Address: address, StartedAt: time.Now().UTC().Format(time.RFC3339)},
		stop:   server.Shutdown,
	}, nil
}

func (manager *Manager) deployTCP(spec Spec) (*instance, error) {
	listener, err := net.Listen("tcp", spec.Listen)
	if err != nil {
		return nil, fmt.Errorf("listen for %s decoy: %w", spec.Protocol, err)
	}
	address := listener.Addr().String()
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go manager.handleTCPConnection(spec, address, connection)
		}
	}()
	return &instance{
		spec:   spec,
		status: Status{ID: spec.ID, Name: spec.Name, Protocol: spec.Protocol, Address: address, StartedAt: time.Now().UTC().Format(time.RFC3339)},
		stop: func(ctx context.Context) error {
			if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				return err
			}
			select {
			case <-stopped:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	}, nil
}

func (manager *Manager) handleTCPConnection(spec Spec, address string, connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(3 * time.Second))
	if banner := protocolBanner(spec); len(banner) > 0 {
		_, _ = connection.Write(banner)
	}
	buffer := make([]byte, 512)
	read, _ := connection.Read(buffer)
	metadata := map[string]any{}
	if read > 0 {
		metadata["firstBytesHex"] = hex.EncodeToString(buffer[:read])
		metadata["bytesRead"] = read
	}
	manager.report(Event{
		DecoyID: spec.ID, DecoyName: spec.Name, Protocol: spec.Protocol,
		Source: connection.RemoteAddr().String(), Destination: address, Metadata: metadata,
	})
}

func (manager *Manager) report(event Event) {
	if manager.reporter != nil {
		manager.reporter(event)
	}
}

func supportedProtocol(protocol string) bool {
	switch protocol {
	case "http", "ssh", "postgres", "redis", "smb", "tcp":
		return true
	default:
		return false
	}
}

func protocolBanner(spec Spec) []byte {
	if spec.Banner != "" {
		return []byte(spec.Banner)
	}
	switch spec.Protocol {
	case "ssh":
		return []byte("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n")
	case "redis":
		return []byte("-NOAUTH Authentication required.\r\n")
	case "postgres":
		return []byte("E\x00\x00\x00\x1fSFATAL\x00C28000\x00Mauthentication failed\x00\x00")
	default:
		return nil
	}
}
