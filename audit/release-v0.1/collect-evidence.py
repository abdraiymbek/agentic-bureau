"""Collect fixture-only release results without copying credentials or provider traces."""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='/tmp/omen-v01-readiness')
parser.add_argument('--out', default='audit/release-v0.1/evidence')
args = parser.parse_args()
base, out = Path(args.base), Path(args.out)
out.mkdir(parents=True, exist_ok=True)

def write(name, value):
    (out / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')

def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None

campaigns = {}
for name, roots in {
    'qualified-baseline': ['qualified-main', 'qualified-holdout'],
    'complex-budget-confirmation-before-winding-fix': ['budget-confirm-main', 'budget-confirm-holdout'],
    'winding-regression-before-normal-guidance': ['winding-final'],
    'final-normal-regression': ['normal-final'],
}.items():
    runs = []
    for root in roots:
        for file in sorted((base / root).glob('*/r*/result.json')):
            r = json.loads(file.read_text())
            m = r['metrics']
            runs.append(dict(task=r['taskId'], run=r['runName'], passed=r['pass'],
                seconds=m['durationMs'] / 1000,
                cadCalls=sum(v for k, v in m['toolCallsByName'].items() if k.startswith('cad_')),
                finalRevision=m.get('finalRevisionId'), evidence=m.get('verificationEvidenceHash'),
                failedChecks=[c for c in r['checks'] if not c['pass']],
                finalMessage=m['finalMessage']))
    campaigns[name] = dict(completed=len(runs), passed=sum(r['passed'] for r in runs),
        secondsP50=percentile([r['seconds'] for r in runs], .5),
        secondsP95=percentile([r['seconds'] for r in runs], .95),
        secondsMax=percentile([r['seconds'] for r in runs], 1), runs=runs)
write('agent-campaigns.json', campaigns)

workflows = [json.loads(p.read_text()) for p in sorted((base / 'workflow-qualified').glob('*/r*/result.json'))]
write('workflows.json', dict(completed=len(workflows), passed=sum(r['pass'] for r in workflows),
    scopeEscalations=sum(r['scopeEscalated'] for r in workflows),
    secondsP50=percentile([r['cost']['seconds'] for r in workflows], .5),
    secondsP95=percentile([r['cost']['seconds'] for r in workflows], .95),
    secondsMax=percentile([r['cost']['seconds'] for r in workflows], 1), runs=workflows))
for source, target in [
    ('revalidated-v4-final/results.json', 'checker-v4-revalidation.json'),
    ('command-latency.json', 'command-latency.json'),
    ('tests-release-final.log', 'automated-tests.txt'),
    ('smoke-release-candidate.log', 'packaged-smoke.txt'),
    ('dependency-audit.log', 'production-dependency-audit.txt'),
]:
    if (base / source).exists():
        shutil.copyfile(base / source, out / target)

files = ['packages/agent-host/src/adapters/guide.ts', 'packages/core/src/cad.ts',
    'packages/core/src/cad-verification.ts', 'packages/core/src/mesh.ts',
    'packages/contracts/src/ops.ts', 'evals/cad/harness.ts', 'evals/cad/tasks.ts',
    'evals/cad/holdout.ts', 'evals/workflows/run.ts']
write('final-source-hashes.json', dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    sha256={p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files}))
print(json.dumps({k: {n: v[n] for n in ['completed', 'passed', 'secondsP50', 'secondsP95', 'secondsMax']} for k, v in campaigns.items()}, indent=2))
