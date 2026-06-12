# pi-better-startup-message

A small Pi extension that replaces the long, line-wrapping startup resource block with a compact, one-item-per-line header when `quietStartup` is enabled.

## Behavior

- If `quietStartup` is `true`, show a clean startup summary.
- If `quietStartup` is missing/false, do nothing so Pi's built-in startup listing is not duplicated.
- Lines are truncated to the terminal width instead of wrapping messily.

## Settings

```json
{
  "quietStartup": true,
  "packages": [
    "git:github.com/yippiez/pi-better-startup-message"
  ]
}
```

## Commands

- `/better-startup` — show/re-render the header for preview.
- `/better-startup:clear` — clear the custom header.
