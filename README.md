# pi-better-startup-message

A small Pi extension that replaces the long, line-wrapping startup resource block with a compact, one-item-per-line chat history message when `quietStartup` is enabled.

## Behavior

- If `quietStartup` is `true`, append a clean startup summary to chat history.
- If `quietStartup` is missing/false, do nothing so Pi's built-in startup listing is not duplicated.
- Lines are rendered one item per line and truncated to the terminal width instead of wrapping messily.

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

- `/better-startup` — append the clean startup summary to chat history for preview.
