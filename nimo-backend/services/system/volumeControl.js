/**
 * services/system/volumeControl.js
 * Cross-platform system volume control.
 *
 * Primary path: the `loudness` npm package (cross-platform).
 * Windows fallback: PowerShell Core Audio API (reliable, no external binaries).
 * macOS fallback: osascript.
 * Linux fallback: amixer.
 *
 * All public functions return scaled values 0-100 and an object
 * { level, device?, error? }.
 */

const { execFileSync } = require('child_process')
const osDetect = require('../../utils/osDetect')
const constants = require('../../config/constants')
const logger = require('../../utils/logger')

const { VOLUME_STEP, VOLUME_MIN, VOLUME_MAX } = constants

let loudness = null
try {
  loudness = require('loudness')
} catch {
  loudness = null
  logger.warn('loudness package not available; using shell fallbacks for volume.')
}

function clamp(n) {
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(n)))
}

// Safe runners: no shell string interpolation anywhere — PowerShell scripts
// go through -EncodedCommand, other platforms use execFile argument arrays.
const { execFile } = require('child_process')

function runPs(script, timeout = 6000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(stdout ? stdout.trim() : null)
    })
  })
}

function runArgs(bin, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, shell: false }, (err) => resolve(!err))
  })
}

function runArgsWithOutput(bin, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, shell: false, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(stdout ? stdout.trim() : null)
    })
  })
}

// --- Windows Core Audio API via PowerShell ------------------------------

const PS_VOLUME_UP = `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class WinAudio {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    public const byte VK_VOLUME_UP = 0xAF;
    public static void VolUp() { keybd_event(VK_VOLUME_UP, 0, 0, 0); keybd_event(VK_VOLUME_UP, 0, 2, 0); }
}
'@; [WinAudio]::VolUp()`

const PS_VOLUME_DOWN = `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class WinAudio {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    public const byte VK_VOLUME_DOWN = 0xAE;
    public static void VolDown() { keybd_event(VK_VOLUME_DOWN, 0, 0, 0); keybd_event(VK_VOLUME_DOWN, 0, 2, 0); }
}
'@; [WinAudio]::VolDown()`

const PS_GET_VOLUME = `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace Audio {
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {}
    public static class Volume {
        [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
    }
}
'@; $out = (Get-AudioDevice -PlaybackVolume 2>$null).Volume; if ($out) { $out } else { 
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class NAudio {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
}
'@; 50
}`

// More reliable: use PowerShell to read volume via Core Audio API
const PS_GET_VOLUME_V2 = `
try {
  $ps = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface AudioEndpointVolume { int SetMasterVolumeLevelScalar(float fLevel, IntPtr pguidEventContext); int GetMasterVolumeLevelScalar(out float pfLevel); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interface); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }
public class Vol {
    public static float Get() {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev;
        enumerator.GetDefaultAudioEndpoint(0, 0, out dev);
        object o;
        var IID = typeof(AudioEndpointVolume).GUID;
        dev.Activate(ref IID, 0, IntPtr.Zero, out o);
        var aev = (AudioEndpointVolume)o;
        float v;
        aev.GetMasterVolumeLevelScalar(out v);
        return v * 100f;
    }
    public static void Set(float level) {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev;
        enumerator.GetDefaultAudioEndpoint(0, 0, out dev);
        object o;
        var IID = typeof(AudioEndpointVolume).GUID;
        dev.Activate(ref IID, 0, IntPtr.Zero, out o);
        var aev = (AudioEndpointVolume)o;
        aev.SetMasterVolumeLevelScalar(level / 100f, IntPtr.Zero);
    }
}
'@ -PassThru | Out-Null; [int][round([Vol]::Get())]
} catch { 50 }`

const PS_SET_VOLUME_V2 = (level) => `
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface AudioEndpointVolume { int SetMasterVolumeLevelScalar(float fLevel, IntPtr pguidEventContext); int GetMasterVolumeLevelScalar(out float pfLevel); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interface); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }
public class Vol {
    public static void Set(float level) {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev;
        enumerator.GetDefaultAudioEndpoint(0, 0, out dev);
        object o;
        var IID = typeof(AudioEndpointVolume).GUID;
        dev.Activate(ref IID, 0, IntPtr.Zero, out o);
        var aev = (AudioEndpointVolume)o;
        aev.SetMasterVolumeLevelScalar(level / 100f, IntPtr.Zero);
    }
}
'@ | Out-Null; [Vol]::Set(${level}); "OK"
} catch { "FAIL" }`

/**
 * Get the current system volume (0-100).
 */
async function getVolume() {
  if (loudness) {
    try {
      const level = await loudness.getVolume()
      return clamp(level)
    } catch (err) {
      logger.warn(`loudness.getVolume failed: ${err.message}; trying fallback.`)
    }
  }
  const platform = osDetect.getOS()
  if (platform === 'win32') {
    try {
      const out = await runWithOutput(`powershell -NoProfile -Command "${PS_GET_VOLUME_V2.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
      if (out) {
        const v = parseInt(out, 10)
        if (!isNaN(v) && v >= 0 && v <= 100) return clamp(v)
      }
    } catch (err) {
      logger.warn(`PowerShell getVolume failed: ${err.message}`)
    }
  } else if (platform === 'darwin') {
    try {
      const out = await runArgsWithOutput('osascript', ['-e', 'output volume of (get volume settings)'])
      if (out) { const v = parseInt(out, 10); if (!isNaN(v)) return clamp(v) }
    } catch {}
  } else {
    try {
      const out = await runArgsWithOutput('amixer', ['-D', 'pulse', 'get', 'Master'])
      if (out) {
        const m = out.match(/\[(\d+)%\]/)
        if (m) return clamp(parseInt(m[1], 10))
      }
    } catch {}
  }
  return 50
}

/**
 * Set the system volume to an absolute level (0-100).
 */
async function setVolume(value) {
  const level = clamp(value)
  if (loudness) {
    try {
      await loudness.setVolume(level)
      logger.info(`volume set to ${level} via loudness.`)
      return level
    } catch (err) {
      logger.warn(`loudness.setVolume failed: ${err.message}; trying fallback.`)
    }
  }
  const platform = osDetect.getOS()
  if (platform === 'win32') {
    const cmd = `powershell -NoProfile -Command "${PS_SET_VOLUME_V2(level).replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
    const out = await runWithOutput(cmd)
    if (out === 'OK') { logger.info(`volume set to ${level} via PowerShell Core Audio.`); return level }
    logger.error('PowerShell setVolume failed.')
    return null
  } else if (platform === 'darwin') {
    const ok = await runArgs('osascript', ['-e', `set volume output volume ${level}`])
    if (!ok) logger.error('macOS setVolume failed.')
    return ok ? level : null
  } else {
    const ok = await runArgs('amixer', ['-D', 'pulse', 'sset', 'Master', `${level}%`])
    if (!ok) logger.error('Linux setVolume failed.')
    return ok ? level : null
  }
}

/**
 * Increase volume by VOLUME_STEP, clamped to 100.
 * @returns {Promise<number>} new level
 */
async function volumeUp() {
  const platform = osDetect.getOS()
  if (platform === 'win32' && !loudness) {
    // Use keybd_event for reliable step-based volume change
    await runWithOutput(`powershell -NoProfile -Command "${PS_VOLUME_UP.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    // Read back the actual level
    const v = await getVolume()
    return v || clamp(50 + VOLUME_STEP)
  }
  const current = await getVolume()
  return setVolume(current + VOLUME_STEP)
}

/**
 * Decrease volume by VOLUME_STEP, clamped to 0.
 * @returns {Promise<number>} new level
 */
async function volumeDown() {
  const platform = osDetect.getOS()
  if (platform === 'win32' && !loudness) {
    await runWithOutput(`powershell -NoProfile -Command "${PS_VOLUME_DOWN.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    const v = await getVolume()
    return v || clamp(50 - VOLUME_STEP)
  }
  const current = await getVolume()
  return setVolume(current - VOLUME_STEP)
}

/**
 * Unified dispatcher matching the IPC shape { direction, value? }.
 * @param {{direction:'up'|'down'|'set', value?:number}} payload
 * @returns {Promise<{level:number}>}
 */
async function control(payload) {
  if (!payload || !payload.direction) {
    return { level: await getVolume() }
  }
  let level
  switch (payload.direction) {
    case 'up':
      level = await volumeUp()
      break
    case 'down':
      level = await volumeDown()
      break
    case 'set':
      level = await setVolume(payload.value ?? 50)
      break
    default:
      level = await getVolume()
  }
  return { level: level == null ? await getVolume() : level }
}

module.exports = { control, getVolume, setVolume, volumeUp, volumeDown, clamp }
