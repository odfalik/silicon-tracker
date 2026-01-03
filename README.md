# Apple Silicon Monitor

Live GPU, CPU, and power stats for Apple Silicon Macs in VS Code.

## Requirements

- macOS with Apple Silicon (M1/M2/M3/M4)
- Passwordless sudo access for `powermetrics` (see setup below)

## Setup

This extension uses `powermetrics` which requires sudo. To enable passwordless operation, run:

```bash
echo '%admin ALL=(ALL) NOPASSWD: /usr/bin/nice, /usr/bin/powermetrics' | sudo tee /etc/sudoers.d/powermetrics
```

## Features

- Real-time GPU usage and frequency
- CPU usage for E-cores and P-cores
- Power consumption (CPU, GPU, ANE, total package)
- Thermal pressure indicator

## Commands

- **Apple Silicon Monitor: Start Monitoring** - Start collecting metrics
- **Apple Silicon Monitor: Stop Monitoring** - Stop collecting metrics
- **Apple Silicon Monitor: Show Details** - Show detailed stats in output panel

## Settings

- `asitop.refreshInterval` - Refresh interval in milliseconds (default: 1000)
- `asitop.showGpu` - Show GPU usage in status bar
- `asitop.showCpu` - Show CPU usage in status bar
- `asitop.showPower` - Show power consumption in status bar
