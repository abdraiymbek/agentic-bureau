"""Sample a packaged Rust app and its newly launched WebKit XPC services."""
import argparse
import json
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--extra-pids', default='')
parser.add_argument('--seconds', type=int, default=60)
parser.add_argument('--out', required=True)
args = parser.parse_args()
extra = {int(x) for x in args.extra_pids.split(',') if x}
samples = []
for _ in range(args.seconds):
    raw = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pcpu=,rss=,comm='], text=True)
    rows = []
    for line in raw.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5:
            rows.append((int(parts[0]), int(parts[1]), float(parts[2]), int(parts[3]), parts[4]))
    selected = {args.pid}
    for _depth in range(8):
        selected |= {row[0] for row in rows if row[1] in selected}
    if not any(row[0] == args.pid for row in rows):
        raise SystemExit('Target Rust desktop exited during sampling')
    main = [dict(pid=row[0], cpu=row[2], rssKiB=row[3], comm=row[4]) for row in rows if row[0] in selected]
    webkit = [dict(pid=row[0], cpu=row[2], rssKiB=row[3], comm=row[4]) for row in rows if row[0] in extra and 'WebKit' in row[4]]
    combined = main + webkit
    samples.append(dict(at=time.time(), processes=combined,
        mainRssKiB=sum(row['rssKiB'] for row in main),
        rssKiB=sum(row['rssKiB'] for row in combined),
        cpu=sum(row['cpu'] for row in combined)))
    time.sleep(1)
out = dict(method='60 one-second ps samples; root plus descendants and WebKit XPC PIDs newly created by launch. Summed RSS includes shared pages; WebKit attribution by launch delta is an estimate.',
    seconds=args.seconds, extraWebKitPids=sorted(extra),
    meanCpu=sum(s['cpu'] for s in samples)/len(samples),
    maxRssMiB=max(s['rssKiB'] for s in samples)/1024,
    maxMainRssMiB=max(s['mainRssKiB'] for s in samples)/1024,
    samples=samples)
Path(args.out).write_text(json.dumps(out, indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items() if k != 'samples'}))
