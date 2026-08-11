const SECRET_KEYS = ["apiKey", "password", "token", "secret", "authorization"];

export function createExecutionLogger({ sink = console } = {}) {
  return Object.freeze({
    info(event, payload = {}) {
      sink.info(JSON.stringify({ level: "info", event, ...redact(payload) }));
    },
    error(event, payload = {}) {
      sink.error(JSON.stringify({ level: "error", event, ...redact(payload) }));
    }
  });
}

export function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_KEYS.some((secretKey) => key.toLowerCase().includes(secretKey.toLowerCase()))
        ? "[REDACTED]"
        : redact(nested)
    ])
  );
}
