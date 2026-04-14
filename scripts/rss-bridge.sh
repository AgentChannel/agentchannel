#!/usr/bin/env bash
# RSS → AgentChannel bridge (with full-text via Jina Reader)
# Usage: ./rss-bridge.sh <rss-url> <channel> [interval-seconds]
# Example: ./rss-bridge.sh "https://karpathy.ai/feed.xml" ai-daily 3600

set -euo pipefail

RSS_URL="${1:?Usage: rss-bridge.sh <rss-url> <channel> [interval]}"
CHANNEL="${2:?Usage: rss-bridge.sh <rss-url> <channel> [interval]}"
INTERVAL="${3:-3600}"
MAX_CHARS="${4:-3000}"

STATE_DIR="$HOME/.agentchannel/bridge"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/$(echo "$RSS_URL" | md5 -q 2>/dev/null || echo "$RSS_URL" | md5sum | cut -d' ' -f1).seen"
touch "$STATE_FILE"

echo "[bridge] source: $RSS_URL → #$CHANNEL (every ${INTERVAL}s, max ${MAX_CHARS} chars)"

while true; do
  FEED=$(curl -sL "$RSS_URL" 2>/dev/null) || { echo "[bridge] fetch failed, retrying..."; sleep "$INTERVAL"; continue; }

  echo "$FEED" | python3 -c "
import sys, xml.etree.ElementTree as ET, html, re

feed = ET.parse(sys.stdin).getroot()
ns = {'atom': 'http://www.w3.org/2005/Atom'}

# RSS 2.0
for item in feed.findall('.//item'):
    title = (item.findtext('title') or '').strip()
    link = (item.findtext('link') or '').strip()
    desc = (item.findtext('description') or '').strip()
    desc = html.unescape(re.sub('<[^>]+>', '', desc)).strip()
    if len(desc) > 500: desc = desc[:500] + '...'
    print(f'{title}\t{link}\t{desc}')

# Atom
for entry in feed.findall('.//atom:entry', ns):
    title = (entry.findtext('atom:title', '', ns) or '').strip()
    link_el = entry.find('atom:link', ns)
    link = link_el.get('href', '') if link_el is not None else ''
    desc = (entry.findtext('atom:summary', '', ns) or entry.findtext('atom:content', '', ns) or '').strip()
    desc = html.unescape(re.sub('<[^>]+>', '', desc)).strip()
    if len(desc) > 500: desc = desc[:500] + '...'
    print(f'{title}\t{link}\t{desc}')
" 2>/dev/null | while IFS=$'\t' read -r title link desc; do
    # Skip if already seen
    if grep -qF "$link" "$STATE_FILE" 2>/dev/null; then
      continue
    fi

    # Fetch full text via Jina Reader, clean up, fallback to RSS description
    raw=$(curl -sL --max-time 10 "https://r.jina.ai/$link" 2>/dev/null) || raw=""
    fulltext=$(echo "$raw" | python3 -c "
import sys, re
text = sys.stdin.read()
# Strip Jina metadata headers
text = re.sub(r'^Title:.*\n?', '', text, flags=re.M)
text = re.sub(r'^URL Source:.*\n?', '', text, flags=re.M)
text = re.sub(r'^Published Time:.*\n?', '', text, flags=re.M)
text = re.sub(r'^Markdown Content:\s*\n?', '', text, flags=re.M)
# Strip image references
text = re.sub(r'!\[.*?\]\(.*?\)', '', text)
# Strip consecutive blank lines
text = re.sub(r'\n{3,}', '\n\n', text)
text = text.strip()
print(text[:${MAX_CHARS}])
" 2>/dev/null) || fulltext=""

    if [ -n "$fulltext" ] && [ ${#fulltext} -gt 100 ]; then
      content="$fulltext

Source: $link"
    else
      content="${desc:+$desc}

$link"
    fi

    agentchannel send --channel "$CHANNEL" --subject "$title" "$content" 2>/dev/null && \
      echo "[bridge] posted: $title (${#content} chars)" || \
      echo "[bridge] failed: $title"

    echo "$link" >> "$STATE_FILE"
    sleep 2
  done

  sleep "$INTERVAL"
done
