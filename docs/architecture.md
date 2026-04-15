# Architecture

`client-telegram-airifica` is intentionally thin. It owns Telegram UX and delegates authoritative trading/account state to `client-airifica`.

## Responsibilities

- long-poll Telegram updates
- render chat panels and proposal cards
- keep pending action input state per chat
- report analytics and heartbeat to the runtime
- deliver alert messages from the runtime outbox

## State Ownership

### Owned locally by the Telegram client

- current Telegram polling offset
- pending action input per chat
- ephemeral proposal draft state tied to Telegram messages
- current panel message ids

### Owned by `client-airifica`

- wallet ↔ Telegram link mapping
- trade ledger
- onchain spot snapshots
- positions and history
- runtime analytics
- alert outbox

This separation is deliberate: the Telegram client should stay stateless enough to restart safely.

## Message Flow

1. user sends command or taps callback button
2. Telegram client parses command / callback
3. if needed, it calls internal Airifica endpoints
4. it renders a Telegram-native panel or action response
5. periodic alert loop polls runtime outbox and delivers queued alerts
