# Bench setup and procedures

Generic bring-up/debug procedures used throughout this branch's testing. None of this is board-specific beyond the
GMAC base addresses noted below (IPQ5018: GMAC0 `0x39c00000`, GMAC1 `0x39d00000`, DMA block at `+0x1000`).

## Serial console

A USB-UART adapter (e.g. CP2102) on the board's UART header, 115200 8N1, usually enumerates as `/dev/ttyUSB0`. You
may need a udev rule or the `dialout` group to access it without root. Only one process can hold the serial port
at a time — running a background logger and a flashing/boot script against the same port at once will fail with a
serial-port-busy error.

Notes from this investigation, all confirmed on the AX6000's console:

- **The first `tftpboot` right after stopping U-Boot's autoboot tends to fail** — the switch has just reset.
  Retrying once or twice after a short pause works.
- **Long lines sent to the serial console can drop characters**, especially while dmesg is actively printing. If a
  command line loses a quote character, `ash` is left waiting for the closing quote (prompt changes to `> `) and
  silently swallows every subsequent line you send, including the next command. Recovery: send Ctrl-C (`\x03`)
  followed by Ctrl-U to clear the line. Prefer short commands, or write a script to a file first and run the file.
- **The stock busybox has no `base64`, `uudecode`, or `devmem`, and there is no `/dev/mem`.** To move a small
  binary (like the `gmacreg` module below) over a serial link with no working network path, base64-encode it in
  small chunks and decode on the router with `ucode`, e.g. `ucode -e 'print(b64dec(getenv("CHUNK")))' >> file`, in a
  loop over chunks. Reading/writing memory-mapped registers without `devmem` is why `gmacreg` exists.
- Bringing an interface down on the bench (including through the glue's `fw_mask` debugfs knob) can take the other
  switch ports down with it, cutting your own management link — plan the way back over the serial console before
  doing this.

## RAM boot (flash untouched)

1. Copy the initramfs image (`*-initramfs-uImage.itb`) to wherever your TFTP server serves it from.
2. Interrupt U-Boot's autoboot ("Hit any key to stop autoboot"), then:
   ```
   tftpboot 0x50000000 <image>.itb
   bootm 0x50000000
   ```
   (retry `tftpboot` once or twice if the first attempt fails — see the note above). U-Boot ignores
   `setenv bootargs`; only bootargs baked into the device tree take effect. An empty Enter repeats the last
   command — clear the line with Ctrl-U, not a bare carriage return, if you don't want that.
3. Wait roughly a minute for `nss-dwmac-up` (or whatever arms the ports on your image) to bring the NSS firmware
   up; confirm with `/sys/kernel/debug/qca-dwmac-nss/status` (see `trunk-bounce-fix.md`).
4. Apply whatever configuration the test needs (bridge layout, PPPoE, Wi-Fi).
5. A plain `reboot` on the router returns it to the previous production image on flash — nothing on flash was
   touched.

## Flashing, keeping configuration

Use this when the new image is built from the same base/stack as what's already on the device (this is how the
trunk-bounce fix itself was flashed — it only changed the kernel and one package).

1. Confirm you're booted from flash (reboot first if you were testing from RAM).
2. `sysupgrade -b /tmp/backup.tar.gz` on the router, then copy it off (the stock `dropbear` on these images often
   lacks `sftp-server`, so plain `scp` may not work — `ssh router 'cat /tmp/backup.tar.gz' > backup.tar.gz` does).
3. Copy the new `*-squashfs-sysupgrade.bin` onto the router; check its sha256sum on both sides.
4. Start logging the serial console in the background (the SSH session will drop during the flash).
5. `sysupgrade -v /tmp/<image>.bin` — the `-v` (or no `-n`) keeps `/overlay`, so configuration and SSH host keys
   survive.
6. After it comes back: check the version string, that `/overlay` is mounted, that the configuration matches, NSS
   status, dmesg for anything new, and any background monitoring you rely on. Then repeat the bridge-reload test
   from `testing.md` once more, on the flashed image.

Moving to a genuinely different base or NSS stack calls for `sysupgrade -n` instead (wipes `/overlay`, starts from
the new image's defaults), followed by reapplying configuration from scratch.

## Reading GMAC/DMA state without any extra module

- `ethtool -d <dev>` — the "DMA Registers" section: Reg3/Reg4 are the ring base addresses, Reg5 is the DMA status
  word, Reg18/Reg19 are the current descriptor pointers.
- `/sys/kernel/debug/stmmaceth/<dev>/descriptors_status` — the host driver's own view of its rings, with the
  address of every descriptor.
- `/sys/kernel/debug/qca-nss-drv/meminfo/core0` — the firmware's declared ring addresses
  (`gmac_{rx,tx}_desc_{0,1}`).
- `ethtool -S <dev>` — MAC-level counters (`mmc_*`), host driver interrupt counters, and, on the DSA conduit, the
  switch's own CPU-port counters (`s00_p04_*`).

## `gmacreg`: bench-only register/memory access

The stock image ships no `devmem` applet and has no `/dev/mem`, so writing to GMAC registers (or reading firmware
descriptor memory directly) needs a small out-of-tree kernel module. `tools/gmacreg/` in this repository is that
module: `/sys/kernel/debug/gmacreg/peek` reads GMAC MMIO or a DRAM range (`0x40000000`–`0x60000000`, read-only),
and `/sys/kernel/debug/gmacreg/poke` writes GMAC MMIO only. **It is bench-only and must never ship in a production
image** — it has no access control beyond debugfs' own file permissions, and unrestricted MMIO writes to a live
GMAC can hang the interface.

Build it against the exact kernel tree that produced the image under test — a mismatched vermagic will refuse to
load:

```sh
export STAGING_DIR=<tree>/staging_dir
TC=$(ls -d "$STAGING_DIR"/toolchain-*)/bin
B=$(mktemp -d)
cp tools/gmacreg/{gmacreg.c,Kbuild} "$B/"
make -C <tree>/build_dir/target-*/linux-qualcommax_ipq50xx/linux-<kernel-version> M="$B" ARCH=arm64 \
  CROSS_COMPILE="$TC"/aarch64-openwrt-linux-musl- modules
"$TC"/aarch64-openwrt-linux-musl-strip --strip-debug -o "$B"/gmacreg-s.ko "$B"/gmacreg.ko   # ~300 KB -> ~10 KB
```

Transfer `gmacreg-s.ko` to the router (over the serial console with the `ucode`/base64 method above, or `scp` if
the network path is up) and `insmod` it. On the router, two small shell functions make it usable interactively:

```sh
pk(){ echo "$1 ${2:-1}" > /sys/kernel/debug/gmacreg/peek; cat /sys/kernel/debug/gmacreg/peek; }
po(){ echo "$1 $2" > /sys/kernel/debug/gmacreg/poke; }
```

`tools/ringdump.sh <0|1> <rx-base> <tx-base>` uses the same `peek` interface to print the DMA registers of GMAC 0
or 1 and a per-descriptor ownership map (`D` = DMA-owned, `.` = firmware-owned) for both of its rings — this is how
the descriptor-index mismatch behind the trunk-bounce bug was confirmed (see
`trunk-bounce-measurements.md` §2a).
