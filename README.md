# Silicon Tracker

Real-time GPU, CPU, and power monitoring for Apple Silicon Macs in VS Code.

## Features

- **Live Metrics Panel** - GPU usage, CPU usage (E-cores & P-cores), and power consumption
- **History Charts** - Configurable rolling window (10-120 seconds)
- **Status Bar** - Compact view showing GPU%, CPU%, Power, or all three
- **Dynamic Sample Rate** - Faster updates when panel is open, slower in background
- **Thermal Monitoring** - Color-coded thermal pressure indicator

## Requirements

- macOS with Apple Silicon (M1, M2, M3, etc.)
- Sudo access for `powermetrics`

## Setup

The extension uses macOS's `powermetrics` command which requires root access. On first run, you'll be prompted to set up passwordless sudo:

1. Open Terminal
2. Run: `sudo visudo`
3. Add this line at the end:
   ```
   %admin ALL=(ALL) NOPASSWD: /usr/bin/powermetrics
   ```
4. Save and restart VS Code

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `siliconTracker.sampleRate` | 1000 | Sample rate (ms) when panel is open |
| `siliconTracker.backgroundSampleRate` | 2000 | Sample rate (ms) when panel is closed |
| `siliconTracker.historyDuration` | 20 | History duration in seconds (10-120) |
| `siliconTracker.statusBarDisplay` | gpu | What to show: `gpu`, `cpu`, `power`, `all`, or `none` |

## Commands

- `Silicon Tracker: Start Monitoring` - Start the monitor
- `Silicon Tracker: Stop Monitoring` - Stop the monitor
- `Silicon Tracker: Open Monitor Panel` - Open the metrics panel
- `Silicon Tracker: Show Details (Text)` - Show detailed text output

## License

MIT
