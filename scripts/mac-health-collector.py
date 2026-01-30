#!/usr/bin/env python3
"""
Mac Health Collector — System metrics for Claude Code skill.

Usage:
    python mac-health-collector.py          # Quick mode (no sudo)
    sudo python mac-health-collector.py --deep   # Deep mode (E/P cores, GPU)

Output: JSON to stdout
"""

import argparse
import json
import subprocess
import re
import os
from datetime import datetime
from typing import Any


def run_cmd(cmd: list[str], timeout: int = 10) -> tuple[str, bool]:
    """Run command, return (stdout, success)."""
    try:
        # Include homebrew paths for macOS
        env = os.environ.copy()
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "")

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env
        )
        return result.stdout, result.returncode == 0
    except subprocess.TimeoutExpired:
        return "", False
    except FileNotFoundError:
        return "", False


def collect_cpu_basic() -> dict[str, Any]:
    """Basic CPU usage from top."""
    output, ok = run_cmd(["top", "-l", "1", "-s", "0", "-n", "0"])
    if not ok:
        return {"error": "top command failed"}

    # Parse: CPU usage: 12.3% user, 5.1% sys, 82.6% idle
    match = re.search(
        r"CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys,\s*([\d.]+)%\s*idle",
        output
    )
    if match:
        user, sys, idle = map(float, match.groups())
        return {
            "user_percent": user,
            "system_percent": sys,
            "idle_percent": idle,
            "total_used_percent": round(user + sys, 1)
        }
    return {"error": "could not parse top output"}


def collect_cpu_deep() -> dict[str, Any]:
    """Detailed CPU from powermetrics (requires sudo)."""
    output, ok = run_cmd(
        ["sudo", "powermetrics", "--samplers", "cpu_power", "-n", "1", "-i", "1000"],
        timeout=15
    )
    if not ok:
        return {"error": "powermetrics failed (need sudo?)"}

    result = {}

    # E-cluster and P-cluster active residency
    # Format: "E-Cluster HW active residency: 100.00%"
    e_match = re.search(r"E-Cluster HW active residency:\s*([\d.]+)%", output)
    # P-clusters may be P0-Cluster, P1-Cluster, etc.
    p_matches = re.findall(r"P\d?-Cluster HW active residency:\s*([\d.]+)%", output)

    if e_match:
        result["e_cluster_active_percent"] = float(e_match.group(1))
    if p_matches:
        # Average all P-cluster residencies
        p_avg = sum(float(p) for p in p_matches) / len(p_matches)
        result["p_cluster_active_percent"] = round(p_avg, 2)
        result["p_cluster_count"] = len(p_matches)

    # CPU power
    cpu_power_match = re.search(r"CPU Power:\s*([\d.]+)\s*mW", output)
    if cpu_power_match:
        result["cpu_power_mw"] = float(cpu_power_match.group(1))

    # Package power
    pkg_match = re.search(r"Package Power:\s*([\d.]+)\s*mW", output)
    if pkg_match:
        result["package_power_mw"] = float(pkg_match.group(1))

    return result if result else {"error": "could not parse powermetrics output"}


def collect_gpu_deep() -> dict[str, Any]:
    """GPU metrics from powermetrics (requires sudo)."""
    output, ok = run_cmd(
        ["sudo", "powermetrics", "--samplers", "gpu_power", "-n", "1", "-i", "1000"],
        timeout=15
    )
    if not ok:
        return {"error": "powermetrics gpu failed"}

    result = {}

    # GPU active residency: "GPU HW active residency:   0.00%"
    gpu_match = re.search(r"GPU HW active residency:\s*([\d.]+)%", output)
    if gpu_match:
        result["active_percent"] = float(gpu_match.group(1))

    # GPU idle residency: "GPU idle residency: 100.00%"
    idle_match = re.search(r"GPU idle residency:\s*([\d.]+)%", output)
    if idle_match:
        result["idle_percent"] = float(idle_match.group(1))

    # GPU power: "GPU Power: 0 mW"
    gpu_power_match = re.search(r"GPU Power:\s*(\d+)\s*mW", output)
    if gpu_power_match:
        result["power_mw"] = int(gpu_power_match.group(1))

    # GPU frequency: "GPU HW active frequency: 0 MHz"
    freq_match = re.search(r"GPU HW active frequency:\s*(\d+)\s*MHz", output)
    if freq_match:
        result["frequency_mhz"] = int(freq_match.group(1))

    return result if result else {"error": "could not parse GPU metrics"}


def collect_memory() -> dict[str, Any]:
    """Memory usage from vm_stat and sysctl."""
    # Get total memory
    total_output, _ = run_cmd(["sysctl", "-n", "hw.memsize"])
    total_bytes = int(total_output.strip()) if total_output.strip().isdigit() else 0
    total_gb = round(total_bytes / (1024**3), 1)

    # Get vm_stat
    vm_output, ok = run_cmd(["vm_stat"])
    if not ok:
        return {"total_gb": total_gb, "error": "vm_stat failed"}

    # Parse page size and counts
    page_size = 16384  # Default for Apple Silicon
    ps_match = re.search(r"page size of (\d+) bytes", vm_output)
    if ps_match:
        page_size = int(ps_match.group(1))

    def get_pages(name: str) -> int:
        match = re.search(rf"{name}:\s*(\d+)", vm_output)
        return int(match.group(1)) if match else 0

    free = get_pages("Pages free")
    active = get_pages("Pages active")
    inactive = get_pages("Pages inactive")
    speculative = get_pages("Pages speculative")
    wired = get_pages("Pages wired down")
    compressed = get_pages("Pages occupied by compressor")

    used_pages = active + wired + compressed
    used_gb = round((used_pages * page_size) / (1024**3), 1)

    # Memory pressure
    pressure_output, _ = run_cmd(["memory_pressure"])
    pressure = "unknown"
    if "System-wide memory free percentage" in pressure_output:
        pct_match = re.search(r"(\d+)%", pressure_output)
        if pct_match:
            free_pct = int(pct_match.group(1))
            if free_pct > 25:
                pressure = "nominal"
            elif free_pct > 10:
                pressure = "warn"
            else:
                pressure = "critical"

    return {
        "used_gb": used_gb,
        "total_gb": total_gb,
        "used_percent": round((used_gb / total_gb) * 100, 1) if total_gb > 0 else 0,
        "pressure": pressure
    }


def collect_temperature() -> dict[str, Any]:
    """SSD temperature via smartctl (proxy for system temp)."""
    output, ok = run_cmd(["smartctl", "-a", "/dev/disk0"])
    # smartctl returns non-zero for warnings but still outputs data
    if not output or "Temperature" not in output:
        return {"error": "smartctl failed (brew install smartmontools?)"}

    temp_match = re.search(r"Temperature:\s*(\d+)\s*Celsius", output)
    if temp_match:
        temp = int(temp_match.group(1))
        status = "normal"
        if temp >= 70:
            status = "critical"
        elif temp >= 60:
            status = "warn"
        return {
            "ssd_celsius": temp,
            "status": status,
            "note": "SSD temperature (system proxy)"
        }
    return {"error": "could not parse temperature"}


def collect_disk_internal() -> dict[str, Any]:
    """Internal disk health and space."""
    result = {}

    # SMART health (smartctl returns non-zero for warnings but still outputs data)
    smart_output, _ = run_cmd(["smartctl", "-a", "/dev/disk0"])
    if smart_output and "SMART" in smart_output:
        # Health status
        health_match = re.search(r"SMART overall-health.*?:\s*(\w+)", smart_output)
        if health_match:
            result["health"] = health_match.group(1)

        # Percentage used (wear)
        wear_match = re.search(r"Percentage Used:\s*(\d+)%", smart_output)
        if wear_match:
            result["wear_percent"] = int(wear_match.group(1))

        # Data written
        written_match = re.search(r"Data Units Written:\s*([\d,]+)", smart_output)
        if written_match:
            units = int(written_match.group(1).replace(",", ""))
            tb_written = round(units * 512000 / (1024**4), 1)
            result["data_written_tb"] = tb_written

    # Disk space
    df_output, ok = run_cmd(["df", "-h", "/"])
    if ok:
        lines = df_output.strip().split("\n")
        if len(lines) >= 2:
            parts = lines[1].split()
            if len(parts) >= 5:
                result["size"] = parts[1]
                result["used"] = parts[2]
                result["available"] = parts[3]
                result["used_percent"] = parts[4]

    return result if result else {"error": "could not collect disk info"}


def collect_disk_external() -> list[dict[str, Any]]:
    """External disk detection and health."""
    disks = []

    # List external PHYSICAL disks only (excludes APFS containers/synthesized disks)
    output, ok = run_cmd(["diskutil", "list", "external", "physical"])
    if not ok or "No disks" in output or not output.strip():
        return []

    # Find disk identifiers (disk2, disk3, etc.) - only the /dev/diskN lines
    disk_ids = re.findall(r"^/dev/(disk\d+)", output, re.MULTILINE)

    for disk_id in disk_ids:
        disk_info = {"id": disk_id}

        # Get disk info
        info_output, _ = run_cmd(["diskutil", "info", f"/dev/{disk_id}"])

        name_match = re.search(r"Device / Media Name:\s*(.+)", info_output)
        if name_match:
            disk_info["name"] = name_match.group(1).strip()

        size_match = re.search(r"Disk Size:\s*([^\(]+)", info_output)
        if size_match:
            disk_info["size"] = size_match.group(1).strip()

        # Try SMART (may not work for all external drives)
        smart_output, _ = run_cmd(["smartctl", "-a", f"/dev/{disk_id}"])
        if smart_output and "SMART" in smart_output:
            health_match = re.search(r"SMART overall-health.*?:\s*(\w+)", smart_output)
            if health_match:
                disk_info["health"] = health_match.group(1)

            temp_match = re.search(r"Temperature:\s*(\d+)\s*Celsius", smart_output)
            if temp_match:
                disk_info["temperature_celsius"] = int(temp_match.group(1))

        disks.append(disk_info)

    return disks


def collect_docker() -> dict[str, Any]:
    """Docker container status."""
    # Check if docker is available
    _, ok = run_cmd(["docker", "info"], timeout=5)
    if not ok:
        return {"available": False, "note": "Docker not running or not installed"}

    # Get running containers
    output, ok = run_cmd(["docker", "ps", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"])
    if not ok:
        return {"available": True, "error": "docker ps failed"}

    containers = []
    for line in output.strip().split("\n"):
        if line:
            parts = line.split("\t")
            if len(parts) >= 3:
                containers.append({
                    "name": parts[0],
                    "status": parts[1],
                    "image": parts[2]
                })

    return {
        "available": True,
        "running_count": len(containers),
        "containers": containers
    }


def collect_top_processes(n: int = 5) -> list[dict[str, Any]]:
    """Top N CPU-consuming processes."""
    output, ok = run_cmd(["ps", "aux"])
    if not ok:
        return []

    lines = output.strip().split("\n")[1:]  # Skip header
    processes = []

    for line in lines:
        parts = line.split(None, 10)  # Split into max 11 parts
        if len(parts) >= 11:
            try:
                cpu = float(parts[2])
                mem = float(parts[3])
                command = parts[10].split("/")[-1][:30]  # Truncate command
                if cpu > 0.1:  # Only include if using some CPU
                    processes.append({
                        "command": command,
                        "cpu_percent": cpu,
                        "mem_percent": mem,
                        "pid": parts[1]
                    })
            except ValueError:
                continue

    # Sort by CPU and take top N
    processes.sort(key=lambda x: x["cpu_percent"], reverse=True)
    return processes[:n]


def format_table(result: dict[str, Any]) -> str:
    """Format results as human-readable table with commentary."""
    lines = []

    # Header
    status = result.get("status", "unknown").upper()
    status_icon = {"HEALTHY": "OK", "WARN": "!!", "CRITICAL": "XX"}.get(status, "??")
    lines.append(f"{'=' * 60}")
    lines.append(f"  MAC HEALTH REPORT  [{status_icon} {status}]")
    lines.append(f"  {result.get('timestamp', '')[:19]}  |  mode: {result.get('mode', 'quick')}")
    lines.append(f"{'=' * 60}")

    # Warnings at top if any
    warnings = result.get("warnings", [])
    if warnings:
        lines.append("")
        for w in warnings:
            lines.append(f"  !!  {w}")
        lines.append("")

    # CPU
    cpu = result.get("cpu", {})
    cpu_total = cpu.get("total_used_percent", 0)
    cpu_user = cpu.get("user_percent", 0)
    cpu_sys = cpu.get("system_percent", 0)

    lines.append("")
    lines.append("  CPU")
    lines.append(f"  {'-' * 56}")
    lines.append(f"  {'Usage':<20} {cpu_total:>6.1f}%  (user: {cpu_user:.0f}%, sys: {cpu_sys:.0f}%)")

    # Deep CPU metrics
    cpu_deep = result.get("cpu_detailed", {})
    if cpu_deep and "e_cluster_active_percent" in cpu_deep:
        e_pct = cpu_deep.get("e_cluster_active_percent", 0)
        p_pct = cpu_deep.get("p_cluster_active_percent", 0)
        power_w = cpu_deep.get("cpu_power_mw", 0) / 1000
        lines.append(f"  {'E-cores':<20} {e_pct:>6.1f}%")
        lines.append(f"  {'P-cores':<20} {p_pct:>6.1f}%")
        lines.append(f"  {'Power':<20} {power_w:>6.1f}W")

    # Commentary on high CPU
    if cpu_total > 90:
        top_proc = result.get("top_processes", [{}])[0]
        if top_proc:
            cmd = top_proc.get("command", "")[:25]
            pct = top_proc.get("cpu_percent", 0)
            lines.append(f"  {'Note':<20} High CPU from: {cmd} ({pct:.0f}%)")

    # GPU (if deep mode)
    gpu = result.get("gpu", {})
    if gpu and "active_percent" in gpu:
        lines.append("")
        lines.append("  GPU")
        lines.append(f"  {'-' * 56}")
        active = gpu.get("active_percent", 0)
        power_mw = gpu.get("power_mw", 0)
        freq = gpu.get("frequency_mhz", 0)
        state = "active" if active > 5 else "idle"
        lines.append(f"  {'Status':<20} {state} ({active:.1f}% active, {power_mw}mW, {freq}MHz)")

    # Memory
    mem = result.get("memory", {})
    lines.append("")
    lines.append("  MEMORY")
    lines.append(f"  {'-' * 56}")
    used = mem.get("used_gb", 0)
    total = mem.get("total_gb", 0)
    pct = mem.get("used_percent", 0)
    pressure = mem.get("pressure", "unknown")
    lines.append(f"  {'Used':<20} {used:.1f} GB / {total:.0f} GB ({pct:.0f}%)")
    lines.append(f"  {'Pressure':<20} {pressure}")

    # Temperature
    temp = result.get("temperature", {})
    lines.append("")
    lines.append("  TEMPERATURE")
    lines.append(f"  {'-' * 56}")
    if "ssd_celsius" in temp:
        t = temp["ssd_celsius"]
        status = temp.get("status", "unknown")
        lines.append(f"  {'SSD':<20} {t}C ({status})")
    else:
        lines.append(f"  {'SSD':<20} unavailable")

    # Disks
    disk_int = result.get("disk_internal", {})
    disk_ext = result.get("disk_external", [])

    lines.append("")
    lines.append("  STORAGE")
    lines.append(f"  {'-' * 56}")

    if disk_int:
        used_pct = disk_int.get("used_percent", "?")
        avail = disk_int.get("available", "?")
        health = disk_int.get("health", "?")
        wear = disk_int.get("wear_percent", "?")
        lines.append(f"  {'Internal SSD':<20} {used_pct} used, {avail} free")
        lines.append(f"  {'':<20} health: {health}, wear: {wear}%")

    if disk_ext:
        lines.append(f"  {'External':<20} {len(disk_ext)} drive(s):")
        for d in disk_ext:
            name = d.get("name", "unknown")[:20]
            size = d.get("size", "?")
            health = d.get("health", "")
            health_str = f" [{health}]" if health else ""
            lines.append(f"  {'  -':<20} {name} ({size}){health_str}")

    # Docker
    docker = result.get("docker", {})
    lines.append("")
    lines.append("  DOCKER")
    lines.append(f"  {'-' * 56}")

    if not docker.get("available"):
        lines.append(f"  {'Status':<20} not running")
    else:
        count = docker.get("running_count", 0)
        containers = docker.get("containers", [])
        healthy_count = sum(1 for c in containers if "healthy" in c.get("status", ""))

        if count == 0:
            lines.append(f"  {'Status':<20} running, no containers")
        else:
            health_note = f", {healthy_count}/{count} healthy" if healthy_count else ""
            lines.append(f"  {'Containers':<20} {count} running{health_note}")
            for c in containers[:5]:  # Max 5
                name = c.get("name", "?")[:25]
                st = "OK" if "healthy" in c.get("status", "") else "??"
                lines.append(f"  {'  -':<20} [{st}] {name}")

    # Top processes (brief)
    procs = result.get("top_processes", [])
    if procs and procs[0].get("cpu_percent", 0) > 10:
        lines.append("")
        lines.append("  TOP PROCESSES")
        lines.append(f"  {'-' * 56}")
        for p in procs[:3]:
            cmd = p.get("command", "?")[:30]
            cpu_p = p.get("cpu_percent", 0)
            lines.append(f"  {cmd:<30} {cpu_p:>7.1f}% CPU")

    lines.append("")
    lines.append(f"{'=' * 60}")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Collect Mac system health metrics")
    parser.add_argument("--deep", action="store_true", help="Include powermetrics data (requires sudo)")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    parser.add_argument("--table", action="store_true", help="Human-readable table output")
    args = parser.parse_args()

    result = {
        "timestamp": datetime.now().isoformat(),
        "mode": "deep" if args.deep else "quick",
        "cpu": collect_cpu_basic(),
        "memory": collect_memory(),
        "temperature": collect_temperature(),
        "disk_internal": collect_disk_internal(),
        "disk_external": collect_disk_external(),
        "docker": collect_docker(),
        "top_processes": collect_top_processes(5)
    }

    if args.deep:
        result["cpu_detailed"] = collect_cpu_deep()
        result["gpu"] = collect_gpu_deep()

    # Compute overall status
    warnings = []

    temp = result.get("temperature", {}).get("ssd_celsius", 0)
    if temp >= 70:
        warnings.append(f"CRITICAL: SSD temperature {temp}C")
    elif temp >= 60:
        warnings.append(f"WARN: SSD temperature {temp}C")

    mem_pressure = result.get("memory", {}).get("pressure", "")
    if mem_pressure == "critical":
        warnings.append("CRITICAL: Memory pressure critical")
    elif mem_pressure == "warn":
        warnings.append("WARN: Memory pressure elevated")

    disk_used = result.get("disk_internal", {}).get("used_percent", "0%")
    if disk_used:
        pct = int(disk_used.rstrip("%"))
        if pct >= 90:
            warnings.append(f"CRITICAL: Disk {pct}% full")
        elif pct >= 80:
            warnings.append(f"WARN: Disk {pct}% full")

    result["warnings"] = warnings
    result["status"] = "critical" if any("CRITICAL" in w for w in warnings) else \
                       "warn" if warnings else "healthy"

    if args.table:
        print(format_table(result))
    elif args.pretty:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
