# pi-telegram

Talk to your running [pi](https://github.com/badlogic/pi-mono) coding agent from Telegram.

Your pi session keeps running in a terminal (tmux, a server, your laptop). Messages you send to your own
Telegram bot land in that session as if you typed them, and pi's answer comes back to the chat.

- **Text**: goes straight into the open session. If pi is busy, your message steers the current run.
- **Voice notes**: transcribed with any OpenAI-compatible speech-to-text API (Groq Whisper by default).
- **Photos**: saved to disk, and optionally read by a vision model, so text-only models (DeepSeek, GLM) can still work with receipts, screenshots and posters.
- **Files** (CSV, PDF, Excel, ...): saved to an inbox folder; pi is told the path and takes it from there.
- **Formatted answers**: pi's Markdown is converted to Telegram formatting (bold, code, lists, links).
- **Optional `generate_image` tool**: pi can create an image (OpenAI Images API) and send it to you.
- `/stop` aborts the current run.

## Install

```bash
pi install git:github.com/syahidfrd/pi-telegram
```

Or try it for one run: `pi -e git:github.com/syahidfrd/pi-telegram`.

The extension does nothing until `PI_TELEGRAM_BOT_TOKEN` is set, so a global install is safe.

## Setup

1. Create a bot: open [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token.
2. Find your Telegram user id: message [@userinfobot](https://t.me/userinfobot).
3. Start pi with both set:

```bash
export PI_TELEGRAM_BOT_TOKEN="123456:ABC..."
export PI_TELEGRAM_ALLOWED_USERS="123456789"   # comma-separated user ids
pi
```

4. Send your bot a message. It shows up in the pi session, and the answer comes back to Telegram.

Instead of env vars you can put the same keys in `~/.pi/agent/telegram.json`:

```json
{
  "PI_TELEGRAM_BOT_TOKEN": "123456:ABC...",
  "PI_TELEGRAM_ALLOWED_USERS": "123456789"
}
```

### Optional settings

| Key | Default | What it does |
|---|---|---|
| `PI_TELEGRAM_INBOX` | `./telegram-inbox` | Where photos, files and voice notes are saved |
| `PI_TELEGRAM_LOG` | (off) | Log file path |
| `PI_TELEGRAM_STT_API_KEY` | (off) | Enables voice note transcription |
| `PI_TELEGRAM_STT_BASE_URL` | `https://api.groq.com/openai/v1` | Any OpenAI-compatible `/audio/transcriptions` |
| `PI_TELEGRAM_STT_MODEL` | `whisper-large-v3-turbo` | |
| `PI_TELEGRAM_VISION_API_KEY` | (off) | Enables image reading for photos |
| `PI_TELEGRAM_VISION_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible `/chat/completions` with images |
| `PI_TELEGRAM_VISION_MODEL` | `gpt-4o-mini` | |
| `PI_TELEGRAM_IMAGE_API_KEY` | (off) | Enables the `generate_image` tool |
| `PI_TELEGRAM_IMAGE_BASE_URL` | `https://api.openai.com/v1` | |
| `PI_TELEGRAM_IMAGE_MODEL` | `gpt-image-1` | |

## Keep it running

Run pi inside tmux (or any terminal multiplexer) so the session survives when you close your laptop:

```bash
tmux new -s pi
pi -c        # continue the last session
```

Only **one** pi process can poll the same bot token. If you open a second pi with the same token, the
two will fight over messages. Use a different bot per machine.

## Cheap models work fine

pi works with any provider. A setup we like for small businesses: DeepSeek or GLM through an
OpenAI-compatible gateway for the main model (cents per day), plus a small vision model for photos.
See pi's [custom models docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md).

## Security

- **Your bot can run commands on the machine where pi runs.** pi has bash, read and write tools. Anyone
  who can message the bot as an allowed user can do what you can do in that terminal.
- Only user ids in `PI_TELEGRAM_ALLOWED_USERS` are served; everyone else is ignored. Private chats only.
- Keep the bot token secret. If it leaks, revoke it in BotFather (`/revoke`).
- Consider running pi in a container or as a separate user with limited access.

---

## Bahasa Indonesia (ringkas)

Ngobrol sama sesi pi yang lagi jalan, lewat Telegram. Kirim teks, VN, foto, atau file ke bot kamu, masuk
ke sesi pi, jawabannya balik ke Telegram.

1. Bikin bot di @BotFather, salin token.
2. Cek user id kamu di @userinfobot.
3. `pi install git:github.com/syahidfrd/pi-telegram`
4. Jalankan pi dengan `PI_TELEGRAM_BOT_TOKEN` dan `PI_TELEGRAM_ALLOWED_USERS` (lihat Setup di atas).

Hati-hati: bot ini bisa menjalankan perintah di komputer/server tempat pi jalan. Jangan bagikan token,
dan isi allowlist hanya dengan user id kamu sendiri.

## License

MIT
