package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type Credentials struct {
	SensorID          string `json:"sensorId"`
	AccessToken       string `json:"accessToken"`
	CommandSigningKey string `json:"commandSigningKey"`
}

func Load(path string) (Credentials, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Credentials{}, nil
	}
	if err != nil {
		return Credentials{}, fmt.Errorf("read sensor state: %w", err)
	}
	var credentials Credentials
	if err := json.Unmarshal(data, &credentials); err != nil {
		return Credentials{}, fmt.Errorf("decode sensor state: %w", err)
	}
	if credentials.SensorID == "" || credentials.AccessToken == "" || credentials.CommandSigningKey == "" {
		return Credentials{}, errors.New("sensor state is incomplete; remove it and enroll again")
	}
	return credentials, nil
}

func Save(path string, credentials Credentials) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create sensor state directory: %w", err)
	}
	data, err := json.MarshalIndent(credentials, "", "  ")
	if err != nil {
		return fmt.Errorf("encode sensor state: %w", err)
	}
	temporaryPath := path + ".tmp"
	if err := os.WriteFile(temporaryPath, data, 0o600); err != nil {
		return fmt.Errorf("write sensor state: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("commit sensor state: %w", err)
	}
	return nil
}
