# Setup and running the bot

The full Slack app installation, testing, Docker deployment and recovery guide is in [README.md](README.md).

## Existing installation at this location

```sh
cd ~/Desktop/dev/slack-ticket-bot
```

Keep your current `.env` and `data` folder. Do not copy `.env.example` over your working `.env`.

To monitor more channels, edit your existing `.env` and set:

```dotenv
SLACK_CHANNEL_IDS=C0123456789,C9876543210
```

Replace these example IDs with your actual channel IDs. The old `SLACK_CHANNEL_ID` still works for one channel; when both settings exist, `SLACK_CHANNEL_IDS` wins.

Invite the bot into each channel with `/invite @Issue Acknowledger`, including private channels. Stop the current bot before starting another instance, then run:

```sh
npm start
```

For Docker installations, apply source and configuration changes with:

```sh
docker compose up -d --build
```

Test by posting a fresh top-level message and adding 🎫 in each channel. The acknowledgment should appear in that message's thread.

## New installation

Follow the Slack app creation steps in [README.md](README.md). Then:

```sh
cd ~/Desktop/dev/slack-ticket-bot
cp -n .env.example .env
npm ci
```

Edit `.env` with your bot token, app token and channel IDs before running `npm start`. `.env.example` contains placeholders only. Keep your real tokens in `.env`; Git ignores that file.

## Verification

```sh
npm test
npm run check
```

Preserve receipt records in `data/` (or Docker's named volume) across upgrades and restarts. If you customize `DATA_DIR`, add that location to `.gitignore` too.
