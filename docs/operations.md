# Operations

## Health Checks

- verify bot token is valid
- confirm `AIRI3_TELEGRAM_RUNTIME_BASE_URL` reaches the Airifica runtime
- confirm heartbeat is accepted by `client-airifica`
- ensure alert polling succeeds without 401 responses

## Common Failures

### Bot does not start

Check:

- `AIRI3_TELEGRAM_BOT_TOKEN`
- network egress to `api.telegram.org`
- build output exists

### Link flow fails

Check:

- `AIRI3_TELEGRAM_INTERNAL_SECRET`
- runtime base URL
- bot username alignment with runtime env

### Alerts do not arrive

Check:

- runtime outbox state
- internal secret mismatch
- stale heartbeat
- Telegram callback errors in logs

## Production Notes

- do not share the Telegram internal secret across unrelated runtimes
- keep the bot private-only unless you intentionally support groups
- prefer a dedicated runtime user and service unit rather than ad-hoc shell runs
