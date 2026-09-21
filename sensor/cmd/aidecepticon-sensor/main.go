package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rikterskale/AIDecepticon/sensor/internal/config"
	"github.com/rikterskale/AIDecepticon/sensor/internal/controlplane"
	"github.com/rikterskale/AIDecepticon/sensor/internal/decoy"
	"github.com/rikterskale/AIDecepticon/sensor/internal/state"
)

var version = "0.1.0-dev"

func main() {
	logger := log.New(os.Stdout, "aidecepticon-sensor ", log.LstdFlags|log.LUTC)
	if err := run(logger); err != nil {
		logger.Printf("fatal: %v", err)
		os.Exit(1)
	}
}

func run(logger *log.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	credentials, err := state.Load(cfg.StatePath)
	if err != nil {
		return err
	}
	client, err := controlplane.New(cfg, credentials, version)
	if err != nil {
		return err
	}

	if credentials.SensorID == "" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		credentials, err = client.Enroll(ctx, cfg)
		cancel()
		if err != nil {
			return fmt.Errorf("enroll sensor: %w", err)
		}
		if err := state.Save(cfg.StatePath, credentials); err != nil {
			return err
		}
		client.SetCredentials(credentials)
		logger.Printf("enrolled sensor %s; credentials saved to %s", credentials.SensorID, cfg.StatePath)
	} else {
		logger.Printf("loaded sensor identity %s", credentials.SensorID)
	}

	manager := decoy.NewManager(func(event decoy.Event) {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		err := client.ReportEvent(ctx, controlplane.Event{
			DecoyID: event.DecoyID, DecoyName: event.DecoyName, Protocol: event.Protocol,
			Source: event.Source, Destination: event.Destination, Metadata: event.Metadata,
		})
		if err != nil {
			logger.Printf("event delivery failed for decoy %s: %v", event.DecoyID, err)
		} else {
			logger.Printf("reported %s interaction with decoy %s from %s", event.Protocol, event.DecoyID, event.Source)
		}
	})
	defer manager.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	heartbeatTicker := time.NewTicker(cfg.HeartbeatInterval)
	pollTicker := time.NewTicker(cfg.PollInterval)
	defer heartbeatTicker.Stop()
	defer pollTicker.Stop()

	sendHeartbeat(ctx, logger, client, manager)
	pollCommands(ctx, logger, client, manager)
	for {
		select {
		case <-ctx.Done():
			logger.Printf("shutdown requested")
			return nil
		case <-heartbeatTicker.C:
			sendHeartbeat(ctx, logger, client, manager)
		case <-pollTicker.C:
			pollCommands(ctx, logger, client, manager)
		}
	}
}

func sendHeartbeat(parent context.Context, logger *log.Logger, client *controlplane.Client, manager *decoy.Manager) {
	statuses := manager.Snapshot()
	decoys := make([]controlplane.DecoyStatus, 0, len(statuses))
	for _, status := range statuses {
		decoys = append(decoys, controlplane.DecoyStatus(status))
	}
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	if err := client.Heartbeat(ctx, decoys); err != nil && !errors.Is(err, context.Canceled) {
		logger.Printf("heartbeat failed: %v", err)
	}
}

func pollCommands(parent context.Context, logger *log.Logger, client *controlplane.Client, manager *decoy.Manager) {
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	commands, err := client.Commands(ctx)
	cancel()
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			logger.Printf("command poll failed: %v", err)
		}
		return
	}
	for _, command := range commands {
		output, commandErr := executeCommand(client, manager, command)
		status := "acknowledged"
		if commandErr != nil {
			status = "failed"
			logger.Printf("command %s failed: %v", command.ID, commandErr)
		} else {
			logger.Printf("command %s (%s) completed", command.ID, command.Type)
		}
		ackCtx, ackCancel := context.WithTimeout(parent, 8*time.Second)
		ackErr := client.Acknowledge(ackCtx, command.ID, status, output, commandErr)
		ackCancel()
		if ackErr != nil {
			logger.Printf("command %s acknowledgement failed: %v", command.ID, ackErr)
		}
	}
}

func executeCommand(client *controlplane.Client, manager *decoy.Manager, command controlplane.Command) (any, error) {
	if err := client.Verify(command); err != nil {
		return nil, err
	}
	switch command.Type {
	case "deploy_decoy":
		encoded, _ := json.Marshal(command.Payload)
		var spec decoy.Spec
		if err := json.Unmarshal(encoded, &spec); err != nil {
			return nil, fmt.Errorf("decode deploy specification: %w", err)
		}
		return manager.Deploy(spec)
	case "stop_decoy":
		id, _ := command.Payload["id"].(string)
		if id == "" {
			return nil, errors.New("stop_decoy requires payload.id")
		}
		return map[string]string{"id": id, "status": "stopped"}, manager.Stop(id)
	case "snapshot":
		return manager.Snapshot(), nil
	default:
		return nil, fmt.Errorf("unsupported command type %q", command.Type)
	}
}
