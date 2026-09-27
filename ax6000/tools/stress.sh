#!/bin/sh
# on the router: N back-to-back bridge changes + network reload, $2 s apart (default 5 x 3 s), so some bounces land while the
# glue still waits for the link of the previous one; then settle and print the glue counters.
N=${1:-5}; GAP=${2:-3}
i=0
while [ $i -lt "$N" ]; do
  V=$(uci -q get network.@device[0].igmp_snooping); [ "$V" = 0 ] && V=1 || V=0
  uci set network.@device[0].igmp_snooping=$V; uci commit network; /etc/init.d/network reload
  i=$((i + 1)); echo "reload $i (igmp_snooping=$V) at $(cut -d' ' -f1 /proc/uptime)"; sleep "$GAP"
done
sleep 20
echo "released=$(dmesg | grep -c 'data plane released') waits=$(dmesg | grep -c 'waits for link') restores=$(dmesg | grep -c 'rings restored') noresume=$(dmesg | grep -c 'no resume point') notstarted=$(dmesg | grep -c 'DMA not started')"
grep -E 'phys_if|rings' /sys/kernel/debug/qca-dwmac-nss/status
