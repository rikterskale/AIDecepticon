.PHONY: install test lint format run docker-up docker-down clean

install:
	python -m pip install -e ".[dev]"

test:
	pytest --cov=deceptionflow --cov-report=term-missing

lint:
	ruff check .

format:
	ruff format .
	ruff check --fix .

run:
	deceptionflow serve --host 0.0.0.0 --port 8080

docker-up:
	docker compose up --build

docker-down:
	docker compose down

clean:
	rm -rf .pytest_cache .ruff_cache .coverage htmlcov build dist *.egg-info
