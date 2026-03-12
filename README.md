# ClaudeClaw

A personal AI assistant bot for Telegram, powered by the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk). Every message routes through a full Claude Code session with access to all tools, skills, and session continuity.

Built for [PAI](https://github.com/danielmiessler/PAI) (Personal AI Infrastructure) users who want a 24/7 Telegram interface to their Claude Code environment.

## What You Get

- **Full Claude Code access** -- Bash, file system, web search, browser automation, MCP servers
- **All PAI skills** -- Research, Browser, Art, Fabric, ExtractWisdom, and everything in `~/.claude/skills/`
- **Session continuity** -- conversations resume across messages (no context loss)
- **SQLite memory** -- dual-sector (semantic/episodic) with FTS5 search and salience decay
- **Cron scheduling** -- recurring tasks that run through the agent
- **Voice transcription** -- Groq Whisper STT for voice notes
- **Media handling** -- photos, documents, videos with auto-cleanup
- **Video analysis** -- Gemini-powered video understanding

## Architecture

```
Telegram --> Grammy Bot --> Agent SDK query() --> Claude Code Session --> Response
                              |                        |
                              +-- cwd (loads CLAUDE.md) |
                              +-- resume (session ID)   +-- PAI skills
                              +-- bypassPermissions     +-- All tools
```

The key insight: `CLAUDE.md` in the project root controls the bot's persona, instructions, and domain knowledge. The Agent SDK's `cwd` parameter loads it automatically.

See [REPLICATION.md](REPLICATION.md) for the full architecture breakdown, including the Builder vs Runner two-role pattern.

## Quick Start

1. **Clone and install**
   ```bash
   git clone https://github.com/XPrime17/ClaudeClaw.git
   cd ClaudeClaw
   npm install
   ```

2. **Create a Telegram bot** via [@BotFather](https://t.me/BotFather)

3. **Configure**
   ```bash
   cp .env.example .env
   # Edit .env with your bot token and chat ID
   cp CLAUDE.md.example CLAUDE.md
   # Edit CLAUDE.md to define your bot's persona
   ```

4. **Ensure Claude CLI is installed and authenticated**
   ```bash
   claude --version
   ```

5. **Build and run**
   ```bash
   npm run build
   npm start
   ```

6. **Get your chat ID** -- send `/chatid` to the bot, add it to `ALLOWED_CHAT_ID` in `.env`

7. **Deploy as a service** (recommended)
   ```bash
   npm run setup    # Interactive wizard: writes systemd unit, enables service
   ```

## Customization

Everything about the bot's behavior is controlled by `CLAUDE.md`:

- **Persona** -- name, personality, communication style
- **Domain knowledge** -- what scripts, APIs, and tools the bot knows about
- **Response rules** -- formatting, verbosity, platform-specific behavior

See [CLAUDE.md.example](CLAUDE.md.example) for the template with all sections explained.

## Full Documentation

- **[REPLICATION.md](REPLICATION.md)** -- Complete setup guide, architecture deep-dive, Builder vs Runner pattern, platform adaptation guide
- **[CLAUDE.md.example](CLAUDE.md.example)** -- Template for your bot's persona and instructions

## Requirements

- Node.js >= 20
- Claude CLI installed and authenticated
- PAI skills in `~/.claude/skills/` (optional but recommended)

## License

MIT
