# Test record

Every test referenced here used commands run directly on the router shell, over a serial console or SSH. "RAM"
means the initramfs image was booted from RAM over U-Boot TFTP with the flash untouched (see
[`lab.md`](lab.md)); "flash" means the image had been written with `sysupgrade`. Throughput numbers are cable
(LAN) → PPPoE, unless stated otherwise, using either multiple parallel HTTP downloads or a local `iperf3` server
depending on the run.

Named tests referenced repeatedly below (all router-side, generic across any board running this glue):

- **T1** — apply a full production-style configuration (LAN bridge on the real switch ports, PPPoE WAN, Wi-Fi) to
  a config-less boot.
- **T2** — flip one harmless bridge option and reload networking, the minimal reproduction of the bug:
  `uci set network.@device[0].igmp_snooping=<0-or-1>; uci commit network; /etc/init.d/network reload`.
- **T3** — a LuCI-style "Save & Apply": apply a config change over `ubus` JSON-RPC with a `uci` rollback timer, then
  confirm it, exactly as LuCI's web UI does.
- **T4** — bounce the WAN interface (bring `wan` down, then up).
- **T5** — raise `lan1`'s MTU (to 1508, so the DSA conduit `eth0` carries 1512) and then lower it back (1500 /
  1504).
- **Stress `N`×`s`** — `tools/stress.sh N s` on the router: `N` back-to-back bridge-option flips + reload, `s`
  seconds apart, then a settle wait and the glue's dmesg/status counters.

## Symptom reproduction (pre-fix builds)

| Test | What it does | Where it ran | Result |
|---|---|---|---|
| 1A | Plain `/etc/init.d/network reload`, **no** pending config change | flash, production (pre-fix) | ✅ does not break: 0 new dmesg lines, nothing released, 0.7 ms ping |
| 1B | T2 (harmless bridge option + reload) | flash, production (pre-fix) | ❌ reproduced: 100% ping loss on the cable. The firmware-side node was recreated; the *old* node did not appear on a plain reload (1A), which is why 1A alone did not reproduce it |
| 1C | Release GMAC0 via the `fw_mask` debugfs knob, wait for link, re-arm it | flash, production (pre-fix) | ⚠️ invalid run: the bounce also took `lan1`-`lan3` admin-down and `netifd` never brought them back, so the test peer lost its own link — doesn't confirm or refute anything |
| RAM reproduction | 3 attempts on a RAM image, before any fix existed: reload with a config change; `ifup wan` with a LAN-affecting change; no LAN change at all | RAM, pre-fix build | 1st broke it; 2nd looked broken too, but the cable may still have been dead from the 1st (on later builds the same step never broke `eth0`); 3rd (no LAN change) was clean |
| RAM manual recovery | Without rebooting: release the port via `fw_mask`, bounce `eth0`/`lan1` down/up, re-arm | RAM, pre-fix build | Ping and DHCP came back, but accelerated flows through the cable stalled after ~30 KB; the firmware-side node was not recreated |

## Fix verification tests

| Test | What it does | Where it ran | Result |
|---|---|---|---|
| 2·T1 | T1 (apply full config) | RAM, first-attempt build (carrier-wait only) | ✅ clean, `eth0` did not drop |
| 2·T2 | T2 | RAM, first-attempt build | ❌ glue correctly waited for the link (182.5 s → claimed 184.6 s) and broke anyway — carrier-wait alone is not sufficient |
| 2·diag | Read DMA registers, host rings, firmware `meminfo`, MAC/DMA counters in the broken state | RAM, first-attempt build | Root cause identified: GMAC0's DMA was pointed at the host's own rings (see `trunk-bounce-measurements.md` §1) |
| 3·T2 | T2 | RAM, second-attempt build (writes ring base back) | ❌ ring base restored (`restores=1`), but DMA restarted at descriptor 0 while the firmware waited at 7/16 — TX deadlocked |
| 3·live | `gmacreg` bench tests on the broken state: descriptor ownership map; stop/restart the DMA; write the base address while running | RAM, second-attempt build | Established the hardware semantics behind the final fix (see `trunk-bounce-measurements.md` §3) |
| 4·T1 | T1 + a sustained accelerated download | RAM, final-fix build | ✅ `eth0` did not drop; 722.1 Mbit/s |
| 4·T2 | T2 | RAM, final-fix build | ✅ resumed correctly; TX had already wrapped its ring during the test; cable worked both directions; the peer's DHCP lease renewed; 726.0 Mbit/s afterward |
| 4·T2b | T2 again (a resume from a resume) | RAM, final-fix build | ✅ `restores=2`; 711.0 Mbit/s (a transient CPU spike, 27% user / 4% softirq, settled afterward) |
| 4·T3 | T3 (LuCI-style apply with a 60 s rollback, over the cable) | RAM, final-fix build | ✅ cable still alive 10 s later, confirmed over the cable itself; 726.4 Mbit/s |
| 4·T4 | T4 (WAN bounce) | RAM, final-fix build | ✅ waited for link, resumed, PPPoE came back with the same address; 723.1 Mbit/s |
| 4·T5 | T5 (MTU 1508 → 1500 on `lan1`) | RAM, final-fix build | ✅ port handed back before the change each time, resumed ~20 ms later, both directions; 721.3 Mbit/s |
| 4·S1 | Stress 5×3 s | RAM, final-fix build | ✅ 5 resumes, `noresume=0`, `notstarted=0`; 727.6 Mbit/s |
| 4·S2 | Stress 5×1 s (4 of the 5 reloads land while the port is still waiting for link from the previous one) | RAM, final-fix build | ✅ 1 release + 4 waits recorded; the resume point survived all 4 back-to-back drops; 724.6 Mbit/s |
| 4·end | dmesg review after a 24-minute session (12 `eth0` drops, 1 WAN drop) | RAM, final-fix build | ✅ no new warning (only boot-time `psci`/`ath10k`/IRQ lines); Wi-Fi clients (4 on 2.4 GHz, 1 on 5 GHz) unaffected throughout |
| 5·T2 | T2, on the flashed production image | flash, production (build tagged `r0+36757-1b39b3b3b6`) | ✅ resumed, cable both directions, peer's DHCP lease renewed; 724.8 Mbit/s |
| 5·revert | Remove the test bridge setting and reload again (config back to the original, 0 pending changes) | flash, production | ✅ same result; 727.4 Mbit/s (a transient 70%-busy CPU snapshot taken right after the load, then 98–99% idle over 3 follow-up 5 s samples) |

## Long-running / production checks

**Long RAM test with production config, 2026-09-26 18:30–19:13 UTC** (this is the run
that first discovered the bug — see "Symptom reproduction" above for the reload attempts made during it): 28
one-minute samples over the last 26 minutes of the window. 0 unresponsive samples; free memory 129–140 MB with no
downward trend; WAN ping (router → `1.1.1.1`) averaged 17.9 ms, max 18.4 ms; no new dmesg lines across the whole
window (464 lines, constant); WAN stayed up throughout; 4 Wi-Fi clients on 2.4 GHz, 1 on 5 GHz. Cable→PPPoE load
during the window: 721.3 Mbit/s (4 parallel download flows, 33 s), firmware packet counters +2.1 million, CPU 88%
idle.

**Production, post-flash (2026-09-26 22:01 UTC onward):** flash check confirmed the version string, the overlay
mount, the applied configuration, NSS state, and a clean dmesg. T2 run twice in production (see 5·T2 / 5·revert
above). No reboot needed for either.

## Throughput / offload measurements of the build

**RAM boot, kuncy7 `8c34ac51` base, 2026-09-26 18:00–18:08 UTC** (pre-fix, before the
production config or the bug were introduced): boot to console in ~11 s, no panic; `dsa` topology confirmed
(switch on `qca8k`, real `lan1`-`lan3` and `wan` ports, `tag_8021q`); NSS core booted with both GMACs handed to the
firmware (`fw_mask 0x3`), GMAC1's rings in SDRAM; PPPoE came up in seconds with a public IPv4 address and an IPv6
prefix delegation; **cable→PPPoE accelerated at 721.5 Mbit/s** sustained for 32 s (4 parallel download flows),
firmware packet counter 76 thousand → 2.1 million, CPU ~90% idle / ~7% softirq; Wi-Fi offload active on both
radios (firmware `if_num` 203 and 215), the 5 GHz radio's `wifili` TX-enqueue counter at 466 thousand with two
phones connected, zero drops; one informal phone-side speed test during the window: 578 Mbit/s down / 449 Mbit/s
up (a single report, not repeated, and not broken out by radio band); stock LuCI package, and its port-status page
worked natively for `lan1`-`lan3`/`wan` (speed and TX/RX counters), with no local patch.

## Not tested

- **Accelerated IPv6** through a port that has gone through the resume path. Only IPv4 traffic was measured in
  every trunk-bounce test above.
- **The 5 GHz → 2.4 GHz roaming bug**: a client that roams onto the 5 GHz radio sometimes fails to move back to
  2.4 GHz (the peer gets stuck in the 5 GHz radio's firmware). This is an open bug in kuncy7's tree, unrelated to
  the trunk-bounce fix; a documented workaround is `wifi down radio1; wifi up radio1`.
- **Long-term stability of the trunk-bounce fix in flash.** It has only been confirmed for the short window
  immediately after flashing (post-flash checks + two T2 runs); no multi-day soak test has been run against the
  flashed build.
- **The cable being unplugged and replugged while the firmware owns the port.** That path only touches
  `link_state`, not the DMA, so it is expected to be unaffected by both the original bug and the fix — but this
  has not been measured either way.
- **Updating this fork from kuncy7's tree.** The merge/rebase procedure in the top-level README has never been
  exercised end-to-end; the only rebase performed so far was preparing the two commits for the upstream PR.
- **SQM of any kind.** The image used for every test above has no `tc`/`sch_*`/`ifb` modules built in, and no
  NSS-accelerated SQM has been tried on `ipq50xx`.
- **Other boards.** Every test above ran on a single Xiaomi AX6000. The glue's port-to-netdev mapping supports
  boards with different GMAC numbering, but the trunk-bounce fix itself has not been tried on any board besides
  this one.
- **The current branch head, `87cfd3190e` plus the two fix commits.** Every number in this document comes from a
  build against kuncy7 `8c34ac51` plus pre-rebase versions of the same two commits. The rebase onto `87cfd3190e`
  applies cleanly, but that exact tree has not been built or booted.
- **The glue's fallback path when `fw_rings_known` is never set** — i.e. the firmware's very first open after boot
  failing. This falls back to the pre-fix behavior (with a dmesg warning) and was not deliberately exercised.
- **MTU above the TX FIFO size** (jumbo frames) — a known limit (see `trunk-bounce-fix.md`), not tested end to end.
- **The old error-recovery path** (`rings_set` failing on a reopen, falling back to a full interface bounce) —
  never observed in any test run, so its behavior on the `dsa` topology (which would also drop `lan1`-`lan3`) is
  understood from reading the code, not from a test.
