# The trunk-bounce bug — investigation

Design of the fix that came out of this: [`trunk-bounce-fix.md`](trunk-bounce-fix.md). Raw register/counter
evidence: [`trunk-bounce-measurements.md`](trunk-bounce-measurements.md). Full test record:
[`testing.md`](testing.md).

## Symptom reproduction

The bug was first noticed while applying a full production configuration to a freshly booted RAM image: the first
attempt (a plain `network reload` after loading the configuration) bounced `eth0` and killed wired traffic; a
second attempt without an explicit reload, but with a LAN-affecting change that made `ifup wan` re-read the
config, did the same; a third attempt that touched nothing on the LAN went through clean. See
`teste-longo-2026-09-26` in [`testing.md`](testing.md) for that run.

It was then isolated to a minimal reproduction: a *harmless* bridge option flip plus a reload —

```sh
V=$(uci -q get network.@device[0].igmp_snooping); [ "$V" = 0 ] && V=1 || V=0
uci set network.@device[0].igmp_snooping=$V
uci commit network
/etc/init.d/network reload
```

— reliably bounced the DSA conduit and broke wired traffic (100% ping loss on the cable both ways; the peer's DHCP
lease was never renewed). A plain `network reload` with **no** pending config change did **not** reproduce it: 0
new dmesg lines, nothing released. This distinction mattered for every hypothesis below.

## Method

All diagnosis happened on an initramfs image booted from RAM over U-Boot TFTP, with the flash untouched, so each
attempt could be rebuilt, reflashed to RAM, and retested without risking the production device. The broken `eth0`
(GMAC0, the LAN conduit) was compared against the healthy `wan` interface (GMAC1) on the same boot as a control:
same driver, same firmware, only one of the two had just been bounced.

Diagnostic surfaces used throughout: `ethtool -S` (MAC/DMA/switch counters, to trace where frames stopped),
`ethtool -d` (the DMA register block, including the descriptor list addresses), `/sys/kernel/debug/stmmaceth/*/descriptors_status`
(the host driver's own view of its rings), `/sys/kernel/debug/qca-nss-drv/meminfo/core0` (the firmware's declared
ring addresses), and — once available — a bench-only kernel module (`gmacreg`, see [`lab.md`](lab.md)) for direct
MMIO peek/poke and a descriptor-ownership map, since the stock image has no `devmem` and no `/dev/mem`.

## Hypotheses, in the order they were tried

1. **The glue arms the firmware before the link is up.** Implemented as a first attempt (wait for
   `NETDEV_CHANGE`/carrier before starting the firmware plane, matching kuncy7's own boot-time rule). Result: the
   glue correctly waited for the link (182.5 s → claimed 184.6 s, one millisecond after the reported link-up) and
   the cable broke anyway. **Refuted** as the root cause; kept in the final fix anyway because it is still a
   correct rule and closes a separate, real failure window (see `trunk-bounce-fix.md`).
2. **The RX filter is lost after the claim** (a caveat from kuncy7's own README). **Rejected** on the `dsa`
   topology specifically: `eth0` stays promiscuous the whole time (via the `tag_8021q` tagger), and the broken-state
   counters showed frames reaching the MAC and the DMA (`mmc_rx_*` counters and RX interrupts both increased) — the
   frames were arriving, just landing somewhere nobody read.
3. **A stale node in the `qca-dsa-nss` glue** left over from before the reload. **Rejected**: the node is recreated
   on every reload regardless of outcome, and once the DMA was pointed at the right rings, an accelerated download
   passed through the new node with no extra adjustment needed.
4. **Writing the ring base addresses back on reopen is enough.** Implemented as a second attempt. Result:
   confirmed wrong — the firmware continues its own descriptor indices from wherever it stopped (measured: index 7
   on RX, 16 on TX) while the DMA restarted at descriptor 0. RX resynchronized on its own after losing 7 frames;
   TX deadlocked for good, stuck one descriptor behind where the firmware was waiting.
5. **Resume the DMA from the exact descriptor it stopped at, not the ring base.** Implemented as the final design
   (patch `0958` + the corresponding glue rewrite). Passed every test in [`testing.md`](testing.md).

## Attempts that did not fix it, and why

- **First attempt — carrier-wait only.** Delays starting the firmware plane until `NETDEV_CHANGE` reports carrier.
  Correct and necessary as a defensive rule, but it does not touch the DMA ring state at all, so the bug reproduced
  identically once the link came back up.
- **Second attempt — ring-base restore, no resume point.** Adds code to write the firmware's own ring base
  addresses back into the list-address registers before the firmware reopens. This gets the DMA reading/writing
  the *correct memory region* again, but a DMA start always loads its current-descriptor pointer from the base
  address it was just given — so the DMA and the firmware started at different indices, and TX permanently
  deadlocked one descriptor short of where the firmware expected the next completion. This attempt is what proved
  the ring-base write alone was insufficient and pointed straight at "resume point, not base address" as the
  actual fix — see the hardware behavior tests in `trunk-bounce-measurements.md` §3, run with the `gmacreg` bench
  module, which confirmed a start always reloads from the base-address register, and a write to that register
  while the DMA is running only takes effect at the next ring wrap.

## Timeline (UTC, 2026-09-26)

| Time | What | Result |
|---|---|---|
| 19:58 | Resume investigation: reread prior notes, read the glue source in full | — |
| 19:59 | Check: is `eth0` promiscuous on the `dsa` topology? (flag `0x100`, promiscuity count 4) | Yes — rules out an RX address filter as the cause |
| 20:00 | First attempt built (carrier-wait only in the glue) | test build ready, ~6 min |
| 20:07 | Boot from RAM; apply production config | `eth0` did not drop on this run |
| 20:10 | Reload with the harmless bridge change | ❌ glue waited for the link and broke anyway — main hypothesis refuted |
| 20:10–20:20 | Diagnose the broken state: `ethtool -S` (trace the frame path), `ethtool -d` (DMA registers), stmmac `descriptors_status`, NSS `meminfo` | Root cause found: GMAC0's DMA pointed at the host's own rings |
| 20:26 | Second attempt built (kernel API v1 + glue that restores only the ring base; also hands the port back before an MTU change) | test build ready, ~14 min |
| 20:42 | Boot from RAM; apply production config plus load | 724.3 Mbit/s, clean |
| 20:46 | Reload with the harmless bridge change | ❌ ring base restored, but the DMA restarted at descriptor 0 while the firmware waited at 7/16 — TX deadlocked |
| 20:51 | `gmacreg` bench module built and loaded over the serial console; ring-ownership dump taken | Descriptor ownership map confirms the indices are out of step |
| ~20:55–21:00 | Hardware behavior tests with `gmacreg`: stop/restart TX without touching the address; write the TX base while TX is suspended; write the RX base while RX is running, then send 400 broadcast frames | A DMA start reloads from the base-address register; a write while running only takes effect at the ring wrap |
| 21:05 | Final kernel patch + glue rewritten (resume point captured on close, MAC gated during the reopen, `rings_wrap` after the firmware start) | test build ready, ~14 min |
| 21:20 | Boot from RAM; apply production config plus load | 722.1 Mbit/s, clean |
| 21:24 | Reload with the harmless bridge change | ✅ resumed correctly; wired both ways; the peer's DHCP lease renewed; 726.0 Mbit/s accelerated afterward |
| 21:27–21:37 | Resume-from-a-resume; LuCI-style apply with rollback; WAN bounce; MTU 1508/1500 on `lan1` | ✅ all four; 711.0 / 726.4 / 723.1 / 721.3 Mbit/s |
| 21:40–21:44 | Stress: 5 reloads 3 s apart, then 5 reloads 1 s apart; dmesg swept for new warnings; Wi-Fi checked | ✅ 727.6 / 724.6 Mbit/s; no new warning; Wi-Fi clients unaffected |
| 22:00 | Reboot from RAM back to the previous production build; configuration backed up | — |
| 22:01 | New image copied to the device; `sysupgrade -v` (keeping configuration) | "sysupgrade successful" |
| 22:07 | Post-flash check: version string, overlay mount, configuration, NSS state, dmesg, background collectors | All intact |
| 22:07–22:12 | Bridge-reload test repeated on the flashed production build; then the test config reverted and reloaded again | ✅ 724.8 and 727.4 Mbit/s |

Process notes (harness/tooling stumbles, not part of the technical investigation) are intentionally omitted here.
