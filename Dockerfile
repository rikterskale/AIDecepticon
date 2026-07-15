FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN addgroup --system deceptionflow && adduser --system --ingroup deceptionflow deceptionflow

COPY pyproject.toml README.md LICENSE ./
COPY deceptionflow ./deceptionflow
COPY lure_templates ./lure_templates
COPY exercise_profiles ./exercise_profiles
COPY detection_rules ./detection_rules

RUN pip install --no-cache-dir .

RUN mkdir -p /data /app/reports && chown -R deceptionflow:deceptionflow /data /app/reports
USER deceptionflow

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"

CMD ["deceptionflow", "serve", "--host", "0.0.0.0", "--port", "8080"]
