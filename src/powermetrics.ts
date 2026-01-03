import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as plist from 'plist';

export interface GpuMetrics {
    freqMHz: number;
    activePercent: number;
}

export interface CpuMetrics {
    eClusterActive: number;
    eClusterFreqMHz: number;
    pClusterActive: number;
    pClusterFreqMHz: number;
    cpuPowerW: number;
    gpuPowerW: number;
    anePowerW: number;
    packagePowerW: number;
}

export interface Metrics {
    gpu: GpuMetrics;
    cpu: CpuMetrics;
    thermalPressure: string;
    timestamp: Date;
}

export type ErrorCallback = (error: { type: 'sudo' | 'general'; message: string }) => void;

export class PowerMetricsCollector {
    private process: child_process.ChildProcess | null = null;
    private outputPath: string;
    private timecode: string;
    private intervalMs: number;
    private onMetrics: ((metrics: Metrics) => void) | null = null;
    private onError: ErrorCallback | null = null;
    private pollInterval: NodeJS.Timeout | null = null;
    private lastTimestamp: Date | null = null;
    private log: (msg: string) => void;
    private startupTimeout: NodeJS.Timeout | null = null;
    private hasReceivedData: boolean = false;

    constructor(intervalMs: number = 1000, logger?: (msg: string) => void) {
        this.intervalMs = intervalMs;
        this.timecode = Date.now().toString();
        this.outputPath = path.join('/tmp', `silicon_tracker_${this.timecode}`);
        this.log = logger || console.log;
    }

    async start(onMetrics: (metrics: Metrics) => void, onError?: ErrorCallback): Promise<void> {
        this.onMetrics = onMetrics;
        this.onError = onError || null;
        this.hasReceivedData = false;

        // Clean up any existing temp files
        this.cleanup();

        // Start powermetrics process
        const command = 'sudo';
        const args = [
            'nice', '-n', '10',
            'powermetrics',
            '--samplers', 'cpu_power,gpu_power,thermal',
            '-o', this.outputPath,
            '-f', 'plist',
            '-i', this.intervalMs.toString()
        ];

        this.log(`Starting powermetrics with command: ${command} ${args.join(' ')}`);
        this.log(`Output path: ${this.outputPath}`);

        this.process = child_process.spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stderrBuffer = '';

        this.process.on('error', (err) => {
            this.log(`Failed to start powermetrics: ${err}`);
            this.onError?.({ type: 'general', message: err.message });
        });

        this.process.on('exit', (code, signal) => {
            this.log(`powermetrics exited with code: ${code}, signal: ${signal}`);

            // If we haven't received data and process exited, likely a sudo issue
            if (!this.hasReceivedData && code !== 0) {
                if (stderrBuffer.includes('password') || stderrBuffer.includes('sudo') || code === 1) {
                    this.onError?.({
                        type: 'sudo',
                        message: 'powermetrics requires sudo access'
                    });
                } else {
                    this.onError?.({
                        type: 'general',
                        message: `powermetrics failed with code ${code}`
                    });
                }
            }
        });

        this.process.stdout?.on('data', (data) => {
            this.log(`powermetrics stdout: ${data.toString()}`);
        });

        this.process.stderr?.on('data', (data) => {
            const text = data.toString();
            stderrBuffer += text;
            this.log(`powermetrics stderr: ${text}`);

            // Check for common sudo failure messages
            if (text.includes('password') || text.includes('Password:') ||
                text.includes('sudo:') || text.includes('Sorry')) {
                this.onError?.({ type: 'sudo', message: text });
            }
        });

        // Set a timeout to check if we got data
        this.startupTimeout = setTimeout(() => {
            if (!this.hasReceivedData) {
                this.log('No data received after startup timeout - possible sudo issue');
                this.onError?.({
                    type: 'sudo',
                    message: 'No data received - powermetrics may require sudo access'
                });
            }
        }, 5000);

        // Start polling for data
        this.pollInterval = setInterval(() => {
            this.readMetrics();
        }, this.intervalMs);
    }

    private readMetrics(): void {
        if (!fs.existsSync(this.outputPath)) {
            this.log(`Output file does not exist yet: ${this.outputPath}`);
            return;
        }

        try {
            const data = fs.readFileSync(this.outputPath);
            // powermetrics writes null-separated plist entries
            const parts = data.toString('binary').split('\0').filter(p => p.trim());

            if (parts.length === 0) {
                return;
            }

            // Clear startup timeout once we receive data
            if (!this.hasReceivedData) {
                this.hasReceivedData = true;
                if (this.startupTimeout) {
                    clearTimeout(this.startupTimeout);
                    this.startupTimeout = null;
                }
            }

            // Parse the last complete plist entry
            const lastPlist = parts[parts.length - 1];
            const parsed = plist.parse(lastPlist) as Record<string, unknown>;

            const timestamp = new Date(parsed['timestamp'] as string);

            // Skip if we already processed this timestamp
            if (this.lastTimestamp && timestamp.getTime() === this.lastTimestamp.getTime()) {
                return;
            }
            this.lastTimestamp = timestamp;

            const metrics = this.parseMetrics(parsed);
            if (this.onMetrics && metrics) {
                this.onMetrics(metrics);
            }
        } catch (err) {
            // File may be in the middle of being written
            this.log(`Error reading powermetrics: ${err}`);
        }
    }

    private parseMetrics(data: Record<string, unknown>): Metrics | null {
        try {
            const processor = data['processor'] as Record<string, unknown>;
            const gpu = data['gpu'] as Record<string, unknown>;
            const thermalPressure = data['thermal_pressure'] as string;
            const timestamp = new Date(data['timestamp'] as string);

            // Parse GPU metrics
            const gpuMetrics: GpuMetrics = {
                freqMHz: Math.round((gpu['freq_hz'] as number) / 1e6),
                activePercent: Math.round((1 - (gpu['idle_ratio'] as number)) * 100)
            };

            // Parse CPU metrics
            const clusters = processor['clusters'] as Array<Record<string, unknown>>;
            let eClusterActive = 0;
            let eClusterFreq = 0;
            let pClusterActive = 0;
            let pClusterFreq = 0;
            let eCount = 0;
            let pCount = 0;

            for (const cluster of clusters) {
                const name = cluster['name'] as string;
                const active = Math.round((1 - (cluster['idle_ratio'] as number)) * 100);
                const freq = Math.round((cluster['freq_hz'] as number) / 1e6);

                if (name.startsWith('E')) {
                    eClusterActive += active;
                    eClusterFreq = Math.max(eClusterFreq, freq);
                    eCount++;
                } else if (name.startsWith('P')) {
                    pClusterActive += active;
                    pClusterFreq = Math.max(pClusterFreq, freq);
                    pCount++;
                }
            }

            if (eCount > 0) {
                eClusterActive = Math.round(eClusterActive / eCount);
            }
            if (pCount > 0) {
                pClusterActive = Math.round(pClusterActive / pCount);
            }

            const cpuMetrics: CpuMetrics = {
                eClusterActive,
                eClusterFreqMHz: eClusterFreq,
                pClusterActive,
                pClusterFreqMHz: pClusterFreq,
                cpuPowerW: (processor['cpu_energy'] as number) / 1000,
                gpuPowerW: (processor['gpu_energy'] as number) / 1000,
                anePowerW: (processor['ane_energy'] as number) / 1000,
                packagePowerW: (processor['combined_power'] as number) / 1000
            };

            return {
                gpu: gpuMetrics,
                cpu: cpuMetrics,
                thermalPressure,
                timestamp
            };
        } catch (err) {
            this.log(`Error parsing metrics: ${err}`);
            return null;
        }
    }

    setSampleRate(newIntervalMs: number): void {
        if (newIntervalMs === this.intervalMs) return;

        this.intervalMs = newIntervalMs;
        this.log(`Changing sample rate to ${newIntervalMs}ms`);

        // Update polling interval
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = setInterval(() => {
                this.readMetrics();
            }, this.intervalMs);
        }

        // Note: powermetrics process continues at original rate
        // but we poll at the new rate (effectively downsampling when slower)
    }

    stop(): void {
        if (this.startupTimeout) {
            clearTimeout(this.startupTimeout);
            this.startupTimeout = null;
        }

        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }

        if (this.process) {
            // Kill the sudo powermetrics process
            try {
                child_process.execSync(`sudo pkill -f "powermetrics.*silicon_tracker"`);
            } catch {
                // Process may already be dead
            }
            this.process.kill();
            this.process = null;
        }

        this.cleanup();
    }

    private cleanup(): void {
        // Clean up temp files
        try {
            const files = fs.readdirSync('/tmp').filter(f =>
                f.startsWith('silicon_tracker_') || f.startsWith('asitop_vscode_')
            );
            for (const file of files) {
                fs.unlinkSync(path.join('/tmp', file));
            }
        } catch {
            // Ignore cleanup errors
        }
    }
}
