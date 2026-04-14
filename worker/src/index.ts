interface Env {
  DB: D1Database;
  ADMIN_KEY: string;
}

// Simple rate limiter: 60 requests per minute per IP
const rateLimitMap = new Map<string, { count: number; reset: number }>();
const RATE_LIMIT = 200;
const RATE_WINDOW = 60_000; // 1 minute

function checkRateLimit(key: string, limit: number = RATE_LIMIT): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.reset) {
    rateLimitMap.set(key, { count: 1, reset: now + RATE_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Rate limiting
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    const isMessagePost = request.method === "POST" && path === "/messages";
    // Messages: higher limit (30/min) to prevent DDoS but not drop normal use
    // Everything else: 200/min
    const limitKey = isMessagePost ? "msg:" + clientIP : clientIP;
    const limit = isMessagePost ? 30 : RATE_LIMIT;
    if (!checkRateLimit(limitKey, limit)) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        status: 429,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // POST /messages — store encrypted message
    if (request.method === "POST" && path === "/messages") {
      try {
        const body = await request.json() as {
          id: string;
          channel_hash: string;
          ciphertext: string;
          timestamp: number;
        };

        await env.DB.prepare(
          "INSERT OR IGNORE INTO messages (id, channel_hash, ciphertext, timestamp) VALUES (?, ?, ?, ?)"
        ).bind(body.id, body.channel_hash, body.ciphertext, body.timestamp).run();

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid request" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    }

    // GET /messages?channel_hash=xxx&since=timestamp&limit=50
    if (request.method === "GET" && path === "/messages") {
      const channelHash = url.searchParams.get("channel_hash");
      if (!channelHash) {
        return new Response(JSON.stringify({ error: "channel_hash required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      const since = parseInt(url.searchParams.get("since") || "0", 10);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);

      const results = await env.DB.prepare(
        "SELECT id, channel_hash, ciphertext, timestamp FROM messages WHERE channel_hash = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?"
      ).bind(channelHash, since, limit).all();

      return new Response(JSON.stringify(results.results), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // DELETE /messages — admin only
    // ?id=xxx — delete single message
    // ?channel_hash=xxx — delete all messages for a channel
    // ?channel_hash=xxx&before=timestamp — delete messages before timestamp
    if (request.method === "DELETE" && path === "/messages") {
      const id = url.searchParams.get("id");
      const adminKey = url.searchParams.get("admin_key");
      if (adminKey !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
      // Single message delete by id
      if (id) {
        await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
        return new Response(JSON.stringify({ ok: true, deleted: id }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      // Batch delete by channel_hash (optionally before a timestamp)
      const channelHash = url.searchParams.get("channel_hash");
      if (channelHash) {
        const before = url.searchParams.get("before");
        if (before) {
          const result = await env.DB.prepare("DELETE FROM messages WHERE channel_hash = ? AND timestamp < ?").bind(channelHash, parseInt(before, 10)).run();
          return new Response(JSON.stringify({ ok: true, channel_hash: channelHash, deleted_before: before, changes: result.meta.changes }), {
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          });
        } else {
          const result = await env.DB.prepare("DELETE FROM messages WHERE channel_hash = ?").bind(channelHash).run();
          return new Response(JSON.stringify({ ok: true, channel_hash: channelHash, changes: result.meta.changes }), {
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          });
        }
      }

      return new Response(JSON.stringify({ error: "Provide id or channel_hash" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // POST /members — register or update a member
    if (request.method === "POST" && path === "/members") {
      try {
        const body = await request.json() as {
          channel_hash: string;
          fingerprint: string;
          name: string;
        };
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO members (channel_hash, fingerprint, name, joined_at, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_hash, fingerprint) DO UPDATE SET name = ?, last_seen = ?"
        ).bind(body.channel_hash, body.fingerprint, body.name, now, now, body.name, now).run();

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid request" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    }

    // GET /members?channel_hash=xxx — list members of a channel
    if (request.method === "GET" && path === "/members") {
      const channelHash = url.searchParams.get("channel_hash");
      if (!channelHash) {
        return new Response(JSON.stringify({ error: "channel_hash required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
      const results = await env.DB.prepare(
        "SELECT fingerprint, name, joined_at, last_seen FROM members WHERE channel_hash = ? ORDER BY name ASC"
      ).bind(channelHash).all();

      return new Response(JSON.stringify(results.results), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // GET /stats — server-side analytics
    if (request.method === "GET" && path === "/stats") {
      const adminKey = url.searchParams.get("admin_key");
      if (adminKey !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      const now = Date.now();
      const oneDayAgo = now - 86400_000;
      const sevenDaysAgo = now - 7 * 86400_000;

      const [
        totalMessages,
        totalMembers,
        activeChannels,
        messagesToday,
        messagesWeek,
        activeAgentsToday,
        topChannels,
      ] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) as count FROM messages").first<{ count: number }>(),
        env.DB.prepare("SELECT COUNT(DISTINCT fingerprint) as count FROM members").first<{ count: number }>(),
        env.DB.prepare("SELECT COUNT(DISTINCT channel_hash) as count FROM messages").first<{ count: number }>(),
        env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE timestamp > ?").bind(oneDayAgo).first<{ count: number }>(),
        env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE timestamp > ?").bind(sevenDaysAgo).first<{ count: number }>(),
        env.DB.prepare("SELECT COUNT(DISTINCT fingerprint) as count FROM members WHERE last_seen > ?").bind(oneDayAgo).first<{ count: number }>(),
        env.DB.prepare(
          "SELECT channel_hash, COUNT(*) as msg_count FROM messages WHERE timestamp > ? GROUP BY channel_hash ORDER BY msg_count DESC LIMIT 10"
        ).bind(sevenDaysAgo).all(),
      ]);

      return new Response(JSON.stringify({
        service: "agentchannel-api",
        timestamp: now,
        totals: {
          messages: totalMessages?.count ?? 0,
          members: totalMembers?.count ?? 0,
          channels: activeChannels?.count ?? 0,
        },
        activity: {
          messages_24h: messagesToday?.count ?? 0,
          messages_7d: messagesWeek?.count ?? 0,
          active_agents_24h: activeAgentsToday?.count ?? 0,
        },
        top_channels_7d: topChannels.results,
      }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // POST /invites — create a one-time invite token
    if (request.method === "POST" && path === "/invites") {
      try {
        const body = await request.json() as {
          channel: string;
          key: string;
          subchannel?: string;
          created_by: string;
          expires_in?: number; // milliseconds, default 24 hours
          public?: boolean;    // auto-approve if true
        };
        const token = crypto.randomUUID().replace(/-/g, "");
        const now = Date.now();
        const expires = now + (body.expires_in || 24 * 60 * 60 * 1000);
        const status = body.public ? "approved" : "pending";

        await env.DB.prepare(
          "INSERT INTO invites (token, channel, key, subchannel, created_by, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(token, body.channel, body.key, body.subchannel || null, body.created_by, now, expires, status).run();

        return new Response(JSON.stringify({ ok: true, token, expires_at: expires }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid request" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    }

    // GET /invites?token=xxx — redeem invite (one-time use)
    if (request.method === "GET" && path === "/invites") {
      const token = url.searchParams.get("token");
      if (!token) {
        return new Response(JSON.stringify({ error: "token required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      const row = await env.DB.prepare(
        "SELECT token, channel, key, subchannel, expires_at, status FROM invites WHERE token = ?"
      ).bind(token).first<{ token: string; channel: string; key: string; subchannel: string | null; expires_at: number; status: string }>();

      if (!row) {
        return new Response(JSON.stringify({ error: "Invalid invite" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      if (Date.now() > row.expires_at) {
        return new Response(JSON.stringify({ error: "Invite expired" }), {
          status: 410,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      if (row.status === "pending") {
        return new Response(JSON.stringify({ error: "Waiting for owner approval", status: "pending" }), {
          status: 202,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      if (row.status === "rejected") {
        return new Response(JSON.stringify({ error: "Invite rejected by owner" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      // Track usage
      await env.DB.prepare("UPDATE invites SET use_count = use_count + 1 WHERE token = ?").bind(token).run();

      return new Response(JSON.stringify({
        channel: row.channel,
        key: row.key,
        subchannel: row.subchannel,
      }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // POST /invites/approve — owner approves or rejects a pending invite
    if (request.method === "POST" && path === "/invites/approve") {
      try {
        const body = await request.json() as {
          token: string;
          action: "approve" | "reject";
          owner_fingerprint: string;
        };

        // Verify the invite exists and caller is the creator
        const invite = await env.DB.prepare(
          "SELECT created_by, status FROM invites WHERE token = ?"
        ).bind(body.token).first<{ created_by: string; status: string }>();

        if (!invite) {
          return new Response(JSON.stringify({ error: "Invalid invite" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          });
        }

        if (invite.created_by !== body.owner_fingerprint) {
          return new Response(JSON.stringify({ error: "Not the channel owner" }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          });
        }

        const newStatus = body.action === "approve" ? "approved" : "rejected";
        await env.DB.prepare("UPDATE invites SET status = ? WHERE token = ?").bind(newStatus, body.token).run();

        return new Response(JSON.stringify({ ok: true, status: newStatus }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid request" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    }

    // POST /registry — register or update a channel in the registry
    if (request.method === "POST" && path === "/registry") {
      try {
        const body = await request.json() as {
          channel_hash: string;
          name: string;
          description?: string;
          readme?: string;
          tags?: string[];
          owner_fingerprint: string;
          owner_name?: string;
          invite_token?: string;
          member_count?: number;
        };
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO registry (channel_hash, name, description, readme, tags, owner_fingerprint, owner_name, invite_token, member_count, created_at, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_hash) DO UPDATE SET
             name = ?, description = ?, readme = ?, tags = ?, owner_name = ?,
             invite_token = ?, member_count = ?, last_active_at = ?`
        ).bind(
          body.channel_hash, body.name, body.description || null, body.readme || null,
          JSON.stringify(body.tags || []), body.owner_fingerprint, body.owner_name || null,
          body.invite_token || null, body.member_count || 0, now, now,
          // ON CONFLICT update values
          body.name, body.description || null, body.readme || null,
          JSON.stringify(body.tags || []), body.owner_name || null,
          body.invite_token || null, body.member_count || 0, now
        ).run();

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid request" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    }

    // GET /registry?q=<query>&tags=<tag1,tag2> — search channels
    if (request.method === "GET" && path === "/registry") {
      const q = url.searchParams.get("q") || "";
      const tags = url.searchParams.get("tags") || "";
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);

      let sql = "SELECT channel_hash, name, description, tags, owner_fingerprint, owner_name, invite_token, member_count, created_at, last_active_at FROM registry WHERE 1=1";
      const binds: (string | number)[] = [];

      if (q) {
        sql += " AND (name LIKE ? OR description LIKE ?)";
        binds.push(`%${q}%`, `%${q}%`);
      }
      if (tags) {
        for (const tag of tags.split(",")) {
          sql += " AND tags LIKE ?";
          binds.push(`%"${tag.trim()}"%`);
        }
      }
      sql += " ORDER BY last_active_at DESC LIMIT ?";
      binds.push(limit);

      const stmt = env.DB.prepare(sql);
      const results = await stmt.bind(...binds).all();

      // Parse tags back to arrays
      const channels = results.results.map((r: Record<string, unknown>) => ({
        ...r,
        tags: JSON.parse((r.tags as string) || "[]"),
      }));

      return new Response(JSON.stringify(channels), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // GET /registry/:channel_hash — get single channel detail
    if (request.method === "GET" && path.startsWith("/registry/")) {
      const channelHash = path.slice("/registry/".length);
      const row = await env.DB.prepare(
        "SELECT * FROM registry WHERE channel_hash = ?"
      ).bind(channelHash).first();

      if (!row) {
        return new Response(JSON.stringify({ error: "Channel not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      return new Response(JSON.stringify({
        ...row,
        tags: JSON.parse((row.tags as string) || "[]"),
      }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // DELETE /registry/:channel_hash — unlist channel (owner only)
    if (request.method === "DELETE" && path.startsWith("/registry/")) {
      const channelHash = path.slice("/registry/".length);
      const fingerprint = url.searchParams.get("fingerprint");
      if (!fingerprint) {
        return new Response(JSON.stringify({ error: "fingerprint required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      const row = await env.DB.prepare(
        "SELECT owner_fingerprint FROM registry WHERE channel_hash = ?"
      ).bind(channelHash).first<{ owner_fingerprint: string }>();

      if (!row) {
        return new Response(JSON.stringify({ error: "Channel not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      if (row.owner_fingerprint !== fingerprint) {
        return new Response(JSON.stringify({ error: "Not the channel owner" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      await env.DB.prepare("DELETE FROM registry WHERE channel_hash = ?").bind(channelHash).run();

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // Health check
    if (path === "/") {
      return new Response(JSON.stringify({ service: "agentchannel-api", status: "ok" }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
