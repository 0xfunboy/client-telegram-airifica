# Setup

## Requirements

- Node.js `23.x`
- `pnpm`
- a Telegram bot token
- a running `client-airifica` runtime reachable over HTTP

## Install

```bash
pnpm install
cp .env.example .env
```

## Minimum Env

```env
AIRI3_TELEGRAM_BOT_TOKEN=
AIRI3_TELEGRAM_BOT_USERNAME=
AIRI3_TELEGRAM_INTERNAL_SECRET=
AIRI3_TELEGRAM_RUNTIME_BASE_URL=http://127.0.0.1:4040
```

## Build

```bash
pnpm build
```

## Start-up Notes

- the bot will stay disabled if `AIRI3_TELEGRAM_BOT_TOKEN` is empty
- the internal secret must match the secret configured in `client-airifica`
- `AIRI3_PUBLIC_APP_URL` should point to the public Airifica frontend for deep-link handoff
