# Xiaomi AX6000 (IPQ5018) — branch `ax6000-2026-10`

This branch builds OpenWrt for one board only: the Xiaomi AX6000. It is
[kuncy7/openwrt-nss-edma](https://github.com/kuncy7/openwrt-nss-edma) plus these notes and one LuCI page of my own.
Maintained by Augusto Amaral.

## What this branch is

- **Base:** OpenWrt `main` (kernel 6.18) plus the IPQ5018 NSS layer from kuncy7's `openwrt-nss-edma`, branch
  `c3po-tag-8021q`. This branch (`ax6000-2026-10`) tracks that tree at commit `41998763c9` (2026-10-17; OpenWrt
  `main` merged up to `5df6ceb3d4`, 2026-10-16; kernel 6.18.55).
- **Feed:** `nss-packages` (kuncy7), branch `ipq50xx-rebase`, the companion feed for `c3po-tag-8021q`. Pin it to a
  commit before a release build. This branch's images use `e525310` (branch head on 2026-10-17) and NSS firmware
  12.5-210, the version kuncy7's release images carry since 2026-10-15.
- **Previous branch:** `ax6000` (kuncy7 `87cfd3190e`, kernel 6.18.52, firmware 12.2) is kept as an archive. kuncy7
  rewrote `c3po-tag-8021q` on 2026-10-10 (his backup: `c3po-tag-8021q-pre-sync-20261010`), so the old branch cannot
  be merged forward; this one was started fresh from his tree and the local commits were cherry-picked onto it.
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
| Cable → PPPoE, accelerated | ✅ on the previous branch | 711–729 Mbit/s over 15 runs (RAM and flash, two builds); see `docs/testing.md` |
| Wi-Fi, 2.4 GHz, NSS offload | ✅ on the previous branch | offload confirmed active (firmware `if_num` present, frames counted in `wifili`); throughput not isolated per band |
| Wi-Fi, 5 GHz, NSS offload | ✅ on the previous branch | offload confirmed active; one informal phone measurement: 578 Mbit/s down / 449 Mbit/s up |
| Trunk-bounce fix | ✅ upstream in kuncy7's tree since 2026-09-27 (PR #14) | see `docs/trunk-bounce-fix.md` and `docs/testing.md` |
| This branch (`ax6000-2026-10`) | ⏳ built, not yet booted | everything above has to be repeated on it before it goes to flash |
| Everything else | — | see `docs/testing.md` § Not tested for the full list (IPv6 offload, long-term stability, cable unplug/replug under firmware control, SQM, other boards, …) |

All measurements so far come from the previous branch (`ax6000`, image `r36760-f2c7091b27`, in flash since
2026-09-27 02:48 UTC).

**NAND ECC:** this unit has the ESMT F50D1G41LB SPI-NAND (64-byte OOB), which the vendor bootloader runs with 4-bit
ECC. Since 2026-09-27 (`88d3c30f18`, openwrt#24959) OpenWrt `main` forces 8-bit ECC in the AX6000 device tree, which
suits the GigaDevice variant (128-byte OOB) but not this one. kuncy7's tree removes the forced value and picks the
strength from the OOB size (`cf933e6b8f`, patch `0422`; it logs nothing about it). Do not flash this unit with a plain
OpenWrt `main` image built after 2026-09-27. On any new image, check `cat /sys/class/mtd/mtd0/ecc_strength` = 4 and
no new ECC/UBI read errors in dmesg before flashing.

## Local changes on top of kuncy7

- `ax6000/` — these notes, the trunk-bounce write-up, the test record and the bench tools.
- `package/utils/luci-app-cpu-live/` — Status → CPU Load draws per-core CPU usage and the NSS core load in the
  browser every 2 s, only while the page is open (reads `/sys/kernel/debug/qca-nss-drv/stats/cpu_load_ubi`). It
  lives in its own directory, so updates from kuncy7 do not touch it. Pairs with kuncy7's `luci-app-nss` (NSS box
  on the Status overview), which is enabled in the production seed alongside it.

The trunk-bounce fix (kernel patch `0958` + the glue changes in `qca-dwmac-nss`) used to be two local commits. kuncy7
merged them from [PR #14](https://github.com/kuncy7/openwrt-nss-edma/pull/14) on 2026-09-27 and carries them as
`00756268e0` and `2a6b213365`; his tree has kept evolving that glue since. They are no longer local.

## Updating from kuncy7

1. `git fetch kuncy7`. If `git merge-base --is-ancestor <tracked commit> kuncy7/c3po-tag-8021q` holds, merge:
   `git merge kuncy7/c3po-tag-8021q`. If it does not (he rewrote the branch again), start a new branch from his
   head and cherry-pick the local commits (`git log <old base>..<old branch>`), as was done for this branch.
2. Pin the `nss` feed to the commit of `ipq50xx-rebase` you build with and keep the firmware version in the seed
   (`CONFIG_NSS_FIRMWARE_VERSION_*`) equal to the one the feed defaults to, unless there is a reason not to.
   `qca-nss-drv` is built for one firmware line; mixing them zeroes the Wi-Fi counters.
3. Before flashing: boot the resulting initramfs from RAM (see below) and run, at minimum, the boot checks (NSS on
   both GMACs, 4-bit ECC, both radios up), PPPoE acceleration, and the bridge-reload test from `docs/testing.md`
   (T2 and the 5×1 s stress run). The trunk-bounce fix is kuncy7's code now, but this board is where it was found.

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
