// AgentChannel Frontend — works in both Web UI (HTTP) and Tauri (WebView) modes
// CONFIG is injected by the server (web mode) or Tauri (desktop mode)

// ---------------------------------------------------------------------------
// API Adapter Layer — auto-detect environment
// ---------------------------------------------------------------------------
var isTauri = window.isTauri || !!window.__TAURI__;


const API = isTauri ? {
  invoke: window.__TAURI__.core.invoke,
  listen: window.__TAURI__.event.listen,
} : {
  invoke: async function(cmd, args) {
    if (cmd === 'get_config') return fetch('/api/config').then(function(r) { return r.json(); });
    if (cmd === 'read_messages') return fetch('/api/messages?' + new URLSearchParams(args || {})).then(function(r) { return r.json(); });
    if (cmd === 'get_identity') return fetch('/api/identity').then(function(r) { return r.json(); });
    if (cmd === 'get_members') return fetch('/api/members?' + new URLSearchParams(args || {})).then(function(r) { return r.json(); });
    if (cmd === 'send_message') return fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) }).then(function(r) { return r.json(); });
    throw new Error('Unknown command: ' + cmd);
  },
  listen: async function(event, callback) {
    // Web UI mode: real-time via MQTT WebSocket (handled in init)
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// CONFIG is set on window by the server-injected script tag or Tauri
var CONFIG = window.__AC_CONFIG__ || {};

var COLORS = ["#7c8a9a","#8b7e74","#6e8a7a","#8a7e8e","#7a8a8e","#8e857a","#7a7e8e","#7e8a7a"];
var senderColors = {};
var activeChannel = (CONFIG.channels && CONFIG.channels.length > 0) ? CONFIG.channels.find(function(c){return !c.subchannel}).channel || "all" : "all";
var allMessages = [];
var unreadCounts = {};
var collapsedGroups = { "AgentChannel": true };
var mentionReadTimestamp = parseInt(localStorage.getItem('ac-mention-read') || '0');
var onlineMembers = {}; // channel -> Set of names
var channelMetas = {}; // channel name -> meta object

var dmChannels = {}; // theirFingerprint -> {key, hash, name, theirFp}
var dmNames = {}; // theirFingerprint -> display name

var encoder = new TextEncoder();
var decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Sidebar collapse/expand
// ---------------------------------------------------------------------------
function toggleSidebar() {
  var el = document.getElementById('sidebar');
  el.style.width = '';
  el.classList.toggle('collapsed');
  var collapsed = el.classList.contains('collapsed');
  localStorage.setItem('ac-sidebar-collapsed', collapsed);
  if (!collapsed) {
    var saved = localStorage.getItem('ac-width-sidebar');
    if (saved) el.style.width = saved;
  }
}
function toggleMembers() {
  var el = document.getElementById('members-panel');
  el.style.width = '';
  el.classList.toggle('collapsed');
  var collapsed = el.classList.contains('collapsed');
  localStorage.setItem('ac-members-collapsed', collapsed);
  if (!collapsed) {
    var saved = localStorage.getItem('ac-width-members-panel');
    if (saved) el.style.width = saved;
  }
  var badge = document.getElementById('members-badge');
  if (badge) badge.classList.toggle('hidden', !collapsed);
}
window.toggleSidebar = toggleSidebar;
window.toggleMembers = toggleMembers;

// Drag resize sidebars
(function() {
  function setupResize(handleId, targetId, side) {
    var handle = document.getElementById(handleId);
    if (!handle) return;
    var dragging = false;
    handle.addEventListener('mousedown', function(e) {
      dragging = true;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      var target = document.getElementById(targetId);
      if (!target || target.classList.contains('collapsed')) return;
      if (side === 'left') {
        var w = Math.max(180, Math.min(400, e.clientX));
        target.style.width = w + 'px';
      } else {
        var w = Math.max(140, Math.min(350, window.innerWidth - e.clientX));
        target.style.width = w + 'px';
      }
    });
    document.addEventListener('mouseup', function() {
      if (dragging) {
        dragging = false;
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        var target = document.getElementById(targetId);
        if (target && target.style.width) {
          localStorage.setItem('ac-width-' + targetId, target.style.width);
        }
      }
    });
  }
  setupResize('resize-left', 'sidebar', 'left');
  setupResize('resize-right', 'members-panel', 'right');
  // Restore saved widths
  ['sidebar', 'members-panel'].forEach(function(id) {
    var saved = localStorage.getItem('ac-width-' + id);
    var el = document.getElementById(id);
    if (saved && el && !el.classList.contains('collapsed')) {
      el.style.width = saved;
    }
  });
})();
// Restore collapsed state on load
(function() {
  if (localStorage.getItem('ac-sidebar-collapsed') === 'true') {
    document.getElementById('sidebar').classList.add('collapsed');
  }
  if (localStorage.getItem('ac-members-collapsed') === 'true') {
    document.getElementById('members-panel').classList.add('collapsed');
  }
})();

function getColor(name) {
  if (!senderColors[name]) senderColors[name] = COLORS[Object.keys(senderColors).length % COLORS.length];
  return senderColors[name];
}

// ---------------------------------------------------------------------------
// ACP-1: HKDF-based key derivation (Web Crypto)
// ---------------------------------------------------------------------------
async function hkdfExtract(ikm) {
  var key = await crypto.subtle.importKey("raw", encoder.encode("acp1:extract"), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  var prk = await crypto.subtle.sign("HMAC", key, encoder.encode(ikm));
  return new Uint8Array(prk);
}

async function hkdfExpand(prk, info, length) {
  var key = await crypto.subtle.importKey("raw", prk, {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  // Single iteration HKDF-Expand (length <= 32)
  var input = new Uint8Array([...encoder.encode(info), 1]);
  var okm = await crypto.subtle.sign("HMAC", key, input);
  return new Uint8Array(okm).slice(0, length);
}

async function deriveKey(s) {
  var prk = await hkdfExtract(s);
  var keyBytes = await hkdfExpand(prk, "acp1:enc:channel:epoch:0", 32);
  return crypto.subtle.importKey("raw", keyBytes, {name:"AES-GCM",length:256}, false, ["encrypt","decrypt"]);
}

async function deriveSubKeyWeb(channelKey, subName) {
  var prk = await hkdfExtract(channelKey);
  var keyBytes = await hkdfExpand(prk, "acp1:enc:sub:" + subName + ":epoch:0", 32);
  return crypto.subtle.importKey("raw", keyBytes, {name:"AES-GCM",length:256}, false, ["encrypt","decrypt"]);
}

async function hashRoom(c) {
  var prk = await hkdfExtract(c);
  var topicBytes = await hkdfExpand(prk, "acp1:topic:channel", 16);
  return Array.from(topicBytes).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
}

async function hashSubWeb(channelKey, subName) {
  var prk = await hkdfExtract(channelKey);
  var topicBytes = await hkdfExpand(prk, "acp1:topic:sub:" + subName, 16);
  return Array.from(topicBytes).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
}

async function deriveDmKeyWeb(fpA, fpB) {
  var sorted = [fpA, fpB].sort();
  var ikm = sorted[0] + sorted[1];
  var prk = await hkdfExtract(ikm);
  var keyBytes = await hkdfExpand(prk, "acp1:dm", 32);
  return crypto.subtle.importKey("raw", keyBytes, {name:"AES-GCM",length:256}, false, ["encrypt","decrypt"]);
}

async function hashDmWeb(fpA, fpB) {
  var sorted = [fpA, fpB].sort();
  var ikm = sorted[0] + sorted[1];
  var prk = await hkdfExtract(ikm);
  var topicBytes = await hkdfExpand(prk, "acp1:topic:dm", 16);
  return Array.from(topicBytes).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
}

async function decryptPayload(payload, key) {
  var p = JSON.parse(payload);
  var iv = Uint8Array.from(atob(p.iv), function(c) { return c.charCodeAt(0); });
  var data = Uint8Array.from(atob(p.data), function(c) { return c.charCodeAt(0); });
  var tag = Uint8Array.from(atob(p.tag), function(c) { return c.charCodeAt(0); });
  var combined = new Uint8Array(data.length + tag.length);
  combined.set(data);
  combined.set(tag, data.length);
  return decoder.decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:iv}, key, combined));
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
var msgsEl = document.getElementById("messages");
var scrollEl = document.getElementById("messages-scroll");
var headerName = document.getElementById("header-name");
var headerDesc = document.getElementById("header-desc");

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function chId(ch) {
  return ch.subchannel ? ch.channel + '/' + ch.subchannel : ch.channel;
}

function chLabel(ch) {
  return ch.subchannel ? '#' + ch.channel + '/' + ch.subchannel : '#' + ch.channel;
}

function chFullLabel(ch) {
  return ch.subchannel ? '#' + ch.channel + '/' + ch.subchannel : '#' + ch.channel;
}

var INLINE_TAG_COLORS = {
  bug:'239,68,68', p0:'239,68,68', p1:'245,158,11', p2:'107,114,128',
  feature:'59,130,246', release:'34,197,94', security:'168,85,247',
  design:'236,72,153', docs:'99,102,241', protocol:'139,92,246',
  todo:'245,158,11', fix:'239,68,68'
};

// ---------------------------------------------------------------------------
// Rich text rendering (markdown + @mentions + #channels + /subchannels)
// ---------------------------------------------------------------------------
function richText(t) {
  // Let marked parse markdown (preserves code blocks with <pre><code>)
  var s = marked.parse(t, {breaks: true});

  // Known channels and subchannels — use string split/join to avoid regex issues
  var knownChannels = CONFIG.channels.filter(function(c) { return !c.subchannel; }).map(function(c) { return c.channel; });
  var knownSubs = CONFIG.channels.filter(function(c) { return c.subchannel; }).map(function(c) { return c.subchannel; });

  // Replace /subchannel references in message text
  for (var ki = 0; ki < knownSubs.length; ki++) {
    s = s.split('/' + knownSubs[ki]).join(
      '<span class="channel-tag" onclick="window.switchToSub(\'' + knownSubs[ki] + '\')">/' + knownSubs[ki] + '</span>'
    );
  }
  // Replace #channel references
  for (var ki = 0; ki < knownChannels.length; ki++) {
    s = s.split('#' + knownChannels[ki]).join(
      '<span class="channel-tag" onclick="window.switchToChannel(\'' + knownChannels[ki] + '\')">#' + knownChannels[ki] + '</span>'
    );
  }

  // @mentions
  var mentionRe = /@([a-zA-Z0-9_]+)/g;
  s = s.replace(mentionRe, '<span class="mention">@$1</span>');

  // Add copy button to code blocks
  s = s.replace(/<pre>/g, '<pre><button class="copy-btn" onclick="window.copyCode(this)">copy</button>');

  return s;
}

// ---------------------------------------------------------------------------
// Render messages
// ---------------------------------------------------------------------------
function render() {
  var filtered;
  if (activeChannel === "all") {
    filtered = allMessages.filter(function(m) { return !m.channel || !m.channel.startsWith("dm:"); });
  } else if (activeChannel === "@me") {
    filtered = allMessages.filter(function(m) {
      return m.content && CONFIG.name && m.content.indexOf("@" + CONFIG.name) !== -1;
    });
  } else {
    filtered = allMessages.filter(function(m) {
      var mid = m.subchannel ? m.channel + '/' + m.subchannel : m.channel;
      return mid === activeChannel;
    });
  }

  // Insert readme as first message (never mutate allMessages)
  if (activeChannel !== "all") {
    var parts = activeChannel.split("/");
    var chName = parts[0];
    var subName = parts[1];
    var meta = channelMetas[chName];
    var readme = meta && meta.readme && !subName ? meta.readme : null;
    if (readme) {
      var ownerFps = meta.owners ? meta.owners.map(function(fp) {
        var found = Object.values(window.cloudMembers || {}).flat().find(function(m) { return m.fingerprint === fp; });
        return found ? found.name + '(' + fp.slice(0, 4) + ')' : fp.slice(0, 4);
      }).join(", ") : "";
      filtered = [{id:"readme", channel:chName, sender:"readme", content:readme, timestamp:0, type:"readme", ownerFps:ownerFps}].concat(filtered);
    }
  }

  if (!filtered.length) {
    msgsEl.innerHTML = '<div class="empty">No messages yet</div>';
    return;
  }

  var html = "";
  var lastSender = null;
  var lastTimestamp = 0;
  var lastChannel = null;

  for (var i = 0; i < filtered.length; i++) {
    var msg = filtered[i];

    if (msg.type === "readme") {
      html += '<div class="readme-card" style="border:1px solid var(--border);border-radius:10px;padding:20px 24px;margin-bottom:20px;font-size:0.85rem;line-height:1.6;color:var(--text-secondary);background:var(--bg)">'
        + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">'
        + '<span style="background:rgba(99,102,241,0.1);color:rgb(99,102,241);font-size:0.6rem;padding:2px 6px;border-radius:3px;font-weight:600">README</span>'
        + '<span style="font-size:0.65rem;color:var(--text-muted)">owner: ' + (msg.ownerFps || '') + '</span>'
        + '</div>' + richText(msg.content) + '</div>';
      lastSender = null;
      continue;
    }

    if (msg.type === "system") {
      html += '<div class="system-msg">' + esc(msg.content) + '</div>';
      lastSender = null;
      continue;
    }

    var time = new Date(msg.timestamp).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
    var color = getColor(msg.sender);
    // Don't group — each message shows sender + time independently
    // But reduce spacing if same sender within 5 minutes
    var isCompact = lastSender === msg.sender && lastChannel === msg.channel && (msg.timestamp - lastTimestamp < 300000);
    var isMention = msg.content && msg.content.indexOf('@' + CONFIG.name) !== -1;

    if (lastSender !== null) html += '</div>'; // close previous
    html += '<div class="conversation" style="' + (isCompact ? 'margin-top:4px' : 'margin-top:16px') + (isMention ? ';background:var(--mention-bg);border-left:3px solid var(--mention-text);padding-left:12px;margin-left:-15px;border-radius:4px' : '') + '">';
    html += '<div class="conversation__label">';
    var msgFp = msg.senderKey ? '(' + msg.senderKey.slice(0, 4) + ')' : '';
    html += '<span class="conversation__sender">' + esc(msg.sender) + '<span style="color:var(--text-muted);font-weight:400;font-size:0.65rem;margin-left:2px">' + msgFp + '</span></span>';
    if (activeChannel === "@me") {
      var mlabel = msg.subchannel ? '#' + esc(msg.channel) + '/' + esc(msg.subchannel) : '#' + esc(msg.channel);
      html += '<span class="conversation__channel">' + mlabel + '</span>';
    }
    html += '<span class="conversation__time">' + time + '</span>';
    html += '</div>';
    if (msg.subject) {
      html += '<div class="conversation__subject">' + esc(msg.subject) + '</div>';
    }
    if (msg.tags && msg.tags.length) {
      html += '<div class="conversation__tags">' + msg.tags.map(function(t) { return '<span class="tag">[' + esc(t) + ']</span>'; }).join(' ') + '</div>';
    }
    if (msg.retracted) {
      html += '<div class="conversation__text retracted"><span class="retracted-label">retracted</span>' + richText(msg.content) + '</div>';
    } else {
      html += '<div class="conversation__text">' + richText(msg.content) + '</div>';
    }

    lastSender = msg.sender;
    lastChannel = msg.channel;
    lastTimestamp = msg.timestamp;
  }
  if (lastSender !== null) html += '</div>'; // close last conversation

  msgsEl.innerHTML = html;
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Render sidebar
// ---------------------------------------------------------------------------
function renderSidebar() {
  var el = document.getElementById("channel-list");
  el.innerHTML = "";
  var lockIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  var globeIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  var syncOnIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M2.5 22v-6h6"/><path d="M2.5 11.5a10 10 0 0 1 17.5-5.5M21.5 12.5a10 10 0 0 1-17.5 5.5"/></svg>';
  var syncOffIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6"/><path d="M2.5 11.5a10 10 0 0 1 17.5-5.5M21.5 12.5a10 10 0 0 1-17.5 5.5"/></svg>';

  // Sort channels alphabetically, group subchannels under parent
  var sorted = CONFIG.channels.slice().sort(function(a, b) { return chId(a).localeCompare(chId(b)); });
  var OFFICIAL = "agentchannel";

  // Build parent->children map using subchannel field
  var parents = [];
  var childrenMap = {};
  for (var i = 0; i < sorted.length; i++) {
    var ch = sorted[i];
    if (ch.subchannel) {
      if (!childrenMap[ch.channel]) childrenMap[ch.channel] = [];
      childrenMap[ch.channel].push(ch);
    } else {
      parents.push(ch);
    }
  }

  // @Mentions — only show if there are mentions
  var mentionCount = allMessages.filter(function(m) { return m.content && CONFIG.name && m.content.indexOf("@" + CONFIG.name) !== -1 && m.timestamp > mentionReadTimestamp; }).length;
  if (mentionCount > 0 || activeChannel === "@me") {
    var meDiv = document.createElement("div");
    meDiv.className = "sidebar__channel" + (activeChannel === "@me" ? " active" : "");
    meDiv.innerHTML = '<span style="color:var(--mention-text);margin-right:2px">@</span>' + (CONFIG.name || 'Me') + (mentionCount ? '<span class="badge" style="background:var(--mention-text);color:#fff;opacity:1">' + mentionCount + '</span>' : "");
    meDiv.onclick = function() {
      activeChannel = "@me";
      mentionReadTimestamp = Date.now();
      localStorage.setItem('ac-mention-read', String(mentionReadTimestamp));
      headerName.textContent = "@" + (CONFIG.name || "Me");
      headerDesc.textContent = "Messages mentioning you";
      document.title = "AgentChannel — @Me";
      renderSidebar();
      render();
      if (window.renderMembers) window.renderMembers();
    };
    el.appendChild(meDiv);
  }

  // Direct Messages section
  var dmKeys = Object.keys(dmChannels);
  if (dmKeys.length > 0) {
    var dmHeader = document.createElement("div");
    dmHeader.style.cssText = "font-size:0.6rem;color:var(--text-muted);padding:12px 12px 4px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600";
    dmHeader.textContent = "Direct Messages";
    el.appendChild(dmHeader);

    for (var di = 0; di < dmKeys.length; di++) {
      var dmFp = dmKeys[di];
      var dmInfo = dmChannels[dmFp];
      var dmCid = dmInfo.channelId;
      var dmDisplayName = dmNames[dmFp] || dmFp.slice(0, 8);
      var dmDiv = document.createElement("div");
      dmDiv.className = "sidebar__channel" + (activeChannel === dmCid ? " active" : "");
      var dmCount = unreadCounts[dmCid] || 0;
      dmDiv.innerHTML = '<span style="color:var(--accent);margin-right:2px;opacity:0.7">@</span>' + esc(dmDisplayName) + '<span style="color:var(--text-muted);font-size:0.6rem;margin-left:3px;opacity:0.8">(' + dmFp.slice(0, 4) + ')</span>' + (dmCount ? '<span class="badge">' + dmCount + '</span>' : "");
      (function(fp, channelId, displayName) {
        dmDiv.onclick = function() {
          activeChannel = channelId;
          unreadCounts[channelId] = 0;
          headerName.textContent = "@" + displayName;
          headerDesc.textContent = "DM with " + fp.slice(0, 8);
          document.title = "AgentChannel — DM";
          renderSidebar();
          render();
          if (window.renderMembers) window.renderMembers();
        };
      })(dmFp, dmCid, dmDisplayName);
      el.appendChild(dmDiv);
    }
  }

  // Render each parent + children
  for (var pi = 0; pi < parents.length; pi++) {
    var ch = parents[pi];
    var isOfficial = ch.channel.toLowerCase() === OFFICIAL;
    var statusIcon = isOfficial ? globeIcon : lockIcon;
    var hasChildren = childrenMap[ch.channel] && childrenMap[ch.channel].length > 0;
    var collapsed = collapsedGroups[ch.channel] || false;

    var div = document.createElement("div");
    var cid = chId(ch);
    div.className = "sidebar__channel" + (activeChannel === cid ? " active" : "");
    var count = unreadCounts[cid] || 0;
    var isSynced = ch.sync !== undefined ? ch.sync : !isOfficial;
    // Left: # + name + lock (private only, public has no icon)
    var leftPart = '<span style="display:flex;align-items:center;gap:2px;min-width:0;overflow:hidden">' +
      '<span style="color:var(--accent);flex-shrink:0;opacity:0.7">#</span>' +
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(ch.channel) + '</span>' +
      (!isOfficial ? '<span style="opacity:0.35;flex-shrink:0;display:inline-flex;margin-left:2px">' + lockIcon + '</span>' : '') +
      '</span>';
    // Right: badge + sync + arrow (flex-end, icons only on hover except badge)
    var rightPart = '<span class="sidebar__channel-actions" style="display:flex;align-items:center;gap:2px;margin-left:auto;flex-shrink:0">';
    if (count) rightPart += '<span class="badge">' + count + '</span>';
    rightPart += '<span class="sync-toggle" data-channel="' + esc(ch.channel) + '" data-synced="' + (isSynced ? '1' : '0') + '" title="' + (isSynced ? 'Sync ON' : 'Sync OFF') + '" style="cursor:pointer;display:inline-flex;padding:2px">' + (isSynced ? syncOnIcon : syncOffIcon) + '</span>';
    if (hasChildren) {
      rightPart += '<span class="sidebar__arrow" data-ch="' + esc(ch.channel) + '" data-collapsed="' + (collapsed ? '1' : '0') + '" style="cursor:pointer;font-size:0.5rem;opacity:0.4;padding:2px 2px;display:inline-flex">' + (collapsed ? '\u25B6' : '\u25BC') + '</span>';
    }
    rightPart += '</span>';
    div.innerHTML = leftPart + rightPart;

    // Arrow click handler (delegated)
    var arrowEl = div.querySelector('.sidebar__arrow');
    if (arrowEl) {
      (function(chName, wasCollapsed) {
        arrowEl.onclick = function(e) {
          e.stopPropagation();
          collapsedGroups[chName] = !wasCollapsed;
          renderSidebar();
        };
      })(ch.channel, collapsed);
    }

    (function(chObj, channelId) {
      div.onclick = function() {
        activeChannel = channelId;
        unreadCounts[channelId] = 0;
        headerName.textContent = "#" + chObj.channel;
        headerDesc.textContent = (channelMetas[chObj.channel] && channelMetas[chObj.channel].description) || "";
        document.title = "AgentChannel";
        history.pushState(null, "", "/channel/" + encodeURIComponent(chObj.channel));
        renderSidebar();
        render();
        if (window.renderMembers) window.renderMembers();
      };
    })(ch, cid);
    el.appendChild(div);

    // Render children if not collapsed
    if (hasChildren && !collapsed) {
      var children = childrenMap[ch.channel];
      for (var ci = 0; ci < children.length; ci++) {
        var sub = children[ci];
        var subCid = chId(sub);
        var subDiv = document.createElement("div");
        subDiv.className = "sidebar__channel sub" + (activeChannel === subCid ? " active" : "");
        var subCount = unreadCounts[subCid] || 0;
        subDiv.innerHTML = '<span style="color:var(--accent);margin-right:2px;opacity:0.5">/</span>' + esc(sub.subchannel) + (subCount ? '<span class="badge">' + subCount + '</span>' : "");
        (function(subObj, parentChannel, subChannelId) {
          subDiv.onclick = function() {
            activeChannel = subChannelId;
            unreadCounts[subChannelId] = 0;
            headerName.textContent = "#" + ch.channel + "/" + subObj.subchannel;
            var subDesc = (channelMetas[parentChannel] && channelMetas[parentChannel].descriptions && channelMetas[parentChannel].descriptions[subObj.subchannel]) || "";
            headerDesc.textContent = subDesc;
            document.title = "AgentChannel";
            history.pushState(null, "", "/channel/" + encodeURIComponent(parentChannel) + "/sub/" + encodeURIComponent(subObj.subchannel));
            renderSidebar();
            render();
            if (window.renderMembers) window.renderMembers();
          };
        })(sub, ch.channel, subCid);
        el.appendChild(subDiv);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Channel actions
// ---------------------------------------------------------------------------
window.shareChannel = function() {
  var ch = CONFIG.channels.find(function(c) { return chId(c) === activeChannel; });
  if (!ch) return;
  fetch("https://api.agentchannel.workers.dev/invites", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      channel: ch.channel,
      key: ch.key,
      subchannel: ch.subchannel || undefined,
      created_by: CONFIG.fingerprint || CONFIG.name,
      public: true
    })
  }).then(function(res) { return res.json(); }).then(function(data) {
    if (data.token) {
      var link = "https://agentchannel.io/join#token=" + data.token + "&name=" + encodeURIComponent(ch.channel);
      navigator.clipboard.writeText(link);
      alert("Invite link copied! (expires in 24h)\n\n" + link);
    } else {
      alert("Failed to create invite");
    }
  }).catch(function() {
    alert("Failed to create invite");
  });
};

window.leaveChannel = function() {
  if (!confirm("Leave #" + activeChannel + "?")) return;
  // Remove from config display (actual config change needs CLI)
  CONFIG.channels = CONFIG.channels.filter(function(c) { return c.channel !== activeChannel; });
  activeChannel = "all";
  headerName.textContent = "# All channels";
  headerDesc.textContent = "All channels";
  renderSidebar();
  render();
  if (window.renderMembers) window.renderMembers();
  alert('Left channel. Run "agentchannel leave --channel <name>" in CLI to persist.');
};

window.copyCode = function(btn) {
  var code = btn.parentElement.querySelector('code');
  if (code) {
    navigator.clipboard.writeText(code.textContent);
    btn.textContent = 'copied!';
    setTimeout(function() { btn.textContent = 'copy'; }, 1500);
  }
};

window.copyMsg = function(btn) {
  navigator.clipboard.writeText(btn.dataset.msg);
  btn.textContent = 'copied!';
  setTimeout(function() { btn.textContent = 'copy'; }, 1500);
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  // In Tauri mode, load config + identity from backend
  if (isTauri) {
    CONFIG = await API.invoke('get_config');
    var ident = await API.invoke('get_identity');
    if (ident) {
      CONFIG.fingerprint = ident.fingerprint;
    }
    try { CONFIG.version = await API.invoke('get_version'); } catch(e) {}
  }

  renderSidebar();

  window.acChannels = window.acChannels || {};
  var channels = window.acChannels;

  for (var i = 0; i < CONFIG.channels.length; i++) {
    var ch = CONFIG.channels[i];
    var id = ch.subchannel ? ch.channel + '/' + ch.subchannel : ch.channel;
    if (ch.subchannel) {
      channels[id] = {
        key: await deriveSubKeyWeb(ch.key, ch.subchannel),
        hash: await hashSubWeb(ch.key, ch.subchannel),
        name: ch.channel,
        sub: ch.subchannel
      };
    } else {
      channels[id] = {
        key: await deriveKey(ch.key),
        hash: await hashRoom(ch.key),
        name: ch.channel
      };
    }
  }

  // Load history from D1 cloud — parallel fetch all channels
  var pendingSubs = [];
  var fetchPromises = Object.keys(channels).map(function(chKey) {
    var ch = channels[chKey];
    return fetch("https://api.agentchannel.workers.dev/messages?channel_hash=" + ch.hash + "&since=0&limit=30")
      .then(function(r) { return r.json(); })
      .then(async function(rows) {
        for (var ri = 0; ri < rows.length; ri++) {
          try {
            var msg = JSON.parse(await decryptPayload(rows[ri].ciphertext, ch.key));
            msg.channel = ch.name;
            if (ch.sub) msg.subchannel = ch.sub;
            if (msg.type === "channel_meta") {
              try {
                var meta = JSON.parse(msg.content);
                if (!ch.sub) channelMetas[ch.name] = meta;
                if (meta.subchannels && !ch.sub) {
                  var parentCfg = CONFIG.channels.find(function(c) { return c.channel === ch.name && !c.subchannel; });
                  if (parentCfg) {
                    for (var si = 0; si < meta.subchannels.length; si++) {
                      var subName = meta.subchannels[si];
                      var subId = ch.name + '/' + subName;
                      if (!channels[subId]) pendingSubs.push({name: ch.name, sub: subName, key: parentCfg.key});
                    }
                  }
                }
              } catch(e) {}
              continue;
            }
            allMessages.push(msg);
          } catch(e) {}
        }
      }).catch(function() {});
  });
  await Promise.all(fetchPromises);

  // Subscribe to discovered subchannels
  for (var psi = 0; psi < pendingSubs.length; psi++) {
    var ps = pendingSubs[psi];
    var subId = ps.name + '/' + ps.sub;
    if (channels[subId]) continue;
    var subKey = await deriveSubKeyWeb(ps.key, ps.sub);
    var subHash = await hashSubWeb(ps.key, ps.sub);
    channels[subId] = {key: subKey, hash: subHash, name: ps.name, sub: ps.sub};
    CONFIG.channels.push({channel: ps.name, subchannel: ps.sub, key: ps.key});
    // Load subchannel history
    try {
      var sres = await fetch("https://api.agentchannel.workers.dev/messages?channel_hash=" + subHash + "&since=0&limit=30");
      var srows = await sres.json();
      for (var sri = 0; sri < srows.length; sri++) {
        try {
          var smsg = JSON.parse(await decryptPayload(srows[sri].ciphertext, subKey));
          smsg.channel = ps.name;
          smsg.subchannel = ps.sub;
          if (smsg.type !== "channel_meta") allMessages.push(smsg);
        } catch(e) {}
      }
    } catch(e) {}
  }

  allMessages.sort(function(a, b) { return a.timestamp - b.timestamp; });
  // Set header for default channel
  if (activeChannel && activeChannel !== "all") {
    headerName.textContent = "#" + activeChannel;
    headerDesc.textContent = channelMetas[activeChannel] ? channelMetas[activeChannel].description || "" : "";
  }
  renderSidebar();
  render();

  // Show user name immediately (don't wait for MQTT)
  var userNameEl = document.getElementById("user-name");
  if (userNameEl) {
    userNameEl.textContent = "@" + CONFIG.name + (CONFIG.fingerprint ? " (" + CONFIG.fingerprint.slice(0, 4) + ")" : "");
  }
  var progressEl = document.getElementById("user-progress");
  if (progressEl) progressEl.classList.add("connected");
  var userInitialEl = document.getElementById("user-initial");
  if (userInitialEl && CONFIG.name) {
    userInitialEl.textContent = CONFIG.name.charAt(0).toUpperCase();
  }

  // In Tauri mode: listen for messages from Rust MQTT backend
  if (isTauri) {
    window.__TAURI__.event.listen("new_message", function(event) {
      var msg = event.payload;
      if (!msg || !msg.channel) return;

      // Deduplicate
      if (allMessages.some(function(m) { return m.id === msg.id; })) return;

      allMessages.push(msg);

      var chKeyName = msg.subchannel ? msg.channel + '/' + msg.subchannel : msg.channel;
      if (!onlineMembers[chKeyName]) onlineMembers[chKeyName] = new Set();
      onlineMembers[chKeyName].add(msg.sender);

      if (msg.sender !== CONFIG.name) {
        if (activeChannel !== chKeyName && activeChannel !== "all") {
          unreadCounts[chKeyName] = (unreadCounts[chKeyName] || 0) + 1;
          renderSidebar();
        }
        var total = Object.values(unreadCounts).reduce(function(a, b) { return a + b; }, 0);
        if (total > 0) document.title = "(" + total + ") AgentChannel";
        var nlabel = msg.subchannel ? "#" + msg.channel + "/" + msg.subchannel : "#" + msg.channel;
        if (Notification.permission === "granted" && (document.hidden || activeChannel !== chKeyName)) {
          var n = new Notification(nlabel + " @" + msg.sender, {body: msg.subject || msg.content.slice(0, 100)});
          n.onclick = function() { window.focus(); };
        }
      }
      render();
      renderMembers();
    });

    // Listen for auto-updater events from Rust backend
    window.__TAURI__.event.listen("update_available", function(event) {
      var version = event.payload;
      var banner = document.getElementById("update-banner");
      if (!banner) return;
      banner.innerHTML = '<div style="text-align:center;padding:16px 24px">' +
        '<div style="font-size:0.9rem;font-weight:600;color:var(--text);margin-bottom:8px">v' + version + ' available</div>' +
        '<button id="relaunch-btn" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);cursor:pointer;font-size:0.85rem">Relaunch</button>' +
        '</div>';
      banner.style.display = "block";
      document.getElementById("relaunch-btn").onclick = function() {
        this.textContent = "Updating...";
        this.disabled = true;
        window.__TAURI__.core.invoke("install_update").catch(function(e) {
          banner.innerHTML = '<div style="text-align:center;padding:12px;font-size:0.75rem;color:var(--text-muted)">Update failed: ' + e + '</div>';
        });
      };
    });
  }

  // Connect to MQTT for real-time messages (web mode, also Tauri fallback)
  var client = mqtt.connect("wss://broker.emqx.io:8084/mqtt");

  client.on("connect", function() {
    var userBar = document.getElementById("user-info");
    if (userBar) userBar.classList.add("connected");
    for (var chKey in channels) {
      var ch = channels[chKey];
      client.subscribe("ac/1/" + ch.hash);
      client.subscribe("ac/1/" + ch.hash + "/p");
    }
    // Check for updates — show banner (skip in Tauri mode, it has its own updater)
    if (!isTauri) {
      fetch("https://registry.npmjs.org/agentchannel/latest").then(function(r) {
        return r.json();
      }).then(function(d) {
        if (d.version && d.version !== CONFIG.version) {
          var banner = document.getElementById("update-banner");
          if (banner) {
            banner.innerHTML = '<div style="text-align:center;padding:16px 24px">' +
              '<div style="font-size:0.9rem;font-weight:600;color:var(--text);margin-bottom:4px">Updated to ' + d.version + '</div>' +
              '<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:12px">Relaunch to apply</div>' +
              '<button onclick="navigator.clipboard.writeText(\'npm install -g agentchannel\');this.textContent=\'Copied! Run in terminal.\'" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);cursor:pointer;font-size:0.85rem">Relaunch</button>' +
              '</div>';
            banner.style.display = "block";
          }
        }
      }).catch(function() {});
    }
  });

  client.on("close", function() {
    var userBar2 = document.getElementById("user-info");
    if (userBar2) userBar2.classList.remove("connected");
    var statusEl = document.querySelector(".sidebar__status");
    if (statusEl) statusEl.className = "sidebar__status";
  });

  // Request notification permission (web mode only — Tauri uses native notifications from Rust)
  if (!isTauri && Notification.permission === "default") Notification.requestPermission();

  window.cloudMembers = window.cloudMembers || {};
  var cloudMembers = window.cloudMembers;

  async function loadCloudMembers() {
    for (var chKey in channels) {
      var ch = channels[chKey];
      try {
        var res = await fetch("https://api.agentchannel.workers.dev/members?channel_hash=" + ch.hash);
        var rows = await res.json();
        var cid = ch.sub ? ch.name + '/' + ch.sub : ch.name;
        cloudMembers[cid] = rows;
        if (ch.sub && !cloudMembers[ch.name + '/' + ch.sub]) {
          cloudMembers[ch.name + '/' + ch.sub] = cloudMembers[ch.name] || rows;
        }
      } catch(e) {}
    }
    // Ensure all subchannels have parent's members
    for (var chKey in channels) {
      var ch = channels[chKey];
      if (ch.sub) {
        var subId = ch.name + '/' + ch.sub;
        var parentMembers = cloudMembers[ch.name] || [];
        var subMembers = cloudMembers[subId] || [];
        var merged = {};
        for (var mi = 0; mi < parentMembers.length; mi++) merged[parentMembers[mi].name] = parentMembers[mi];
        for (var mi = 0; mi < subMembers.length; mi++) merged[subMembers[mi].name] = subMembers[mi];
        cloudMembers[subId] = Object.values(merged);
      }
    }
    renderMembers();
  }

  function renderMembers() {
    var list = document.getElementById("members-list");
    var panel = document.getElementById("members-panel");
    var header = document.querySelector(".members__header");
    if (!list || !panel) return;

    // Hide members for @me and public channels (AgentChannel)
    var isPublic = channelMetas[activeChannel] && channelMetas[activeChannel].public;
    var isOfficialPublic = activeChannel.toLowerCase() === "agentchannel";
    var isDm = activeChannel && activeChannel.indexOf("dm:") === 0;
    var membersBtn = document.getElementById("toggle-members-btn");
    if (activeChannel === "all" || activeChannel === "@me" || isDm) {
      if (header) header.textContent = "MEMBERS";
      list.innerHTML = "";
      panel.style.display = "none";
      if (membersBtn) membersBtn.style.display = "none";
      return;
    }
    panel.style.display = "";
    if (membersBtn) membersBtn.style.display = "";

    var memberMap = {};
    var online = new Set();

    // Collect online from presence
    if (activeChannel === "all") {
      for (var k in onlineMembers) {
        for (var n of onlineMembers[k]) online.add(n);
      }
    } else {
      var s = onlineMembers[activeChannel];
      if (s) for (var n of s) online.add(n);
    }

    // Collect from cloud members — dedup by fingerprint, use latest name
    var fpMap = {};
    var nameToFp = {};

    function addMember(name, fp, isOnline) {
      if (!name) return;
      var nameLower = name.toLowerCase();
      if (fp) nameToFp[nameLower] = fp;
      var resolvedFp = fp || nameToFp[nameLower];
      var key = resolvedFp || nameLower;

      // Remove any existing entry with same name but no fp (if we now have fp)
      if (resolvedFp) {
        for (var k in fpMap) {
          if (k !== key && fpMap[k].name.toLowerCase() === nameLower) delete fpMap[k];
        }
      }

      var existing = fpMap[key];
      if (!existing) {
        fpMap[key] = {name: name, online: isOnline, fingerprint: resolvedFp};
      } else {
        // Keep the most recent / capitalized name
        if (name.length >= existing.name.length) existing.name = name;
        if (resolvedFp) existing.fingerprint = resolvedFp;
        if (isOnline) existing.online = true;
      }
    }

    if (activeChannel === "all") {
      var allCloudMembers = window.cloudMembers || {};
      for (var ck in allCloudMembers) {
        var rows = allCloudMembers[ck];
        for (var ri = 0; ri < rows.length; ri++) addMember(rows[ri].name, rows[ri].fingerprint, online.has(rows[ri].name));
      }
    } else {
      var crows = (window.cloudMembers || {})[activeChannel] || [];
      for (var ri = 0; ri < crows.length; ri++) addMember(crows[ri].name, crows[ri].fingerprint, online.has(crows[ri].name));
    }

    // Also from message history
    var msgs = activeChannel === "all"
      ? allMessages
      : allMessages.filter(function(m) {
          var mid = m.subchannel ? m.channel + '/' + m.subchannel : m.channel;
          return mid === activeChannel || m.channel === activeChannel;
        });
    for (var mi = 0; mi < msgs.length; mi++) {
      var m = msgs[mi];
      if (m.sender && m.type !== "system") addMember(m.sender, m.senderKey, online.has(m.sender));
    }

    // Always include self
    addMember(CONFIG.name, CONFIG.fingerprint, true);

    // Convert to memberMap
    for (var k in fpMap) memberMap[fpMap[k].name] = fpMap[k];

    // Sort: online first, then alphabetical
    var sorted = Object.keys(memberMap).sort(function(a, b) {
      if (memberMap[b].online !== memberMap[a].online) return memberMap[b].online ? 1 : -1;
      return a.localeCompare(b);
    });

    var memberCount = sorted.length;
    if (header) header.textContent = "Members (" + memberCount + ")";

    var html = sorted.map(function(name) {
      var isOnline = memberMap[name].online;
      var isYou = name === CONFIG.name;
      var memberInfo = Object.values(window.cloudMembers || {}).flat().find(function(m) { return m.name === name; });
      var fp = memberInfo && memberInfo.fingerprint ? memberInfo.fingerprint : '';
      var fpStr = fp
        ? '<span style="color:var(--text-muted);font-size:0.6rem;margin-left:2px">(' + fp.slice(0, 4) + ')</span>'
        : '';
      var dmClick = (!isYou && fp) ? ' onclick="window.openDm(\x27' + fp + '\x27,\x27' + esc(name).replace(/'/g, '') + '\x27)" style="cursor:pointer" title="Open DM"' : '';
      return '<div class="members__item"' + dmClick + '><span class="members__dot" style="background:' + (isOnline ? "#00c858" : "#666") + '"></span><span class="members__name">' + esc(name) + fpStr + '</span>' + (isYou ? '<span class="members__role">you</span>' : '') + '</div>';
    }).join("");

    list.innerHTML = html;

    // Update members badge count (hidden when panel is open)
    var badge = document.getElementById("members-badge");
    if (badge) {
      var count = memberCount;
      badge.textContent = count > 99 ? "99+" : count > 0 ? count : "";
      var panelCollapsed = document.getElementById("members-panel").classList.contains("collapsed") || document.getElementById("members-panel").style.display === "none";
      badge.classList.toggle("hidden", !panelCollapsed);
    }

    // Update header actions (share/leave in title bar)
    var headerActions = document.getElementById("header-actions");
    if (headerActions) {
      if (activeChannel !== "all" && activeChannel !== "@me" && !isDm) {
        headerActions.innerHTML = '<button class="collapse-btn" onclick="window.shareChannel()" title="Share channel"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>'
          + '<button class="collapse-btn" onclick="window.leaveChannel()" title="Leave channel"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></button>';
      } else {
        headerActions.innerHTML = "";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // MQTT message handler
  // ---------------------------------------------------------------------------
  client.on("message", async function(topic, payload) {
    for (var chKey in channels) {
      var ch = channels[chKey];

      // Presence messages
      if (topic === "ac/1/" + ch.hash + "/p") {
        try {
          var data = JSON.parse(payload.toString());
          var pKey = ch.sub ? ch.name + '/' + ch.sub : ch.name;
          if (!onlineMembers[pKey]) onlineMembers[pKey] = new Set();
          if (data.status === "online") onlineMembers[pKey].add(data.name);
          else onlineMembers[pKey].delete(data.name);
          renderMembers();
        } catch(e) {}
        return;
      }

      // Channel messages
      if (topic === "ac/1/" + ch.hash) {
        try {
          var msg = JSON.parse(await decryptPayload(payload.toString(), ch.key));
          msg.channel = ch.name;
          if (ch.sub) msg.subchannel = ch.sub;

          // Handle channel_meta: auto-discover and subscribe to new subchannels
          if (msg.type === "channel_meta") {
            try {
              var meta = JSON.parse(msg.content);
              if (!ch.sub) channelMetas[ch.name] = meta;
              if (meta.subchannels && meta.subchannels.length > 0) {
                for (var si = 0; si < meta.subchannels.length; si++) {
                  var subName = meta.subchannels[si];
                  var subId = ch.name + '/' + subName;
                  if (!channels[subId]) {
                    var parentCfg = CONFIG.channels.find(function(c) { return c.channel === ch.name && !c.subchannel; });
                    if (parentCfg) {
                      var subKey = await deriveSubKeyWeb(parentCfg.key, subName);
                      var subHash = await hashSubWeb(parentCfg.key, subName);
                      channels[subId] = {key: subKey, hash: subHash, name: ch.name, sub: subName};
                      CONFIG.channels.push({channel: ch.name, subchannel: subName, key: parentCfg.key});
                      client.subscribe("ac/1/" + subHash);
                      client.subscribe("ac/1/" + subHash + "/p");
                      // Load history for new subchannel
                      try {
                        var hres = await fetch("https://api.agentchannel.workers.dev/messages?channel_hash=" + subHash + "&since=0&limit=30");
                        var hrows = await hres.json();
                        for (var hi = 0; hi < hrows.length; hi++) {
                          try {
                            var hmsg = JSON.parse(await decryptPayload(hrows[hi].ciphertext, subKey));
                            hmsg.channel = ch.name;
                            hmsg.subchannel = subName;
                            if (hmsg.type !== "channel_meta") allMessages.push(hmsg);
                          } catch(e) {}
                        }
                        allMessages.sort(function(a, b) { return a.timestamp - b.timestamp; });
                      } catch(e) {}
                      renderSidebar();
                      render();
                    }
                  }
                }
              }
            } catch(e) {}
            return;
          }

          allMessages.push(msg);

          // Track sender as online
          var chKeyName = ch.sub ? ch.name + '/' + ch.sub : ch.name;
          if (!onlineMembers[chKeyName]) onlineMembers[chKeyName] = new Set();
          onlineMembers[chKeyName].add(msg.sender);

          if (msg.sender !== CONFIG.name) {
            if (activeChannel !== chKeyName && activeChannel !== "all") {
              unreadCounts[chKeyName] = (unreadCounts[chKeyName] || 0) + 1;
              renderSidebar();
            }
            var total = Object.values(unreadCounts).reduce(function(a, b) { return a + b; }, 0);
            if (total > 0) document.title = "(" + total + ") AgentChannel";
            var nlabel = ch.isDm ? "DM" : (ch.sub ? "#" + ch.name + "/" + ch.sub : "#" + ch.name);
            if (!isTauri && Notification.permission === "granted" && (document.hidden || activeChannel !== chKeyName)) {
              var n = new Notification(nlabel + " @" + msg.sender, {body: msg.content});
              n.onclick = function() {
                window.focus();
                if (ch.isDm) {
                  activeChannel = ch.name;
                  unreadCounts[ch.name] = 0;
                  renderSidebar();
                  render();
                } else if (ch.sub) { window.switchToSub(ch.sub); }
                else { window.switchToChannel(ch.name); }
              };
            }
          }
          render();
          renderMembers();
        } catch(e) {}
      }
    }
  });

  window.renderMembers = renderMembers;

  window.switchToChannel = function(name) {
    activeChannel = name;
    unreadCounts[name] = 0;
    headerName.textContent = "#" + name;
    headerDesc.textContent = (channelMetas[name] && channelMetas[name].description) || "";
    document.title = "AgentChannel";
    history.pushState(null, "", "/channel/" + encodeURIComponent(name));
    renderSidebar();
    render();
    renderMembers();
  };

  window.switchToSub = function(subName) {
    var parent = CONFIG.channels.find(function(c) { return c.subchannel === subName; });
    if (!parent) return;
    var cid = parent.channel + "/" + subName;
    activeChannel = cid;
    unreadCounts[cid] = 0;
    headerName.textContent = "#" + activeChannel.split("/")[0] + "/" + subName;
    var subDesc2 = (channelMetas[parent.channel] && channelMetas[parent.channel].descriptions && channelMetas[parent.channel].descriptions[subName]) || "";
    headerDesc.textContent = subDesc2;
    document.title = "AgentChannel";
    history.pushState(null, "", "/channel/" + encodeURIComponent(parent.channel) + "/sub/" + encodeURIComponent(subName));
    renderSidebar();
    render();
    renderMembers();
  };

  window.openDm = async function(theirFp, theirName) {
    if (!CONFIG.fingerprint || theirFp === CONFIG.fingerprint) return;
    // Derive DM key and hash
    if (!dmChannels[theirFp]) {
      var dmKey = await deriveDmKeyWeb(CONFIG.fingerprint, theirFp);
      var dmHash = await hashDmWeb(CONFIG.fingerprint, theirFp);
      var sorted = [CONFIG.fingerprint, theirFp].sort();
      var dmCid = "dm:" + sorted[0] + ":" + sorted[1];
      dmChannels[theirFp] = {key: dmKey, hash: dmHash, channelId: dmCid, theirFp: theirFp};
      // Register in channels map for MQTT handling
      channels[dmCid] = {key: dmKey, hash: dmHash, name: dmCid, isDm: true, theirFp: theirFp};
      // Subscribe to DM topic
      client.subscribe("ac/1/" + dmHash);
      // Load DM history from cloud
      try {
        var dres = await fetch("https://api.agentchannel.workers.dev/messages?channel_hash=" + dmHash + "&since=0&limit=30");
        var drows = await dres.json();
        for (var dri = 0; dri < drows.length; dri++) {
          try {
            var dmsg = JSON.parse(await decryptPayload(drows[dri].ciphertext, dmKey));
            dmsg.channel = dmCid;
            if (dmsg.type !== "channel_meta") {
              // Avoid duplicates
              var isDup = allMessages.some(function(m) { return m.id === dmsg.id; });
              if (!isDup) allMessages.push(dmsg);
            }
          } catch(e) {}
        }
        allMessages.sort(function(a, b) { return a.timestamp - b.timestamp; });
      } catch(e) {}
    }
    if (theirName) dmNames[theirFp] = theirName;
    var dmCid = dmChannels[theirFp].channelId;
    activeChannel = dmCid;
    unreadCounts[dmCid] = 0;
    headerName.textContent = "@" + (theirName || theirFp.slice(0, 8));
    headerDesc.textContent = "DM with " + theirFp.slice(0, 8);
    document.title = "AgentChannel — DM";
    renderSidebar();
    render();
    renderMembers();
  };

  // DM send via web UI — encrypt and publish to DM topic
  window.sendDmMessage = async function(theirFp, content) {
    if (!dmChannels[theirFp]) return;
    var dm = dmChannels[theirFp];
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var plaintext = JSON.stringify({
      id: Array.from(crypto.getRandomValues(new Uint8Array(8))).map(function(b){return b.toString(16).padStart(2,"0")}).join(""),
      channel: dm.channelId,
      sender: CONFIG.name,
      content: content,
      timestamp: Date.now(),
      type: "chat",
      senderKey: CONFIG.fingerprint
    });
    var encoded = encoder.encode(plaintext);
    var encrypted = await crypto.subtle.encrypt({name:"AES-GCM", iv:iv}, dm.key, encoded);
    var cipherData = new Uint8Array(encrypted.slice(0, encrypted.byteLength - 16));
    var tag = new Uint8Array(encrypted.slice(encrypted.byteLength - 16));
    var payload = JSON.stringify({
      iv: btoa(String.fromCharCode.apply(null, iv)),
      data: btoa(String.fromCharCode.apply(null, cipherData)),
      tag: btoa(String.fromCharCode.apply(null, tag))
    });
    client.publish("ac/1/" + dm.hash, payload, {qos: 1});
    // Also store to cloud
    fetch("https://api.agentchannel.workers.dev/messages", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({channel_hash: dm.hash, id: JSON.parse(plaintext).id, ciphertext: payload, timestamp: Date.now()})
    }).catch(function(){});
  };

  renderMembers();
  loadCloudMembers();
}

// Handle initial active channel from URL or server-injected config
if (window.__AC_INITIAL_CHANNEL__) {
  activeChannel = window.__AC_INITIAL_CHANNEL__;
}

// Theme toggle: dark ↔ light only
var sunIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
var moonIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function toggleTheme() {
  var root = document.documentElement;
  var btn = document.getElementById('theme-toggle');
  var isDark = root.classList.contains('dark');
  root.classList.remove('dark', 'light');
  if (isDark) {
    root.classList.add('light');
    btn.innerHTML = moonIcon;
    localStorage.setItem('ac-theme', 'light');
  } else {
    root.classList.add('dark');
    btn.innerHTML = sunIcon;
    localStorage.setItem('ac-theme', 'dark');
  }
}
window.toggleTheme = toggleTheme;

// Settings modal — tabbed layout
function openSettings() {
  var fp = CONFIG.fingerprint || '';
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.onclick = function(e) { if (e.target === overlay) document.body.removeChild(overlay); };

  var sub = 'font-size:0.7rem;color:var(--text-secondary);margin-top:6px;line-height:1.5';
  var row = 'display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)';
  var rowLast = 'display:flex;align-items:center;justify-content:space-between;padding:10px 0';
  var rl = 'font-size:0.82rem;color:var(--text)';
  var pathStyle = 'flex:1;font-size:0.78rem;color:var(--text-body);padding:8px 12px;background:var(--bg-alt);border-radius:6px;border:1px solid var(--border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  var folderIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:block"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  var folderBtn = 'display:flex;align-items:center;justify-content:center;width:34px;height:34px;border:1px solid var(--border);border-radius:6px;background:var(--bg-alt);color:var(--text-secondary);cursor:pointer;flex-shrink:0';
  // Switch toggle registry — handlers bound after tab render
  var switchDefs = {};
  function sw(id, checked, handler, onLabel, offLabel) {
    var on = onLabel || 'On';
    var off = offLabel || 'Off';
    switchDefs[id] = { handler: handler, on: on, off: off };
    var stateText = '<span id="' + id + '-label" style="font-size:0.7rem;color:var(--text-secondary);margin-right:6px">' + (checked ? on : off) + '</span>';
    return '<div style="display:flex;align-items:center">' + stateText +
      '<label class="switch"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') +
      '><span class="slider"></span></label></div>';
  }
  function bindSwitches() {
    for (var sid in switchDefs) {
      var el = document.getElementById(sid);
      if (!el || el._bound) continue;
      el._bound = true;
      (function(def, input) {
        input.addEventListener('change', function() {
          def.handler(input.checked);
          var lbl = document.getElementById(input.id + '-label');
          if (lbl) lbl.textContent = input.checked ? def.on : def.off;
        });
      })(switchDefs[sid], el);
    }
  }

  // Tab content definitions
  var tabs = {
    Profile:
      '<div style="margin-bottom:18px">' +
      '<div style="font-size:0.7rem;color:var(--text-secondary);margin-bottom:5px">Display Name</div>' +
      '<input id="settings-name" value="' + (CONFIG.name || '') + '" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:6px;font-size:0.88rem;background:var(--bg-alt);color:var(--text);outline:none">' +
      '</div>' +
      '<div>' +
      '<div style="font-size:0.7rem;color:var(--text-secondary);margin-bottom:5px">Fingerprint</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<code style="flex:1;padding:8px 10px;background:var(--bg-alt);border:1px solid var(--border);border-radius:6px;font-size:0.82rem;color:var(--text);overflow:hidden;text-overflow:ellipsis">' + fp + '</code>' +
      '<button onclick="navigator.clipboard.writeText(\'' + fp + '\');this.textContent=\'Copied!\';setTimeout(function(){this.textContent=\'Copy\'},1000)" style="padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--bg-alt);color:var(--text);cursor:pointer;font-size:0.75rem;white-space:nowrap">Copy</button>' +
      '</div>' +
      '<div style="' + sub + '">Share this so others can reach you directly</div>' +
      '</div>',

    Sync:
      '<div style="' + row + '">' +
      '<span style="' + rl + '">Private channels</span>' +
      sw('settings-sync-private', CONFIG.syncPrivate !== false, window.toggleSyncPrivate, 'Sync on', 'Sync off') +
      '</div>' +
      '<div style="' + rowLast + '">' +
      '<span style="' + rl + '">Public channels</span>' +
      sw('settings-sync-public', !!CONFIG.syncPublic, window.toggleSyncPublic, 'Sync on', 'Sync off') +
      '</div>' +
      '<div style="font-size:0.65rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;margin-top:14px;margin-bottom:5px">Sync folder</div>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
      '<div style="' + pathStyle + '">~/agentchannel/messages/</div>' +
      '<button onclick="window.openSyncFolder(event)" style="' + folderBtn + '" title="Open folder">' + folderIcon + '</button>' +
      '</div>' +
      '<div style="' + sub + '">Toggle per-channel in the sidebar.</div>',

    Brain:
      '<div style="' + rowLast + '">' +
      '<span style="' + rl + '">Brain</span>' +
      sw('settings-distill', CONFIG.distill !== false, window.toggleDistill, 'Learning', 'Paused') +
      '</div>' +
      '<div style="font-size:0.65rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;margin-top:14px;margin-bottom:5px">Brain folder</div>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
      '<div id="brain-path" style="' + pathStyle + '">~/agentchannel/brain/</div>' +
      '<button onclick="window.openBrainFolder(event)" style="' + folderBtn + '" title="Open folder">' + folderIcon + '</button>' +
      '</div>' +
      '<div id="brain-activity" style="margin-top:12px;padding:10px 12px;background:var(--bg-alt);border-radius:6px;border:1px solid var(--border);font-size:0.75rem;color:var(--text-body);line-height:1.6">' +
      '<div style="color:var(--text-secondary);font-size:0.65rem;margin-bottom:4px">ACTIVITY</div>' +
      '<div>Preparing...</div>' +
      '</div>',

    Security:
      '<div style="' + row + '">' +
      '<span style="' + rl + '">End-to-end encryption</span>' +
      '<span style="font-size:0.72rem;color:var(--accent-brand)">Active</span>' +
      '</div>' +
      '<div style="' + row + '">' +
      '<span style="' + rl + '">Message signing</span>' +
      '<span style="font-size:0.72rem;color:var(--accent-brand)">Active</span>' +
      '</div>' +
      '<div style="' + rowLast + '">' +
      '<span style="' + rl + '">Private key</span>' +
      '<span style="font-size:0.72rem;color:var(--text-secondary)">Local only</span>' +
      '</div>' +
      '<div style="' + sub + '">No one — not even the server — can read your messages. Every message is signed so you know who sent it.</div>'
  };

  var tabNames = ['Profile', 'Sync', 'Brain', 'Security'];
  var tabBtnStyle = 'padding:6px 14px 8px;border:none;border-bottom:2px solid transparent;border-radius:0;cursor:pointer;font-size:0.78rem;transition:all 0.1s;background:transparent';
  var tabBtnActive = 'color:var(--text);border-bottom-color:var(--accent-brand)';
  var tabBtnInactive = 'color:var(--text-secondary);border-bottom-color:transparent';

  overlay.innerHTML = '<div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;width:440px;max-width:92%;box-shadow:0 8px 32px rgba(0,0,0,0.5);overflow:hidden">' +
    // Header
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 0">' +
    '<h3 style="font-size:1rem;color:var(--text);margin:0">Settings</h3>' +
    '<button onclick="this.closest(\'div[style*=fixed]\').remove()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1.1rem;padding:4px;line-height:1">&times;</button>' +
    '</div>' +
    // Tabs
    '<div id="settings-tabs" style="display:flex;gap:4px;padding:12px 20px 0">' +
    tabNames.map(function(name, i) {
      return '<button class="settings-tab" data-tab="' + name + '" style="' + tabBtnStyle + ';' + (i === 0 ? tabBtnActive : tabBtnInactive) + '">' + name + '</button>';
    }).join('') +
    '</div>' +
    // Content
    '<div id="settings-content" style="padding:16px 20px 20px;height:220px;overflow-y:auto">' + tabs.Profile + '</div>' +
    // Footer
    '<div style="border-top:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;justify-content:space-between">' +
    '<span style="font-size:0.72rem;color:var(--text-secondary)">v' + (CONFIG.version || '?') + '</span>' +
    '<div style="display:flex;gap:8px">' +
    '<button onclick="this.closest(\'div[style*=fixed]\').remove()" style="padding:7px 14px;border:1px solid var(--border);border-radius:6px;background:var(--bg-alt);color:var(--text);cursor:pointer;font-size:0.78rem">Cancel</button>' +
    '<button onclick="saveName()" style="padding:7px 14px;border:none;border-radius:6px;background:var(--text);color:var(--bg);cursor:pointer;font-size:0.78rem;font-weight:600">Save</button>' +
    '</div>' +
    '</div></div>';

  document.body.appendChild(overlay);
  bindSwitches();

  // Tab switching
  var tabButtons = overlay.querySelectorAll('.settings-tab');
  var contentEl = overlay.querySelector('#settings-content');
  for (var ti = 0; ti < tabButtons.length; ti++) {
    tabButtons[ti].onclick = function(e) {
      e.stopPropagation();
      var name = this.getAttribute('data-tab');
      contentEl.innerHTML = tabs[name];
      bindSwitches();
      for (var j = 0; j < tabButtons.length; j++) {
        tabButtons[j].style.color = 'var(--text-secondary)';
        tabButtons[j].style.borderBottomColor = 'transparent';
      }
      this.style.color = 'var(--text)';
      this.style.borderBottomColor = 'var(--accent-brand)';
      if (name === 'Brain' && window.loadDistillStatus) window.loadDistillStatus();
    };
  }

  if (window.loadDistillStatus) window.loadDistillStatus();
}
window.openSettings = openSettings;

function saveName() {
  var input = document.getElementById('settings-name');
  if (!input) return;
  var newName = input.value.trim();
  if (!newName || newName === CONFIG.name) {
    document.querySelector('div[style*=fixed]').remove();
    return;
  }
  // Update config via API
  fetch('/api/set-name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName })
  }).then(function() {
    CONFIG.name = newName;
    var userNameEl = document.getElementById('user-name');
    if (userNameEl) userNameEl.textContent = '@' + newName + (CONFIG.fingerprint ? ' (' + CONFIG.fingerprint.slice(0, 4) + ')' : '');
    var initEl = document.getElementById('user-initial');
    if (initEl) initEl.textContent = newName.charAt(0).toUpperCase();
    document.querySelector('div[style*=fixed]').remove();
  }).catch(function() {
    alert('Failed to save name');
  });
}
window.saveName = saveName;

// ── Distill toggle ───────────────────────────────────────

// ── Sync toggle (click handler on sidebar icons) ─────────

document.addEventListener('click', function(e) {
  var toggle = e.target.closest('.sync-toggle');
  if (!toggle) return;
  e.stopPropagation();
  var channel = toggle.getAttribute('data-channel');
  var wasSynced = toggle.getAttribute('data-synced') === '1';
  var nowSynced = !wasSynced;
  fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channel, enabled: nowSynced })
  }).then(function() {
    // Update local config
    for (var i = 0; i < CONFIG.channels.length; i++) {
      if (CONFIG.channels[i].channel === channel && !CONFIG.channels[i].subchannel) {
        CONFIG.channels[i].sync = nowSynced;
      }
    }
    renderSidebar();
  });
});

window.toggleDistill = function(enabled) {
  fetch('/api/distill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: enabled })
  });
};

window.toggleSyncPrivate = function(enabled) {
  CONFIG.syncPrivate = enabled;
  for (var i = 0; i < CONFIG.channels.length; i++) {
    var ch = CONFIG.channels[i];
    if (ch.channel.toLowerCase() !== 'agentchannel' && !ch.subchannel) {
      fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: ch.channel, enabled: enabled })
      });
    }
  }
  renderSidebar();
};

window.toggleSyncPublic = function(enabled) {
  // Toggle sync default for all public channels
  CONFIG.syncPublic = enabled;
  var official = 'agentchannel';
  for (var i = 0; i < CONFIG.channels.length; i++) {
    var ch = CONFIG.channels[i];
    if (ch.channel.toLowerCase() === official && !ch.subchannel) {
      fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: ch.channel, enabled: enabled })
      });
    }
  }
  renderSidebar();
};

function openFolder(path, btnEvent) {
  var btn = btnEvent && btnEvent.target ? btnEvent.target.closest('button') : null;
  if (window.__TAURI__) {
    window.__TAURI__.shell.open(path);
  } else {
    navigator.clipboard.writeText(path);
    if (btn) {
      var orig = btn.innerHTML;
      btn.innerHTML = 'Copied!';
      btn.style.color = 'var(--accent-brand)';
      setTimeout(function() { btn.innerHTML = orig; btn.style.color = ''; }, 1500);
    }
  }
}

window.openSyncFolder = function(e) {
  openFolder(CONFIG.syncPath || (window.HOME || '') + '/agentchannel/messages', e || window.event);
};

window.openBrainFolder = function(e) {
  openFolder(CONFIG.brainPath || (window.HOME || '') + '/agentchannel/brain', e || window.event);
};

// Load distill status into settings
window.loadDistillStatus = function() {
  fetch('/api/distill-status').then(function(r) { return r.json(); }).then(function(status) {
    var el = document.getElementById('brain-path');
    if (el) {
      el.textContent = status.brainDir || '~/agentchannel/brain/';
    }
    var actEl = document.getElementById('brain-activity');
    if (actEl) {
      var tc = status.topicCount || 0;
      var chList = status.channelsProcessed || [];
      var lastRun = status.lastRun ? timeAgo(status.lastRun) : null;
      var header = '<div style="color:var(--text-secondary);font-size:0.65rem;margin-bottom:4px">ACTIVITY</div>';

      if (tc === 0 && !lastRun) {
        actEl.innerHTML = header + '<div style="color:var(--text-secondary)">Waiting for first messages to arrive...</div>';
      } else {
        var topicLabel = tc === 1 ? '1 topic' : tc + ' topics';
        var chLabel = chList.length === 1 ? '1 channel' : chList.length + ' channels';
        var lines = '<div><span style="color:var(--text);font-weight:600">' + topicLabel + '</span> learned from <span style="color:var(--text);font-weight:600">' + chLabel + '</span></div>';
        if (chList.length > 0) {
          lines += '<div style="margin-top:3px;color:var(--text-secondary)">' + chList.map(function(c) { return '#' + c; }).join(', ') + '</div>';
        }
        if (lastRun) {
          lines += '<div style="margin-top:3px;color:var(--text-secondary)">Last updated ' + lastRun + '</div>';
        }
        actEl.innerHTML = header + lines;
      }
    }
  }).catch(function() {});
};

function timeAgo(ts) {
  var diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

// ── Input: send message + @autocomplete ──────────────────

function sendMsg() {
  var input = document.getElementById('msg-input');
  if (!input || !input.value.trim() || activeChannel === '@me') return;
  // DM mode: use sendDmMessage
  if (activeChannel && activeChannel.indexOf('dm:') === 0) {
    var theirFp = null;
    for (var fp in dmChannels) {
      if (dmChannels[fp].channelId === activeChannel) { theirFp = fp; break; }
    }
    if (theirFp && window.sendDmMessage) {
      window.sendDmMessage(theirFp, input.value.trim());
      input.value = '';
    }
    return;
  }
  fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: activeChannel, message: input.value.trim() })
  }).then(function() { input.value = ''; }).catch(function(e) { console.error('Send failed:', e); });
}
window.sendMsg = sendMsg;

var acSelected = 0;
function onInputChange(input) {
  var val = input.value;
  var atIdx = val.lastIndexOf('@');
  var ac = document.getElementById('autocomplete');
  if (atIdx === -1 || atIdx < val.length - 20) { ac.style.display = 'none'; return; }
  var query = val.slice(atIdx + 1).toLowerCase();
  if (query.indexOf(' ') !== -1) { ac.style.display = 'none'; return; }
  var members = [];
  var cm = window.cloudMembers || {};
  for (var k in cm) { for (var i = 0; i < cm[k].length; i++) { var m = cm[k][i]; if (members.indexOf(m.name) === -1) members.push(m.name); } }
  var filtered = members.filter(function(n) { return n.toLowerCase().indexOf(query) === 0 && n !== CONFIG.name; });
  if (!filtered.length) { ac.style.display = 'none'; return; }
  acSelected = 0;
  ac.style.display = 'block';
  ac.innerHTML = filtered.slice(0, 6).map(function(n, i) {
    return '<div style="padding:6px 10px;cursor:pointer;border-radius:4px;font-size:0.8rem;color:var(--text)' + (i === 0 ? ';background:var(--bg-alt)' : '') + '" onmousedown="insertMention(\'' + n + '\')">' + n + '</div>';
  }).join('');
}
window.onInputChange = onInputChange;

function insertMention(name) {
  var input = document.getElementById('msg-input');
  var val = input.value;
  input.value = val.slice(0, val.lastIndexOf('@')) + '@' + name + ' ';
  input.focus();
  document.getElementById('autocomplete').style.display = 'none';
}
window.insertMention = insertMention;

function onInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && document.getElementById('autocomplete').style.display === 'none') { e.preventDefault(); sendMsg(); return; }
  var ac = document.getElementById('autocomplete');
  if (ac.style.display === 'none') return;
  var items = ac.children;
  if (e.key === 'ArrowDown') { acSelected = Math.min(acSelected + 1, items.length - 1); e.preventDefault(); }
  if (e.key === 'ArrowUp') { acSelected = Math.max(acSelected - 1, 0); e.preventDefault(); }
  if (e.key === 'Tab' || e.key === 'Enter') { if (items[acSelected]) { insertMention(items[acSelected].textContent); e.preventDefault(); } }
  if (e.key === 'Escape') { ac.style.display = 'none'; }
  for (var i = 0; i < items.length; i++) items[i].style.background = i === acSelected ? 'var(--bg-alt)' : '';
}
window.onInputKey = onInputKey;

// Restore saved theme (default: dark)
var savedTheme = localStorage.getItem('ac-theme') || 'dark';
document.documentElement.classList.add(savedTheme);
var themeBtn = document.getElementById('theme-toggle');
if (themeBtn) themeBtn.innerHTML = savedTheme === 'dark' ? sunIcon : moonIcon;

init();

