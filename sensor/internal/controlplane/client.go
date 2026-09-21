package controlplane

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/rikterskale/AIDecepticon/sensor/internal/config"
	"github.com/rikterskale/AIDecepticon/sensor/internal/state"
)

type Client struct {
	baseURL     string
	httpClient  *http.Client
	credentials state.Credentials
	version     string
}

type EnrollmentResponse struct {
	Sensor struct {
		ID string `json:"id"`
	} `json:"sensor"`
	AccessToken       string `json:"accessToken"`
	CommandSigningKey string `json:"commandSigningKey"`
	PollInterval      int    `json:"pollIntervalSeconds"`
}

type DecoyStatus struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Protocol  string `json:"protocol"`
	Address   string `json:"address"`
	StartedAt string `json:"startedAt"`
}

type Command struct {
	ID        string         `json:"id"`
	SensorID  string         `json:"sensorId"`
	Type      string         `json:"type"`
	Payload   map[string]any `json:"payload"`
	IssuedAt  string         `json:"issuedAt"`
	ExpiresAt string         `json:"expiresAt"`
	Signature string         `json:"signature"`
}

type Event struct {
	DecoyID     string         `json:"decoyId"`
	DecoyName   string         `json:"decoyName"`
	Protocol    string         `json:"protocol"`
	Source      string         `json:"source"`
	Destination string         `json:"destination"`
	Metadata    map[string]any `json:"metadata"`
}

func New(cfg config.Config, credentials state.Credentials, version string) (*Client, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.TLSInsecureSkipVerify {
		// Explicit development escape hatch. It is never enabled by default.
		tlsConfig.InsecureSkipVerify = true //nolint:gosec
	}
	if cfg.TLSCAFile != "" {
		pem, err := os.ReadFile(cfg.TLSCAFile)
		if err != nil {
			return nil, fmt.Errorf("read control-plane CA: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("AID_TLS_CA_FILE contains no valid certificates")
		}
		tlsConfig.RootCAs = pool
	}
	if cfg.TLSCertFile != "" {
		certificate, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile)
		if err != nil {
			return nil, fmt.Errorf("load sensor mTLS certificate: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{certificate}
	}

	return &Client{
		baseURL: cfg.ControllerURL,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig:       tlsConfig,
				MaxIdleConns:          8,
				IdleConnTimeout:       30 * time.Second,
				TLSHandshakeTimeout:   5 * time.Second,
				ResponseHeaderTimeout: 5 * time.Second,
			},
		},
		credentials: credentials,
		version:     version,
	}, nil
}

func (client *Client) SetCredentials(credentials state.Credentials) {
	client.credentials = credentials
}

func (client *Client) Enroll(ctx context.Context, cfg config.Config) (state.Credentials, error) {
	if cfg.EnrollmentToken == "" {
		return state.Credentials{}, errors.New("AID_ENROLLMENT_TOKEN is required for first enrollment")
	}
	payload := map[string]any{
		"enrollmentToken": cfg.EnrollmentToken,
		"sensorId":        cfg.SensorID,
		"name":            cfg.Name,
		"version":         client.version,
		"platform":        runtime.GOOS + "/" + runtime.GOARCH,
		"capabilities":    []string{"http", "ssh", "postgres", "redis", "smb", "tcp"},
	}
	var response EnrollmentResponse
	if err := client.request(ctx, http.MethodPost, "/api/v1/sensors/enroll", payload, false, &response); err != nil {
		return state.Credentials{}, err
	}
	credentials := state.Credentials{
		SensorID:          response.Sensor.ID,
		AccessToken:       response.AccessToken,
		CommandSigningKey: response.CommandSigningKey,
	}
	if credentials.SensorID == "" || credentials.AccessToken == "" || credentials.CommandSigningKey == "" {
		return state.Credentials{}, errors.New("controller returned incomplete enrollment credentials")
	}
	return credentials, nil
}

func (client *Client) Heartbeat(ctx context.Context, decoys []DecoyStatus) error {
	payload := map[string]any{"health": 100, "latency": 0, "version": client.version, "decoys": decoys}
	return client.request(ctx, http.MethodPost, fmt.Sprintf("/api/v1/sensors/%s/heartbeat", client.credentials.SensorID), payload, true, nil)
}

func (client *Client) Commands(ctx context.Context) ([]Command, error) {
	var response struct {
		Items []Command `json:"items"`
	}
	err := client.request(ctx, http.MethodGet, fmt.Sprintf("/api/v1/sensors/%s/commands", client.credentials.SensorID), nil, true, &response)
	return response.Items, err
}

func (client *Client) Acknowledge(ctx context.Context, commandID, status string, output any, commandError error) error {
	payload := map[string]any{"status": status, "output": output}
	if commandError != nil {
		payload["error"] = commandError.Error()
	}
	return client.request(ctx, http.MethodPost, fmt.Sprintf("/api/v1/sensors/%s/commands/%s/ack", client.credentials.SensorID, commandID), payload, true, nil)
}

func (client *Client) ReportEvent(ctx context.Context, event Event) error {
	return client.request(ctx, http.MethodPost, fmt.Sprintf("/api/v1/sensors/%s/events", client.credentials.SensorID), event, true, nil)
}

func (client *Client) Verify(command Command) error {
	if command.SensorID != client.credentials.SensorID {
		return errors.New("command targets a different sensor")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, command.ExpiresAt)
	if err != nil || time.Now().After(expiresAt) {
		return errors.New("command is expired or has an invalid expiry")
	}
	key, err := base64.RawURLEncoding.DecodeString(client.credentials.CommandSigningKey)
	if err != nil {
		return errors.New("invalid local command-signing key")
	}
	signature, err := base64.RawURLEncoding.DecodeString(command.Signature)
	if err != nil {
		return errors.New("invalid command signature encoding")
	}
	unsigned := map[string]any{
		"expiresAt": command.ExpiresAt,
		"id":        command.ID,
		"issuedAt":  command.IssuedAt,
		"payload":   command.Payload,
		"sensorId":  command.SensorID,
		"type":      command.Type,
	}
	var canonical bytes.Buffer
	encoder := json.NewEncoder(&canonical)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(unsigned); err != nil {
		return fmt.Errorf("canonicalize command: %w", err)
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(bytes.TrimSpace(canonical.Bytes()))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return errors.New("command signature verification failed")
	}
	return nil
}

func (client *Client) request(ctx context.Context, method, route string, payload any, authenticated bool, output any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, client.baseURL+route, body)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "AIDecepticon-Sensor/"+client.version)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if authenticated {
		request.Header.Set("Authorization", "Bearer "+client.credentials.AccessToken)
	}

	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("control-plane request: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read control-plane response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var problem struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &problem)
		message := strings.TrimSpace(problem.Error)
		if message == "" {
			message = strings.TrimSpace(string(data))
		}
		return fmt.Errorf("control plane returned %d: %s", response.StatusCode, message)
	}
	if output != nil && len(data) > 0 {
		if err := json.Unmarshal(data, output); err != nil {
			return fmt.Errorf("decode control-plane response: %w", err)
		}
	}
	return nil
}
