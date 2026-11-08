# ThinkSmart browser flasher

A WebUSB installer for [LineageOS on the Lenovo ThinkSmart View CD-18781Y](https://github.com/salaman/tsv-lineage).

**Experimental.**

## Using the flasher

### Requirements

- Desktop Chrome or Edge, over HTTPS or localhost. Safari and Firefox do not
  support WebUSB.
- A USB connection to the ThinkSmart View, with other EDL tools closed.
- On Windows, install **WinUSB** for the EDL interface using
  [Zadig](https://zadig.akeo.ie/). Linux may require USB permissions and releasing
  the `qcserial` interface; on macOS, close any application using the device.
- Enough local disk space for backups and browser staging. Staging needs roughly
  2 GiB for core images or 6.2 GiB for a clean installation, plus a safety margin.

### Installation

1. **Image:** choose a build and continue. The newest build is selected by default.
2. **Connect & verify:** enter fresh EDL by powering off, holding both volume
   buttons, then powering on while holding them. Connect USB, select `QUSB__BULK`
   (`05c6:9008`), and let the installer verify hardware, storage and GPT.
3. **Backup:** choose what to save, then **Back up** to a folder. All six supported
   image partitions and GPT are selected by default. **Skip backup** is explicit.
4. **Flash:** review the partition choices, confirm the overwrite, and click
   **Flash device**. Selected images are downloaded, verified and prepared before
   any partition writes begin.
5. **Finish:** restart only after successful completion. You can save a local
   report; completion does not prove that Android will boot.

### Backup and image choices

Backups stream to disk and their saved files are independently hash-verified.
A backup set is complete only when `backup.json` says `complete`, and covers only
its listed partitions, not the entire device. Verified images already matching
the selected build are automatically unchecked for flashing; you can reselect them.

The optional GPT backup saves both tables and the protective MBR as
`gpt-primary.bin` and `gpt-secondary.bin`, with hashes and sector ranges in the
manifest. It can be saved on its own. **GPT restore requires native EDL tools**;
the browser cannot write GPT.

| Choice            | Effect                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| **Keep data**     | Leaves userdata, cache and metadata unchecked. Core images are selected initially.                         |
| **Clean install** | Selects userdata, cache and metadata wipes. Core-image choices remain unchanged.                           |
| **Flash lk2nd**   | On by default: writes the bundled boot image. Turn off to preserve the installed, validated first 512 KiB. |

Individual partition choices override the presets. Metadata is the stock **OEM**
partition, used for `/metadata` by this port. Initial installations need its ext4
wipe; wiping it while retaining userdata can make that data unusable. Never
restore another device's OEM backup. Recovery is outside the browser write policy.

"Expanding sparse image" prepares a disk-backed raw filesystem from a small wipe
download. Downloads and verification overlap with at most two preparation workers.

### Interruptions and recovery

**Stop is not rollback.** After writing starts, cancellation, unplugging or failure
can leave partial partitions. Do not reboot or blindly retry: save the report and
recover with native EDL tools and your backups. There is no automatic replay,
reconnect or resume. Re-enter fresh EDL after disconnecting; a programmer already
running in RAM is deliberately not reused.

Disconnect removes this session's staged images, not saved external backups.
Closing the tab may leave private browser staging behind. A browser-controlled
close/reload warning is requested while connected or busy, but cannot protect
against crashes, forced quits or power loss. Diagnostic reports include device
serial numbers; review them before sharing.

With LineageOS and lk2nd already installed, software re-entry is also available:

```sh
adb -s "<adb-serial>" reboot bootloader
fastboot -s "<fastboot-serial>" getvar lk2nd:version
fastboot -s "<fastboot-serial>" oem reboot-edl
```

Use the serial reported by each tool and confirm `05c6:9008` appears before
connecting. Chrome may require USB permission again after re-enumeration.

## Verification and trust

The installer checks Sahara hardware identity and the pinned programmer before
uploading it to RAM. It validates both GPT copies and restricts writes to selected
Android partitions at fixed stock locations. It has no arbitrary XML, erase,
patch or GPT-write interface.

Images are checked against the selected catalog's lengths and SHA-256 hashes,
including saved-file verification and sparse-wipe expansion. Streaming writes
require initial/final Firehose acknowledgements and a matching transmitted hash,
with bounded 1 MiB payloads. **There is no full device readback**: acknowledgements
do not independently prove persistent eMMC contents.

Catalog hashes provide integrity relative to that catalog, not an independent
publisher signature. Firmware and the programmer are hosted separately, not
bundled in this repository. Device/programmer pins live in
[`shared/profile.ts`](shared/profile.ts); catalog validation is in
[`shared/catalog.ts`](shared/catalog.ts).

## Build and development

Use Node.js 24 and pnpm (CI uses pnpm 12).

```sh
pnpm install
cp .env.example .env.local
# Set VITE_MANIFEST_URL in .env.local to a catalog you trust.
pnpm dev
```

Open `http://127.0.0.1:5173`. `VITE_MANIFEST_URL` is required; there is no default
catalog or dependency on a sibling repository. Its server must allow the local
origin through CORS. Production builds require an absolute HTTPS URL.

Firmware and release catalogs are not included in this repository or copied into
`dist/`. For optional loopback-only development with local files, configure
`.env.development.local`:

```text
VITE_MANIFEST_URL=/local-assets/manifest.json
LOCAL_ASSET_MANIFEST=/path/to/releases/manifest.json
LOCAL_ASSET_BASE_URL=https://firmware.example.org/manifest.json
LOCAL_ASSET_IMAGE_ROOT=/path/to/images
LOCAL_ASSET_PROGRAMMER=/path/to/programmer.bin
```

Image files live under `<LOCAL_ASSET_IMAGE_ROOT>/<build.id>/<fileName>`.
`LOCAL_ASSET_BASE_URL` is the hosted catalog URL used to validate its original
asset URLs before rewriting them for local serving. These paths are used only by
the development server, never builds or preview; see
[`dev/local-assets.ts`](dev/local-assets.ts).

```sh
pnpm format:check
pnpm lint
pnpm build
pnpm preview
```

`pnpm format` applies formatting. Preview runs at `http://127.0.0.1:4173` using
the hosted catalog configured **before building**; the build generates a matching
CSP. The catalog also needs CORS permission for the preview origin.

Publish updated catalogs and images separately from the UI. New builds using the
existing schema and device policy need no flasher release when the manifest URL
stays unchanged. Publishing tools, deployment infrastructure and actual release
data are managed outside this repository.

React subscribes to the session in [`src/edl/session.ts`](src/edl/session.ts).
USB, Sahara, Firehose, GPT, files and image validation are separate modules in
[`src/edl/`](src/edl/), loaded on demand by
[`DeviceWorkflow`](src/ui/DeviceWorkflow.tsx).

The flasher is [MIT licensed](LICENSE). Firmware and programmer redistribution
rights are separate from this source-code license.
