---
name: mac-health
description: |
  Mac system monitoring skill. Returns CPU, memory, temperature, disk, and Docker status.

  Trigger when:
  - "How's the Mac?" or "How's the server?"
  - "System status" or "Server status"
  - "Check server health" or "Mac health"
  - "What's eating CPU?" or "What's using memory?"
  - "Disk space?" or "Storage status?"
  - "Temperature?" or "Is the Mac hot?"
  - "Docker containers?" or "Are containers running?"
  - Any question about Mac hardware health or resource usage
---

> **Experimental Feature**
>
> This skill has been tested on Mac Mini M4 Pro. Other Mac models may require customization.
> If metrics aren't working, ask Claude to adjust the commands for your hardware.

# mac-health — System Monitoring Skill

Check Mac system health with a single command. Returns CPU, memory, temperature, disk, and Docker status.

---

## Triggers

Use this skill when user asks:
- "How's the Mac?"
- "System status" / "Server status"
- "Check server health"
- "What's eating CPU?"
- "Disk space?" / "Storage status?"
- "Temperature?"
- "Docker containers?"

---

## How to Use

### Quick Mode (default, ~2s)

```bash
python $WORKING_DIR/scripts/mac-health-collector.py --table
```

Collects: CPU %, RAM, memory pressure, SSD temperature, disk health/space, external disks, Docker containers, top processes.

### Deep Mode (~5s, includes E/P cores + GPU)

```bash
python $WORKING_DIR/scripts/mac-health-collector.py --deep --table
```

Adds: E-cluster/P-cluster residency, CPU power (mW), GPU utilization, GPU power.

**Note:** Deep mode uses `sudo powermetrics` internally. Requires passwordless sudo setup for `/usr/bin/powermetrics`.

### Output Formats

| Flag | Output |
|------|--------|
| `--table` | Human-readable table (recommended) |
| `--pretty` | Formatted JSON |
| (none) | Compact JSON |

---

## Interpreting Results

### Overall Status

| Status | Meaning |
|--------|---------|
| `healthy` | All metrics normal |
| `warn` | One or more warnings (see warnings array) |
| `critical` | Critical issue detected |

### Warning Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| SSD temperature | >=60C | >=70C |
| Disk usage | >=80% | >=90% |
| Memory pressure | "warn" | "critical" |

### Key Metrics Explained

**CPU (quick mode):**
- `total_used_percent` — Overall CPU usage (user + system)
- 100%+ is normal with VMs (Virtualization.framework uses multiple cores)

**CPU (deep mode):**
- `e_cluster_active_percent` — Efficiency cores usage
- `p_cluster_active_percent` — Performance cores usage
- `cpu_power_mw` — Total CPU power draw in milliwatts

**Memory:**
- `pressure` — macOS memory pressure: `nominal`, `warn`, `critical`
- More meaningful than raw usage percentage

**Temperature:**
- Uses SSD temperature as proxy (Apple restricts CPU temp on M-series)
- 40-55C = normal, 55-60C = warm, 60-70C = warning, 70+ = critical

**Disk:**
- `health` — SMART status: `PASSED` or `FAILED`
- `wear_percent` — SSD wear level (0% = new)
- `data_written_tb` — Lifetime data written

**Docker:**
- Lists running containers with status
- "healthy" in status means container health checks passing

---

## Presenting Results

After running the collector, **always add analysis**. Don't just dump the table.

### Structure

1. **Show the table output** (raw from collector)
2. **Add "Analysis" section** with:
   - Overall verdict (1 sentence)
   - Notable observations (what stands out)
   - Context for high values (explain WHY, not just WHAT)
   - Recommendations if any issues

### What to Comment On

| Metric | Comment when... |
|--------|-----------------|
| CPU >80% | Identify the culprit process, explain if expected (VM, ML workload) |
| CPU power >25W | Note it's running hot, check if sustained |
| E-cores maxed, P-cores idle | Efficiency mode, normal for background tasks |
| P-cores maxed | Heavy workload, check what's running |
| Memory >75% | Note if pressure is still nominal (macOS handles this well) |
| Memory pressure warn/critical | This is the real problem, not raw % |
| SSD >55C | Getting warm, note if under heavy I/O |
| SSD wear >5% | Starting to show age, estimate remaining life |
| Docker unhealthy | Flag which container(s), suggest checking logs |
| External disk missing | Compare to expected count if known |

### Example Analysis

```
**Analysis:**

System healthy. The 97% CPU is entirely from Virtualization.framework
running Colima — that's your Docker VM, expected behavior with ML
processing.

Memory at 80% but pressure is nominal — macOS is using RAM efficiently,
no swapping. SSD cool at 53C despite the workload.

All 4 containers healthy and running for 3 hours — stable deployment.

No action needed.
```

### Tone

- Direct, concise
- Explain the "why" behind numbers
- Don't alarm about expected behavior (VM CPU usage, high memory with nominal pressure)
- Flag actual concerns clearly

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `smartctl failed` | Install: `brew install smartmontools` |
| Deep mode errors | Check sudoers: `sudo visudo -f /etc/sudoers.d/powermetrics` |
| No temperature | Normal for external USB drives |
| Docker unavailable | Docker/Colima not running |

---

## Customization

This skill was developed on Mac Mini M4 Pro. If you're on different hardware:

1. **Temperature sensors** — Sensor names vary by model. Run `sudo powermetrics --samplers smc -n 1` to see available sensors on your machine.
2. **GPU metrics** — Not all Macs report GPU the same way.
3. **Docker** — Only relevant if you run Docker.

Ask Claude to adjust the script for your specific Mac model.

---

## Files

- Collector: `$WORKING_DIR/scripts/mac-health-collector.py`
- Skill: `.claude/skills/mac-health/SKILL.md`
