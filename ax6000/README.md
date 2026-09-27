# Xiaomi AX6000 (IPQ5018) — branch `ax6000`

This branch builds OpenWrt for one board only: the Xiaomi AX6000. It adds nothing else on top of
[kuncy7/openwrt-nss-edma](https://github.com/kuncy7/openwrt-nss-edma) except a fix for a trunk-bounce bug that
otherwise leaves the wired ports dead after a network reload, plus these notes. Maintained by Augusto Amaral.

## What this branch is

- **Base:** OpenWrt `main` (kernel 6.18) plus the IPQ5018 NSS layer from kuncy7's `openwrt-nss-edma`, branch
  `c3po-tag-8021q`. This branch tracks that tree at commit `87cfd3190e`.
- **Feed:** `nss-packages` (kuncy7), branch `ipq50xx-rebase`, the companion feed for `c3po-tag-8021q`. Pin it to a
  commit before a release build (`feeds.conf.default`, `nss` line). The current production image uses `833aa0e9`,
  which was still the branch head on 2026-09-27.
- **Topology:** `dsa`. The QCA8337 switch keeps its normal `qca8k` DSA driver, so `lan1`–`lan3` are real DSA
  ports and LuCI's port-status page works unmodified; `wan` is the 2.5G PHY on the second GMAC, outside the switch.
  The `qca-8021q` tagger and a small glue module (`qca-dwmac-nss`) give the NSS firmware one interface per bridge
  (all `br-lan` ports share one VID towards the CPU), so wired traffic is still hardware-accelerated. This is
  different from the older `vlan-trunk` topology some ipq50xx boards still use.
- **LuCI:** stock, unmodified. No local JS patches, no local kernel module for port status.

**Why the kernel here is always a private build, and why official `kmod-*` packages don't install:** the NSS data
path needs changes *inside* the kernel, not just loadable modules: the patch that lets the NSS firmware take over
the `stmmac` driver's data path, the PPP patch the ECM connection tracker needs to accelerate PPPoE, the `nss@...`
device-tree node and its reserved memory, and the ath11k+NSS patches. So the kernel this branch produces is never
the official OpenWrt kernel, even when the version number matches (both are `6.18.52` today). `apk` checks
`kernel=<version>~<vermagic>` before installing a `kmod-*` package, and the vermagic differs because the kernel
config and patch set differ. Consequence: any kernel module this device needs (`kmod-tun` for a VPN client,
`kmod-sched-cake`/`kmod-ifb` for SQM, `kmod-wireguard`, …) has to be built in this tree, either baked into the
image or as your own package feed. User-space packages (adblock, a VPN client binary, LuCI apps that don't need a
matching kernel module) install from the official OpenWrt repository normally.

## Status on the AX6000

| Area | Status | Measured |
|---|---|---|
| Cable → PPPoE, accelerated | ✅ | 711–729 Mbit/s over 15 runs (RAM and flash, two builds); see `docs/testing.md` |
| Wi-Fi, 2.4 GHz, NSS offload | ✅ | offload confirmed active (firmware `if_num` present, frames counted in `wifili`); throughput not isolated per band |
| Wi-Fi, 5 GHz, NSS offload | ✅ | offload confirmed active; one informal phone measurement: 578 Mbit/s down / 449 Mbit/s up |
| Trunk-bounce fix (this branch's local change) | ✅ in flash since 2026-09-26 22:01 UTC; this branch's own image since 2026-09-27 02:48 UTC | see `docs/trunk-bounce-fix.md` and `docs/testing.md` |
| Everything else | — | see `docs/testing.md` § Not tested for the full list (IPv6 offload, long-term stability, cable unplug/replug under firmware control, updating this fork, SQM, other boards, …) |

The production image is built from this branch (`r36760-f2c7091b27`, 2026-09-27). It passed the whole regression
set from RAM (T1–T5 and both stress runs) and T2 again after flashing; see `docs/testing.md` § "Regression run on
this branch". The older numbers come from a build against kuncy7 `8c34ac51` plus pre-rebase versions of the same
two commits.

## Local changes on top of kuncy7

Two commits, both about the same bug: netifd rebuilding `br-lan` on a config reload (LuCI "Save & Apply" of a
bridge option, `/etc/init.d/network reload`) bounces the DSA conduit, and wired traffic used to stay dead until
reboot; a WAN bounce or an MTU change hit the same path. Full write-up in `docs/trunk-bounce-fix.md`.

- `6ba3118334` — `qualcommax: stmmac: let the NSS owner resume the firmware descriptor rings` (kernel patch
  `target/linux/qualcommax/patches-6.18/0958-net-stmmac-let-the-NSS-owner-restore-the-firmware-descriptor-rings.patch`
  + `target/linux/qualcommax/files/include/linux/soc/qcom/qca_dwmac.h`).
- `6dac1ad69c` — `qca-dwmac-nss: survive a trunk bounce after boot` (`package/kernel/qca-dwmac-nss/src/qca_dwmac_nss.c`).

These two commits are also submitted as a pull request to kuncy7/openwrt-nss-edma (branch `c3po-tag-8021q`):

PR: https://github.com/kuncy7/openwrt-nss-edma/pull/14

If kuncy7 takes an equivalent fix upstream, prefer his version and drop this one on the next merge.

## Keeping the changes when updating from kuncy7

1. `git fetch kuncy7 && git merge kuncy7/c3po-tag-8021q`.
2. Conflict points to check by hand:
   - `target/linux/qualcommax/patches-6.18/0956` and `0957` — `0958` applies right after `0957`, at the context
     line `EXPORT_SYMBOL(qca_dwmac_dp_rx_kick);`. If kuncy7 renumbers or rewrites either, redo the merge by hand.
   - `target/linux/qualcommax/files/include/linux/soc/qcom/qca_dwmac.h` — the owner API declarations.
   - `package/kernel/qca-dwmac-nss/src/qca_dwmac_nss.c` — specifically the netdev notifier, `port_start`,
     `port_unwind`, and the debugfs status function.
3. On a kernel bump (6.19+): re-check that `stmmac_stop_all_dma()`, `stmmac_mac_set()`,
   `priv->dma_conf.{rx,tx}_queue[0].dma_{rx,tx}_phy`, and the dwmac1000 registers used by patch `0958`
   (`0x100c`/`0x1010` list addresses, `0x1048`/`0x104c` current descriptors) are still valid — the patch reads and
   writes those directly.
4. Bump `PKG_RELEASE` in `package/kernel/qca-dwmac-nss/Makefile` on any change to the glue.
5. Before flashing any merge that touched the files above: boot the resulting initramfs from RAM (see below) and
   run the bridge-reload test from `docs/testing.md` (at minimum, T2 and the 5×1 s stress run). Do not skip this —
   it is the only test that reproduces the bug this fix addresses.

## Building

Follow kuncy7's own `README.ipq50xx.md` on the `c3po-tag-8021q` branch for the feed setup and the `.config`
baseline; this branch changes none of that. Two things specific to this fork:

- Any kernel module this device needs must be built **in this same tree**, against the exact kernel it produces
  (see "Why the kernel here is always a private build" above). A module built against a different tree/config,
  even the same kernel version, will not load (vermagic mismatch).
- This branch keeps no build seed, no `.config`, and no personal overlay files. Package selection, board config,
  and any first-boot provisioning are the maintainer's own and are applied outside this tree, not baked into the
  image.

## Testing before flashing

Boot the initramfs image from RAM over U-Boot TFTP (flash untouched); see `docs/lab.md` for the generic procedure.
Before flashing any change that touches the trunk-bounce fix, run at least the bridge-reload test
(`docs/testing.md`, test T2, plus the 1 s stress run) from that RAM boot.

## Flashing

- **Same NSS stack, config already on the device:** `sysupgrade -v <image>` without `-n` keeps `/overlay` (uci
  config, SSH host keys, etc.). This is how the trunk-bounce fix went to flash: the new image differed from the
  running one only in the kernel and the glue package.
- **Different base/stack (e.g. moving from another NSS build to this one):** `sysupgrade -n <image>` wipes
  `/overlay` and starts from the image's defaults; reapply configuration afterward.
- **Rollback:** keep the previous sysupgrade image around (on the TFTP server or the workstation). To roll back,
  boot that previous image from RAM first to confirm it still works, then `sysupgrade -v` (or `-n`, matching how
  it was originally flashed) it onto the device. Always have a serial console attached before flashing.

## Docs

- [`docs/trunk-bounce-fix.md`](docs/trunk-bounce-fix.md) — design of the fix: API, code flow, debugfs fields,
  dmesg messages, debugging guide, maintenance notes, known limits.
- [`docs/trunk-bounce-investigation.md`](docs/trunk-bounce-investigation.md) — how the bug was found, every
  hypothesis tried and why it was rejected, the attempts that didn't work, and a timeline.
- [`docs/trunk-bounce-measurements.md`](docs/trunk-bounce-measurements.md) — the raw register/counter evidence
  behind the root cause.
- [`docs/testing.md`](docs/testing.md) — every test run, what it does, where it ran, and its result; plus what was
  never tested.
- [`docs/lab.md`](docs/lab.md) — bench setup and procedures: serial console, RAM boot, reading/poking DMA
  registers without a stock tool, the `gmacreg` bench module.

## Tools

`tools/` holds the bench scripts referenced by the docs above, copied verbatim from the investigation:

- `tools/stress.sh` — run on the router: N back-to-back bridge-config reloads, then print the glue's counters.
- `tools/ringdump.sh` — run on the router (needs `gmacreg` loaded): DMA registers plus the descriptor-ownership
  map of a GMAC's firmware rings.
- `tools/gmacreg/` — bench-only kernel module (`gmacreg.c` + `Kbuild`) exposing GMAC MMIO peek/poke and read-only
  DRAM peek through debugfs, for boards whose busybox has no `devmem`/`/dev/mem`. Never ships in a production
  image; build it against the exact kernel tree that produced the image under test (see `docs/lab.md`).
