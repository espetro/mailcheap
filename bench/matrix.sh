#!/usr/bin/env bash
# Full matrix: 4 scenarios x 3 targets x 2 concurrencies x 3 runs, 30 s each (about 45 min).
cd "$(dirname "$0")"
for s in F0 S1 S2 S3; do for t in next edge edge-null; do for c in 1 64; do for r in 1 2 3; do
	./run.sh $t $s $c $r
done; done; done; done
echo MATRIX-DONE
