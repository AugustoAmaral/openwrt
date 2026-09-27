# The trunk-bounce bug — raw measurements (2026-09-26, ~20:10–21:00 UTC)

Unedited transcription of the outputs read on the router (RAM-booted images), in the order they were measured.
This is the evidence behind the "Cause" section of [`trunk-bounce-fix.md`](trunk-bounce-fix.md) and the
hypotheses in [`trunk-bounce-investigation.md`](trunk-bounce-investigation.md). Context for the two images below
(neither is the final fix — see that document for why each was insufficient):

- **first-attempt build** (carrier-wait only in the glue): broken state captured after the harmless-bridge-change
  reload test, uptime ~3–10 min.
- **second-attempt build** (writes the ring base addresses back on reopen): broken state captured after the same
  test, uptime ~15 min.

dwmac1000 DMA register reference (offset → name): `0x1000` bus mode, `0x1004` TX poll demand, `0x1008` RX poll
demand, `0x100c` RX descriptor list address (Reg3), `0x1010` TX descriptor list address (Reg4), `0x1014` status
(Reg5; RS = bits 19:17, TS = bits 22:20), `0x1018` operation mode (Reg6; SR = bit 1, ST = bit 13), `0x101c`
interrupt enable (Reg7), `0x1028` AXI bus mode (Reg10), `0x1048` current host TX descriptor (Reg18), `0x104c`
current host RX descriptor (Reg19), `0x1050`/`0x1054` current TX/RX buffer (Reg20/21). GMAC0 (`eth0`) is at
`0x39c00000`, GMAC1 (`wan`) at `0x39d00000`.

## 1. First-attempt build, broken state — the glue waited for the link and broke anyway

```
[  182.230136] eth0: qca-dwmac: data plane released, bounce the interface to restore host DMA
[  182.517408] eth0: qca-dwmac-nss: phys_if 0 waits for link before the NSS fw data plane
[  184.631360] eth0: Link is Up - 1Gbps/Full - flow control rx/tx
[  184.632057] eth0: qca-dwmac: data plane claimed
[  184.642507] eth0: qca-dwmac-nss: phys_if 0 on NSS fw data plane
```

Router → bench host (temporary `192.168.31.1` on `br-lan` → `192.168.31.100`): 4 sent, 0 received. No
`DHCPDISCOVER` from the bench host (`xx:xx:xx:xx:xx:xx`) in `logread` after the reload. The bench host lost its
`192.168.1.x` DHCP lease.

### 1a. Counter diff over 6 s with the bench host sending ARP over the cable (`ethtool -S eth0` / `ethtool -S lan1`)

```
eth0.mmc_rx_65_to_127_octets_gb        9 ->       16  (+7)
eth0.mmc_rx_broadcastframe_g          11 ->       18  (+7)
eth0.mmc_rx_framecount_gb             17 ->       24  (+7)
eth0.mmc_rx_octetcount_g            3464 ->     3940  (+476)
eth0.mmc_rx_vlan_frames_gb            17 ->       24  (+7)
eth0.normal_irq_n                2111952 ->  2111958  (+6)
eth0.q0_rx_irq_n                  186911 ->   186917  (+6)
eth0.rx_normal_irq_n              186911 ->   186917  (+6)
eth0.s00_p04_Tx128Byte            217757 ->   217764  (+7)
eth0.s00_p04_TxBroad                  16 ->       23  (+7)
eth0.s00_p04_TxByte             21540156 -> 21540632  (+476)
lan1.Rx64Byte                          4 ->       12  (+8)
lan1.RxBroad                          16 ->       24  (+8)
lan1.RxGoodByte                 20667888 -> 20668400  (+512)
lan1.tx_bytes                    1193832 ->  1195872  (+2040)
lan1.tx_packets                     1363 ->     1382  (+19)
```

Reading: the switch port receives → the switch delivers to the CPU port (`s00_p04`) → the GMAC0 MAC receives
(`mmc_rx_*`) → the DMA completes and interrupts the **host driver** (`q0_rx_irq_n`). `mmc_tx_framecount_gb` stayed
at 0 the whole time (nothing went out), even though the glue's own `tx_redirect` counter kept increasing.

### 1b. DMA registers (`ethtool -d <dev>`, "DMA Registers" section)

```
== eth0
Reg0 0x01900880 Reg1 0x00000000 Reg2 0x00000000 Reg3 0x4567C000 Reg4 0x43DDC000 Reg5 0x00660004 Reg6 0x02202906
Reg7 0x0001A061 Reg8 0x00000000 Reg9 0x000000A0 Reg10 0x00110001 Reg11..17 0x00000000 Reg18 0x43DDC000 Reg19 0x4567C4C0
Reg20 0x00000000 Reg21 0x44B74040 Reg22 0x070D6E27
== wan
Reg0 0x01900880 Reg1 0x00000000 Reg2 0x00000000 Reg3 0x44C4E000 Reg4 0x44C01000 Reg5 0x00660004 Reg6 0x02202906
Reg7 0x0001A061 Reg8 0x00000000 Reg9 0x000000A0 Reg10 0x00110001 Reg11..17 0x00000000 Reg18 0x44C01BA0 Reg19 0x44C4E420
Reg20 0x4659217A Reg21 0x46D16082 Reg22 0x070D6E27
```

DMA configuration is identical on both ports; only the ring addresses differ. On `eth0` the TX pointer (Reg18) is
parked at the start of the ring and the current TX buffer (Reg20) is zero.

### 1c. Host `stmmac` driver rings (`/sys/kernel/debug/stmmaceth/<dev>/descriptors_status`)

```
== eth0
RX Queue 0:
0 [0x000000004567c000]: 0x4e0721 0x80000600 0x447d6040 0x0
1 [0x000000004567c020]: 0x15d0721 0x80000600 0x4507b040 0x0
511 [0x000000004567ffe0]: 0x80000000 0x80008600 0x4569a040 0x0
TX Queue 0:
0 [0x0000000043ddc000]: 0x0 0x0 0x0 0x0
1 [0x0000000043ddc020]: 0x0 0x0 0x0 0x0
511 [0x0000000043ddffe0]: 0x200000 0x0 0x0 0x0
== wan
RX Queue 0:
0 [0x00000000450f8000]: 0x80400320 0x80000600 0x472d4040 0x0
1 [0x00000000450f8020]: 0x81620321 0x80000600 0x44452040 0x0
511 [0x00000000450fbfe0]: 0x80000000 0x80008600 0x451a5040 0x0
TX Queue 0:
0 [0x0000000044f18000]: 0x0 0x0 0x455e6802 0x0
1 [0x0000000044f18020]: 0x0 0x0 0x42c93802 0x0
511 [0x0000000044f1bfe0]: 0x200000 0x0 0x0 0x0
```

On `eth0` the `stmmac` rings start at **exactly** the addresses in Reg3/Reg4. RX descriptors 0 and 1 have their
ownership bit cleared to 0 (filled in by the DMA: `0x4e0721` → a 78-byte frame) — this is the bench host's ARP
traffic landing in the ring nobody reads. On `wan` (healthy), the `stmmac` rings sit somewhere else entirely.

### 1d. Firmware rings (`/sys/kernel/debug/qca-nss-drv/meminfo/core0`)

```
1     gmac_tx_desc_0                   SDRAM   SDRAM   0x1000     0x44c00000
2     gmac_tx_desc_1                   UTCM_SHARED SDRAM   0x1000     0x44c01000
3     gmac_rx_desc_0                   SDRAM   SDRAM   0x1000     0x44c48000
4     gmac_rx_desc_1                   UTCM_SHARED SDRAM   0x1000     0x44c4e000
```

GMAC1 (`wan`, healthy): Reg3/Reg4 equal `gmac_rx_desc_1`/`gmac_tx_desc_1`. GMAC0 (`eth0`, broken): should have been
`0x44c48000`/`0x44c00000`. Each ring is `0x1000` bytes = 128 descriptors of 32 bytes (bus mode bit 7, ATDS,
enabled). These addresses move on every boot (the following boot produced `44309000`/`44308000` and
`4430f000`/`4430d000`).

## 2. Second-attempt build, broken state — base restored, indices out of step

Glue log: `fw DMA rings restored on phys_if 0 (rx 44309000 tx 44308000, host left rx 54a3c000 tx 54064000)`.
Status right after the reload test: `cur rx=44309020 tx=44308000`; the last known-good state before that test was
`cur rx=44309ba0 tx=44308a20`.

### 2a. Descriptor ownership map of each firmware ring, 128 descriptors (`ringdump.sh 0 44309000 44308000`, taken minutes later)

`D` = owned by the DMA (empty and waiting for data, or queued to be sent); `.` = owned by the firmware.

```
39c01000: 01900880 00000000 00000000 44309000 44308000 00660004 02202906 0001a061
39c01020: 00000000 000000a0 00110001 00000000 00000000 00000000 00000000 00000000
39c01040: 00000000 00000000 443081e0 44309b00 46ea617e 55444082 070d6e27
rx own: .......DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
44309000: 00590721 00000738 53e560c2 00000000 00000041 3f014858 00000000 00000000
44309020: 00590721 00000778 46d1f082 00000000 00000041 3f014890 00000000 00000000
44309fc0: 80000000 00000778 564a9082 00000000 00000042 3f010338 00000000 00000000
44309fe0: 80000000 00008778 53e51082 00000000 00000042 3f010a70 00000000 00000000
tx own: ................DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
44308000: 70000080 0000002e 554c743e 00000000 00000000 3f010fb0 00000000 00000000
44308020: 70000080 0000004e 554c7c32 00000000 00000000 3f010c68 00000000 00000000
44308fc0: f0000000 0000002e 554c76be 00000000 00000000 3f010760 00000000 00000000
44308fe0: f0200000 0000004a 46d9c17e 00000000 00000000 3f00f6f8 00000000 00000000
```

Reading:

- **RX:** the DMA restarted at 0 and filled descriptors 0–6 (`0x00590721` = an 89-byte frame, owned by the
  firmware, unread). The firmware was waiting at descriptor 7; from there on the two stayed in step (DMA up to
  descriptor 88 by this point). RX resynchronized on its own, losing 7 frames.
- **TX:** descriptors 0–15 were transmitted (`0x70000080`: owner 0, FS/LS/IC set, bit 7 = a VLAN-tagged frame);
  descriptors 16–127 are owned by the DMA (queued; descriptor 127 carries the end-of-ring bit, `0xf0200000`). The
  DMA is parked at descriptor 15 (Reg18 `443081e0`), which the firmware never fills because it believes the ring is
  full — it is waiting for descriptor 16 to complete first. Permanently deadlocked.

## 3. Hardware behavior tests with `gmacreg` (peek/poke), same broken state

Shell helpers on the router: `pk <addr> [words]` (read) and `po <addr> <value>` (write).

### 3a. Stop and restart TX without touching the address

```
== before: status, opmode, curtx
39c01014: 00660004
39c01018: 02202906
39c01048: 443081e0
== stop TX (clear ST bit13)
gmacreg: poke 39c01018 <- 02200906 (now 02200906)
39c01014: 00660004
39c01048: 443081e0
== start TX again, no base write
gmacreg: poke 39c01018 <- 02202906 (now 02202906)
39c01014: 00660004
39c01048: 443081e0
```

The TX state stayed `TS=6` (suspended) after clearing the ST bit; the pointer never moved.

### 3b. Write the TX address to descriptor 16 and restart

```
mmc_tx_framecount_gb: 268   mmc_rx_framecount_gb: 271   tx_redirect=2211 rx_fw=1247
gmacreg: poke 39c01018 <- 02200906 (now 02200906)
gmacreg: poke 39c01010 <- 44308200 (now 44308200)
gmacreg: poke 39c01018 <- 02202906 (now 02202906)
39c01010: 44308200   39c01048: 443081e0   39c01014: 00660004
gmacreg: poke 39c01010 <- 44308000 (now 44308000)
39c01010: 44308000   39c01048: 443081e0   39c01014: 00660004
mmc_tx_framecount_gb: 268   mmc_rx_framecount_gb: 274   tx_redirect=2219 rx_fw=1250
```

The register accepts the write, but without going through a "stopped" state the start does not reload the
pointer. A read request (`po 39c01004 1`) with ST off also did not move TX out of `TS=6`. **[Inference]:** the
active firmware re-enables the ST bit on its own; with the host owning the DMA (at claim time), stopping it
actually works — the second-attempt build's own T2 run proved that writing the base while stopped, then starting,
does reload the pointer from the base address.

### 3c. Does the DMA read the base address at the ring wrap? (RX running, in sync)

```
gmacreg: poke 39c0100c <- 44309400 (now 44309400)
39c0100c: 44309400   39c0104c: 44309600   mmc_rx_framecount_gb: 304
(bench host: 400 broadcast UDP datagrams from 192.168.31.100 to 192.168.31.255, 2 ms apart)
39c0100c: 44309400   39c0104c: 44309400   mmc_rx_framecount_gb: 704
rx own: DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD................................................................................................
```

After 400 frames the DMA wrapped to descriptor 32 (the address just written while it was running), skipping
descriptors 0–31. **Conclusion: a running DMA picks up the current value of the base-address register the next
time the ring wraps.** (This particular test broke RX on that RAM image; it was rebooted afterward.)

## 4. Conclusion that became the fix

1. A DMA start (stopped → running) loads its current-descriptor pointer from the base-address register.
2. While the DMA is running, writing the base-address register only changes where the *next* ring wrap lands.
3. The firmware continues its own indices from wherever it left off.

Therefore: on firmware close, read the current pointer (the resume point); on reopen, write the resume point,
let the firmware start the DMA, then write the real base address back. Design: [`trunk-bounce-fix.md`](trunk-bounce-fix.md).
