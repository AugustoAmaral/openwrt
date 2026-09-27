#!/bin/sh
# on the router: DMA regs of GMAC$1 (0|1) and the own-bit map of the fw rings at $2 (rx) / $3 (tx), 128 x 32-byte descriptors
P=/sys/kernel/debug/gmacreg/peek
G=$([ "$1" = 1 ] && echo 39d0 || echo 39c0)
echo "${G}1000 23" > $P; cat $P
for r in "rx $2" "tx $3"; do
  set -- $r; : > /tmp/ring.$1
  for off in 0 2048; do printf '%x 512\n' $((0x$2 + off)) > $P; cat $P >> /tmp/ring.$1; done
  awk -v n=$1 '{d=substr($2,1,1); s=s ((d ~ /[89a-f]/) ? "D" : ".")} END{print n " own: " s}' /tmp/ring.$1
  sed -n '1p;2p;127p;128p' /tmp/ring.$1
done
