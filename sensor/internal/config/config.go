package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ControllerURL             string
	EnrollmentToken           string
	SensorID                  string
	Name                      string
	StatePath                 string
	PollInterval              time.Duration
	HeartbeatInterval         time.Duration
	TLSCertFile               string
	TLSKeyFile                string
	TLSCAFile                 string
	TLSInsecureSkipVerify     bool
	AllowInsecureControlPlane bool
}

func Load() (Config, error) {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "projection-sensor"
	}

	cfg := Config{
		ControllerURL:             strings.TrimRight(env("AID_CONTROLLER_URL", "http://localhost:8787"), "/"),
		EnrollmentToken:           os.Getenv("AID_ENROLLMENT_TOKEN"),
		SensorID:                  os.Getenv("AID_SENSOR_ID"),
		Name:                      env("AID_SENSOR_NAME", hostname),
		StatePath:                 env("AID_STATE_PATH", filepath.Join(".", "sensor-state.json")),
		PollInterval:              durationEnv("AID_POLL_INTERVAL", 10*time.Second),
		HeartbeatInterval:         durationEnv("AID_HEARTBEAT_INTERVAL", 15*time.Second),
		TLSCertFile:               os.Getenv("AID_TLS_CERT_FILE"),
		TLSKeyFile:                os.Getenv("AID_TLS_KEY_FILE"),
		TLSCAFile:                 os.Getenv("AID_TLS_CA_FILE"),
		TLSInsecureSkipVerify:     boolEnv("AID_TLS_INSECURE_SKIP_VERIFY"),
		AllowInsecureControlPlane: boolEnv("AID_ALLOW_INSECURE_CONTROL_PLANE"),
	}

	if cfg.ControllerURL == "" {
		return Config{}, errors.New("AID_CONTROLLER_URL cannot be empty")
	}
	parsed, err := url.Parse(cfg.ControllerURL)
	if err != nil || parsed.Hostname() == "" {
		return Config{}, fmt.Errorf("invalid AID_CONTROLLER_URL %q", cfg.ControllerURL)
	}
	if parsed.Scheme != "https" && !isLoopback(parsed.Hostname()) && !cfg.AllowInsecureControlPlane {
		return Config{}, errors.New("non-loopback control-plane URLs must use HTTPS; set AID_ALLOW_INSECURE_CONTROL_PLANE=true only for an isolated development network")
	}
	if (cfg.TLSCertFile == "") != (cfg.TLSKeyFile == "") {
		return Config{}, errors.New("AID_TLS_CERT_FILE and AID_TLS_KEY_FILE must be configured together")
	}
	if cfg.PollInterval < time.Second || cfg.HeartbeatInterval < time.Second {
		return Config{}, errors.New("poll and heartbeat intervals must be at least one second")
	}
	return cfg, nil
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func boolEnv(key string) bool {
	value, _ := strconv.ParseBool(os.Getenv(key))
	return value
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}
