"""Launch the packaged app with a disposable project and capture WebKit PID delta."""
import argparse
import json
import os
import subprocess
import time
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--app',required=True)
parser.add_argument('--appdata',required=True)
parser.add_argument('--fixture',required=True)
parser.add_argument('--out',required=True)
args=parser.parse_args()
appdata=Path(args.appdata);appdata.mkdir(parents=True,exist_ok=True)
(appdata/'settings.json').write_text(json.dumps({'recentProjects':[str(Path(args.fixture).resolve())]},indent=2)+'\n')
def webkit():
    raw=subprocess.check_output(['ps','-axo','pid=,comm='],text=True)
    return {int(parts[0]) for line in raw.splitlines() if len(parts:=line.split(None,1))==2 and 'WebKit' in parts[1]}
before=webkit()
app=Path(args.app)
binary=app/'Contents/MacOS/omenflow-rust-desktop'
with (appdata/'app.log').open('w') as log:
    child=subprocess.Popen([str(binary)],env={**os.environ,'OMENFLOW_APP_DATA_DIR':str(appdata)},
        stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
time.sleep(3)
if child.poll() is not None: raise SystemExit(f'Packaged app exited: {child.returncode}')
result={'pid':child.pid,'app':str(app),'appdata':str(appdata),'fixture':str(Path(args.fixture).resolve()),
        'initialWebKitPids':sorted(webkit()-before)}
Path(args.out).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
