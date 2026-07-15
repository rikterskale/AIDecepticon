# Contributing

1. Create a feature branch from `main`.
2. Add or update tests for behavior changes.
3. Run `make lint` and `make test`.
4. Keep lure adapters safe by construction: synthetic data only, metadata-only callbacks, and no active retaliation.
5. Open a pull request explaining the defensive use case, safety controls, and expected telemetry.

Contributions adding adapters should implement deploy, validate, rotate, and remove behavior and document rollback requirements.
