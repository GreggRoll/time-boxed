#!/bin/zsh
# Run interactively on the Mac. The token is hidden, never a command argument or Git file.
set -eu
runtime_dir="$HOME/Library/Application Support/TimeBoxedHost"
if [[ ! -f "$runtime_dir/compose.yaml" ]]; then
  print -u2 "First run backend/scripts/install-mac-host.sh."
  exit 1
fi
/usr/bin/python3 - "$runtime_dir" <<'PY'
import getpass,json,os,re,sys
from pathlib import Path
runtime=Path(sys.argv[1])
# Read from the controlling terminal because Python's stdin contains this script.
with open('/dev/tty','r+') as terminal:
    terminal.write('Free domain from ngrok dashboard (hostname only): ')
    terminal.flush()
    domain=terminal.readline().strip().lower()
if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ngrok-free\.(?:app|dev)',domain):
    raise SystemExit('Use your assigned ngrok-free.app or ngrok-free.dev hostname, without https:// or a path.')
token=getpass.getpass('ngrok authtoken (hidden): ').strip()
if not re.fullmatch(r'[A-Za-z0-9_-]{20,200}',token):
    raise SystemExit('The token format looks incorrect. Copy only the authtoken value.')
secrets=runtime/'.secrets'
secrets.mkdir(exist_ok=True,mode=0o700)
os.chmod(secrets,0o700)
destination=secrets/'ngrok.yml'
config='\n'.join(['version: "2"','authtoken: '+json.dumps(token),'web_addr: false','update_check: false',
    'tunnels:','  planning:','    proto: http','    addr: http://backend:3000',
    '    domain: '+json.dumps(domain),'    schemes: [https]','    inspect: false',''])
# Create with private permissions from the first byte, then atomically replace.
temporary=secrets/'ngrok.yml.pending'
fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
os.fchmod(fd,0o600)
with os.fdopen(fd,'w') as stream: stream.write(config)
os.replace(temporary,destination)
print('Saved private ngrok configuration. Public hostname: https://'+domain)
print('Keep full request/response capture disabled in the ngrok dashboard.')
PY
cd "$runtime_dir"
docker run --rm --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$runtime_dir/.secrets/ngrok.yml:/run/secrets/ngrok.yml:ro" ngrok/ngrok:alpine config check --config /run/secrets/ngrok.yml
TRUST_PROXY=ngrok docker compose --profile ngrok up -d --wait
