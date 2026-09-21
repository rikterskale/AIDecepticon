FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go test ./... && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/aidecepticon-sensor ./cmd/aidecepticon-sensor

FROM alpine:3.21
RUN apk add --no-cache ca-certificates && \
    addgroup -S -g 65532 sensor && \
    adduser -S -D -H -u 65532 -G sensor sensor
WORKDIR /var/lib/aidecepticon
COPY --from=build /out/aidecepticon-sensor /usr/local/bin/aidecepticon-sensor
RUN chown -R sensor:sensor /var/lib/aidecepticon
USER 65532:65532
ENV AID_STATE_PATH=/var/lib/aidecepticon/sensor-state.json
ENTRYPOINT ["/usr/local/bin/aidecepticon-sensor"]
