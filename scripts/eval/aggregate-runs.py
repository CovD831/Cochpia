#!/usr/bin/env python3
"""Aggregate N eval-run JSONs into a statistical baseline (mean + min/max)."""
import json
import sys
from pathlib import Path

RUNS_DIR = Path(__file__).resolve().parent.parent / '.rearchitecture-runs'
PREFIX = 'phase3a-run'
OUT = RUNS_DIR / 'phase3a-baseline.json'


def main() -> None:
    run_files = sorted(RUNS_DIR.glob(f'{PREFIX}*.json'))
    if len(run_files) < 2:
        print(f'need >=2 run files matching {PREFIX}*.json, found {len(run_files)}')
        sys.exit(1)
    runs = [json.load(open(f)) for f in run_files]
    metric_names = sorted({m for r in runs for m in r.get('metrics', {})})
    aggregate = {}
    for metric in metric_names:
        values = []
        for r in runs:
            raw = r.get('metrics', {}).get(metric, '')
            try:
                ok, total = raw.split('/')
                values.append((int(ok), int(total)))
            except ValueError:
                continue
        if not values:
            continue
        rates = [ok / total for ok, total in values]
        aggregate[metric] = {
            'mean': f'{sum(ok for ok, _ in values) / len(values):.2f}/{values[0][1]}',
            'rate_mean': round(sum(rates) / len(rates), 4),
            'rate_min': round(min(rates), 4),
            'rate_max': round(max(rates), 4),
            'per_run': [f'{ok}/{total}' for ok, total in values],
        }
    out = {
        'phase': '3a',
        'runs': len(runs),
        'caseVersion': runs[0].get('cases', {}).get('version'),
        'runFiles': [f.name for f in run_files],
        'failureCasesPerRun': [r.get('failedCases') for r in runs],
        'metrics': aggregate,
    }
    json.dump(out, open(OUT, 'w'), ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
