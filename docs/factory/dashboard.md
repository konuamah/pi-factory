# Dashboard

Use this when the user asks about Factory dashboard status, startup, or configuration.

## Config

Dashboard settings live in `.factory/config.yaml`:

```yaml
dashboard:
  enabled: true
  port: 4199
  host: 127.0.0.1
  autoOpen: false
```

Defaults:

- `enabled: false`
- `port: 4199`
- `host: 127.0.0.1`
- `autoOpen: false`

Host must be local: `127.0.0.1`, `localhost`, or `::1`.

## Commands

```text
/factory dashboard status
/factory dashboard start
/factory dashboard open
/factory dashboard stop
```

## Behavior

- `start` launches the local dashboard server.
- `open` starts it if needed and opens a browser.
- `status` reports whether it is running.
- `stop` stops the in-process server.
- Auto-start happens when the Pi extension loads and `dashboard.enabled: true`.

## Static Build

If the UI is not built, the server can still report API status but may show a missing static dashboard message. Build the dashboard when needed.

## Verification

After changing dashboard config:

1. Run `/factory doctor`.
2. Run `/factory dashboard status`.
3. Run `/factory dashboard start` or restart Pi for auto-start.
