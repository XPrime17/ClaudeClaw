#!/usr/bin/env bash
# ClaudeClaw OAuth keepalive.
#
# The Claude Code login token (~/.claude/.credentials.json) is short-lived
# (~8h). It is refreshed lazily on API use. When the ClaudeClaw service's only
# users were its scheduled tasks — which fire in bursts and spawn many `claude`
# subprocesses at once — the concurrent refresh could wedge, leaving the bot
# "Not logged in" until a clean single run re-authenticated it.
#
# This script makes one serial, low-cost `claude` call on a timer so the token
# is refreshed well before expiry by a single process (no refresh race).
set -uo pipefail

export HOME=/home/xprime17
export PATH=/home/xprime17/.local/bin:/home/xprime17/.bun/bin:/usr/local/bin:/usr/bin:/bin

# Scrub Claude Code sentinel env vars so this `claude` invocation isn't rejected
# as "launched inside another Claude Code session" (mirrors src/agent.ts).
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH \
      CLAUDE_CODE_MAX_OUTPUT_TOKENS CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

out="$(timeout 90 claude -p "reply with exactly: ok" \
        --model haiku \
        --permission-mode bypassPermissions 2>&1)"
rc=$?

if [ $rc -eq 0 ]; then
  echo "keepalive ok: token refreshed (reply: ${out})"
  exit 0
fi

echo "keepalive FAILED (rc=$rc): ${out}" >&2
# Surface a logged-out token loudly so the failure is obvious in the journal.
if echo "$out" | grep -qiE 'not logged in|please run /login'; then
  echo "ACTION REQUIRED: Claude Code is logged out. Run \`claude\` interactively on beelink to re-auth." >&2
fi
exit $rc
