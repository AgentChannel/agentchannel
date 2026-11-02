import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * P4: `ach run --install-service` writes a macOS launchd agent or a Linux
 * systemd user unit that starts this runner at login and restarts it. It only
 * writes the file and prints how to start it; it never loads the unit.
 */
export interface ServiceSpec {
  platform: 'darwin' | 'linux';
  agentName: string;
  /** node binary and cli.js of this install. */
  node: string;
  cli: string;
  /** `run` arguments, without --install-service. */
  args: string[];
  env: Record<string, string>;
  /** Where runner output goes. */
  logFile: string;
}

export interface ServiceFile {
  path: string;
  content: string;
  start: string[];
  stop: string[];
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** systemd quoting: wrap in double quotes, escape backslash, quote, dollar and percent. */
function sd(s: string): string {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;
}

export function serviceLabel(agentName: string): string {
  return `io.agentchannel.runner.${agentName.replace(/[^A-Za-z0-9-]/g, '-')}`;
}

export function launchdPlist(s: ServiceSpec): string {
  const progArgs = [s.node, s.cli, 'run', ...s.args].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const env = Object.entries(s.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(serviceLabel(s.agentName))}</string>
  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(s.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(s.logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(s: ServiceSpec): string {
  const exec = [s.node, s.cli, 'run', ...s.args].map(sd).join(' ');
  const env = Object.entries(s.env)
    .map(([k, v]) => `Environment=${sd(`${k}=${v}`)}`)
    .join('\n');
  return `[Unit]
Description=AgentChannel runner (agent ${s.agentName})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
${env}
Restart=on-failure
RestartSec=10
# B7: exit 78 = key rotated or agent deactivated; restarting cannot help.
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
`;
}

export function serviceFile(s: ServiceSpec, dir?: string): ServiceFile {
  if (s.platform === 'darwin') {
    const label = serviceLabel(s.agentName);
    const path = join(dir ?? join(homedir(), 'Library', 'LaunchAgents'), `${label}.plist`);
    return {
      path,
      content: launchdPlist(s),
      start: [`launchctl bootstrap gui/$(id -u) ${path}`],
      stop: [`launchctl bootout gui/$(id -u)/${label}`],
    };
  }
  const unit = `agentchannel-runner-${s.agentName.replace(/[^A-Za-z0-9-]/g, '-')}.service`;
  const path = join(dir ?? join(homedir(), '.config', 'systemd', 'user'), unit);
  return {
    path,
    content: systemdUnit(s),
    start: ['systemctl --user daemon-reload', `systemctl --user enable --now ${unit}`, `loginctl enable-linger "$USER"   # optional: keep it running while logged out`],
    stop: [`systemctl --user disable --now ${unit}`],
  };
}

/** Write the unit file (mode 0644; it holds no secrets). Never loads it. */
export function writeServiceFile(f: ServiceFile): void {
  const dir = join(f.path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(f.path, f.content, { mode: 0o644 });
}
