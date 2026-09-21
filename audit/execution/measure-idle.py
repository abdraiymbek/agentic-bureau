"""Sample only a specified desktop process tree; excludes model CLIs and build tools."""
import argparse
import json
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--seconds', type=int, default=60)
parser.add_argument('--out', required=True)
args = parser.parse_args()
samples = []
for _ in range(args.seconds):
    rows = []
    raw = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pcpu=,rss=,comm='], text=True)
    for line in raw.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5:
            rows.append((int(parts[0]), int(parts[1]), float(parts[2]), int(parts[3]), parts[4]))
    selected = {args.pid}
    for _depth in range(8):
        more = {r[0] for r in rows if r[1] in selected and ('Electron' in r[4] or 'Omen Flow' in r[4] or 'omenflow-desktop' in r[4])}
        if more <= selected:
            break
        selected |= more
    measured = [dict(pid=r[0], cpu=r[2], rssKiB=r[3]) for r in rows if r[0] in selected]
    if not any(r['pid'] == args.pid for r in measured):
        raise SystemExit('Target desktop exited during sampling')
    samples.append(dict(at=time.time(), processes=measured, cpu=sum(r['cpu'] for r in measured), rssKiB=sum(r['rssKiB'] for r in measured)))
    time.sleep(1)
out = dict(method='ps percent CPU relative to one core; summed RSS includes shared pages; no frame-time/GPU-utilization claim', seconds=args.seconds, meanCpu=sum(s['cpu'] for s in samples)/len(samples), maxRssMiB=max(s['rssKiB'] for s in samples)/1024, samples=samples)
Path(args.out).write_text(json.dumps(out, indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items() if k != 'samples'}))
