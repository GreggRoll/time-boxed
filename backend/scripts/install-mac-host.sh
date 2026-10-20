#!/bin/zsh
set -eu
source_dir="${0:A:h:h}"
runtime_dir="$HOME/Library/Application Support/TimeBoxedHost"
agent_path="$HOME/Library/LaunchAgents/com.gregadams.timeboxed.backend.plist"
log_dir="$HOME/Library/Logs/TimeBoxed"
mkdir -p "${agent_path:h}" "$log_dir"
# Install outside Desktop so launchd can access the runtime without depending on Desktop privacy permissions.
# Copy credentials separately with private permissions; never print them.
/usr/bin/python3 - "$source_dir" "$runtime_dir" "$agent_path" "$log_dir" <<'PY'
import os,plistlib,shutil,sys
from pathlib import Path
source,runtime,agent,logs=map(Path,sys.argv[1:])
runtime.mkdir(parents=True,exist_ok=True)
os.chmod(runtime,0o700)
for name in ('compose.yaml','Dockerfile','.dockerignore','package.json','package-lock.json'):
    shutil.copy2(source/name,runtime/name)
for path in source.glob('*.mjs'): shutil.copy2(path,runtime/path.name)
for name in ('certs','scripts','test'):
    shutil.copytree(source/name,runtime/name,dirs_exist_ok=True)
if (source/'.env').exists() and not (runtime/'.env').exists():
    shutil.copy2(source/'.env',runtime/'.env')
    os.chmod(runtime/'.env',0o600)
secrets=runtime/'.secrets'
secrets.mkdir(exist_ok=True)
os.chmod(secrets,0o700)
token=source/'.secrets/cloudflare-tunnel-token'
# Do not erase an already configured runtime token with an empty source placeholder.
if token.exists() and (not (secrets/token.name).exists() or ((secrets/token.name).stat().st_size == 0 and token.stat().st_size > 0)):
    shutil.copy2(token,secrets/token.name)
    os.chmod(secrets/token.name,0o600)
value={'Label':'com.gregadams.timeboxed.backend','ProgramArguments':['/bin/zsh',str(runtime/'scripts/mac-host.sh')],
       'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':30,'ProcessType':'Background',
       'StandardOutPath':str(logs/'host.log'),'StandardErrorPath':str(logs/'host-error.log')}
agent.write_bytes(plistlib.dumps(value))
PY
launchctl bootout "gui/$(id -u)" "$agent_path" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent_path"
launchctl kickstart "gui/$(id -u)/com.gregadams.timeboxed.backend"
print "Installed Mac runtime: $runtime_dir"
print "Login service logs: $log_dir"
