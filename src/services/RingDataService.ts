import { useState, useCallback, useEffect, useRef } from 'react';
import { BluetoothLe, BleClient } from '@capacitor-community/bluetooth-le';
import Papa from 'papaparse';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import{
  ForegroundService,
  ServiceType,
  Importance
} from '@capawesome-team/capacitor-android-foreground-service';

// RXTX Service (used for commands)
const RXTX_SERVICE_UUID = '6e40fff0-b5a3-f393-e0a9-e50e24dcca9e';
const RXTX_WRITE_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const RXTX_NOTIFY_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// MAIN Service (also receives notifications)
const MAIN_SERVICE_UUID = 'de5bf728-d711-4e47-af26-65e3012a5dc7';
const MAIN_NOTIFY_UUID = 'de5bf729-d711-4e47-af26-65e3012a5dc7';

const isLikelyHexString = (s: string) => /^[0-9a-fA-F]+$/.test(s) && (s.length % 2 === 0);

const normalizeResultValueToDataView = (value: any): DataView => {
  if (typeof value !== 'string') {
    // Already ArrayBuffer / DataView / plugin-provided shape
    if ((value as any).buffer) return new DataView((value as any).buffer);
    return value as DataView;
  }

  const s = value as string;
  console.log('notification value is string; length=', s.length, 'sample=', s.slice(0, 32));

  // 1) If purely hex-looking string => parse as hex
  if (isLikelyHexString(s)) {
    const arr = new Uint8Array(s.length / 2);
    for (let i = 0; i < s.length; i += 2) {
      arr[i / 2] = parseInt(s.substr(i, 2), 16);
    }
    console.log('Parsed notification as HEX, bytes=', arr.length);
    return new DataView(arr.buffer);
  }

  // 2) Try base64 decode
  try {
    const binaryString = atob(s);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    console.log('Parsed notification as base64, bytes=', bytes.length);
    return new DataView(bytes.buffer);
  } catch (e) {
    console.warn('Base64 decode failed, falling back to hex-like cleanup:', e);
    // last-resort: clean non-hex chars and parse
    const cleaned = s.replace(/[^0-9a-fA-F]/g, '');
    const arr = new Uint8Array(Math.floor(cleaned.length / 2));
    for (let i = 0; i < arr.length * 2; i += 2) arr[i / 2] = parseInt(cleaned.substr(i, 2), 16);
    console.log('Fallback hex-parsed bytes=', arr.length);
    return new DataView(arr.buffer);
  }
};

// Command creation function (port from ring.py)
const createCommand = (hexString: string): Uint8Array => {
  const bytesArray: number[] = [];
  for (let i = 0; i < hexString.length; i += 2) {
    bytesArray.push(parseInt(hexString.substr(i, 2), 16));
  }
  // Pad to 15 bytes
  while (bytesArray.length < 15) {
    bytesArray.push(0);
  }
  // Add checksum
  const checksum = bytesArray.reduce((sum, byte) => sum + byte, 0) & 0xff;
  bytesArray.push(checksum);
  return new Uint8Array(bytesArray);
};

// Commands from ring.py
const BATTERY_CMD = createCommand('03');
const SET_UNITS_METRICS = createCommand('0a0200');
const ENABLE_RAW_SENSOR_CMD = createCommand('a104');
const DISABLE_RAW_SENSOR_CMD = createCommand('a102');

// --- Helpers for conversions and debugging ---
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa !== 'undefined' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
};

const bytesToHex = (bytes: Uint8Array): string => {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const dumpServices = async (deviceId: string) => {
  try {
    if ((BleClient as any)?.getServices) {
      const svc = await (BleClient as any).getServices(deviceId);
      console.info('BleClient.getServices result:', svc);
      return svc;
    } else if ((BluetoothLe as any)?.getServices) {
      // Some versions expose getServices on BluetoothLe
      const svc = await (BluetoothLe as any).getServices({ deviceId });
      console.info('BluetoothLe.getServices result:', svc);
      return svc;
    } else {
      console.warn('No getServices API detected in plugin; skip dump.');
      return null;
    }
  } catch (e) {
    console.error('Failed to dump services:', e);
    return null;
  }
};

const writeCommand = async (
  deviceId: string,
  service: string,
  characteristic: string,
  bytes: Uint8Array
) => {
  // Try BleClient.write (takes DataView) -> then hex string -> then base64 string
  try {
    if ((BleClient as any)?.write) {
      await (BleClient as any).write(deviceId, service, characteristic, new DataView(bytes.buffer));
      return;
    }
  } catch (e) {
    console.warn('BleClient.write failed, will fallback to plugin write:', e);
  }

  // Fallback: try hex string (this matches Android plugin hex parser)
  try {
    await BluetoothLe.write({
      deviceId,
      service,
      characteristic,
      value: bytesToHex(bytes),
    } as any);
    return;
  } catch (e) {
    console.warn('BluetoothLe.write with hex failed, will try base64 fallback:', e);
  }

  // Last resort: try base64 encoding (some platforms expect base64)
  try {
    await BluetoothLe.write({
      deviceId,
      service,
      characteristic,
      value: toBase64(bytes),
    } as any);
    return;
  } catch (e) {
    console.error('All write attempts failed:', e);
    throw e;
  }
};

const ensureForegroundServiceStarted = async (opts?: {
  id?: number;
  title?: string;
  body?: string;
  smallIcon?: string;
  notificationChannelId?: string;
}) => {
  if (Capacitor.getPlatform() !== 'android') return;

  try {
    // create notification channel (id must match update/start calls)
    await ForegroundService.createNotificationChannel({
      id: opts?.notificationChannelId ?? 'default',
      name: 'Background collection',
      description: 'Collecting BLE data in the background',
      importance: Importance.Default,
    });

    // start the foreground service with a small notification + optional serviceType
    await ForegroundService.startForegroundService({
      id: opts?.id ?? 1,
      title: opts?.title ?? 'Ring data collection',
      body: opts?.body ?? 'Collecting data in background',
      smallIcon: opts?.smallIcon ?? 'ic_stat_icon_config_sample',
      notificationChannelId: opts?.notificationChannelId ?? 'default',

      // prefer a connectedDevice type for BLE; plugin exposes ServiceType enum.
      // If your plugin version doesn't support ServiceType.ConnectedDevice,
      // remove this line or pick the closest available ServiceType.
      // serviceType: (ServiceType as any)?.ConnectedDevice ?? (ServiceType as any)?.connectedDevice,
    });
    console.info('[ForegroundService] started');
  } catch (e) {
    console.warn('[ForegroundService] failed to start', e);
  }
};

// Stop foreground service 
const ensureForegroundServiceStopped = async () => {
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    await ForegroundService.stopForegroundService();
    console.info('[ForegroundService] stopped');
  } catch (e) {
    console.warn('[ForegroundService] failed to stop', e);
  }
};

export const useRingDataCollector = () => {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [data, setData] = useState<any[]>([]);
  const [isCollecting, setIsCollecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Batching config
  const UPLOAD_BATCH_SIZE = 50;
  // using this for testing first
  const API_BASE = "http://192.168.1.9:8000";
  const API_TOKEN = "";
  const uploadBufferRef = useRef<any[]>([]);
  const isUploadingRef = useRef(false);
  
  // Keep listener handles so we can remove them on stop/unmount
  const rxtxListenerRef = useRef<any>(null);
  const mainListenerRef = useRef<any>(null);

  // There seems to be multiple listener in one session
  const listenersAddedRef = useRef(false);

  const periodicTimerRef = useRef<number | null>(null); // window.setInterval id
  const periodicRunningRef = useRef(false); // is periodic scheduler active

  const collectionTimeoutRef = useRef<number | null>(null);

  // mirror React state to refs to avoid stale closures
  const isCollectingRef = useRef<boolean>(isCollecting);
  useEffect(() => { isCollectingRef.current = isCollecting; }, [isCollecting]);

  const deviceIdRef = useRef<string | null>(deviceId);
  useEffect(() => { deviceIdRef.current = deviceId; }, [deviceId]);

  const isDeviceConnectedRef = useRef(false);

  const initialize = useCallback(async () => {
    try {
      await BluetoothLe.initialize({ androidNeverForLocation: true });
    } catch (err) {
      setError(`Initialization error: ${String(err)}`);
    }
  }, []);

  const scanAndConnect = useCallback(async () => {
    try {
      console.info('Starting manual scan...');
      setError(null);

      const isEnabled = await BluetoothLe.isEnabled();
      console.info('Bluetooth enabled:', isEnabled);
      if (!isEnabled) {
        await BluetoothLe.enable();
      }

      const scanResults: any[] = [];
      await BluetoothLe.addListener('onScanResult', (result: any) => {
        console.info('Found device:', result.device);
        scanResults.push(result.device);
      });

      await BluetoothLe.requestLEScan({ allowDuplicates: false, scanMode: 2 });
      console.info('Scanning for 10 seconds...');
      await new Promise((resolve) => setTimeout(resolve, 10000));
      await BluetoothLe.stopLEScan();
      console.info('Scan stopped. Found devices:', scanResults);

      const ring = scanResults.find((d) => d.name?.includes('R06'));
      if (!ring) throw new Error(`No R06 ring found. Found ${scanResults.length} devices total`);

      console.info('Connecting to:', ring.name, ring.deviceId);
      // Make sure scanning fully stopped before connecting
      try { await BluetoothLe.stopLEScan(); } catch (e) { /* ignore if already stopped */ }
      await new Promise(resolve => setTimeout(resolve, 200)); // short pause

      // Attempt connect (increase timeout here)
      await BluetoothLe.connect({
        deviceId: ring.deviceId,
        timeout: 20000, // 20s
      });

      BluetoothLe.addListener('onDisconnect', (info: any) => {
        if (info?.deviceId === ring.deviceId) {
          console.info('Device disconnected:', info.deviceId);
          isDeviceConnectedRef.current = false;
          setIsCollecting(false);
          setDeviceId(null);
        }
      });

      isDeviceConnectedRef.current = true;
      // only now mark device as connected in state
      setDeviceId(ring.deviceId);
      console.info('Connected successfully!');
    } catch (err: any) {
      const errorMsg = `Error: ${err?.message || String(err)}`;
      setError(errorMsg);
      console.error('Full error:', err);
    }
  }, []);

  const sendBatchToServer = async(deviceIdForBatch: string | null, labelForBatch: string | null, records: any[])=>{
    if (!records || records.length === 0) return true;
    const payload = {
      device_id: deviceIdForBatch ?? deviceId ?? 'unknown',
      // label: labelForBatch ?? (records[0]?.label ?? null),
      records: records.map(r => ({
        timestamp: new Date(r.timestamp).toISOString(),
        label: r.label,
        payload: r.payload,
        accX: r.accX ?? null,
        accY: r.accY ?? null,
        accZ: r.accZ ?? null,
        ppg: r.ppg ?? null,
        spo2: r.spo2 ?? null,
        meta: r.meta ?? null
      }))
    };

    try{
      const res = await fetch(`${API_BASE}/api/v1/data`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const txt = await res.text().catch(()=>'<no body>');
        console.warn('Batch upload server error', res.status, txt);
        return false;
      }
      console.log('Batch uploaded:', records.length);
      return true;
    }catch(e){
      console.warn("Batch upload failed bruh:",e);
      return false;
    }
  }

  const enqueueRecord = (entry: any) => {
    uploadBufferRef.current.push(entry);
  };

  const flushIfNeeded = async () => {
    if (isUploadingRef.current) return;
    if (uploadBufferRef.current.length >= UPLOAD_BATCH_SIZE) {
      isUploadingRef.current = true;
      const chunk = uploadBufferRef.current.splice(0, UPLOAD_BATCH_SIZE);
      const success = await sendBatchToServer(deviceId ?? null, chunk[0]?.label ?? null, chunk);
      if (!success) {
        // Put failed chunk back to the front
        uploadBufferRef.current = chunk.concat(uploadBufferRef.current);
        console.warn('Requeued chunk after failed upload, buffer length:', uploadBufferRef.current.length);
      }
      isUploadingRef.current = false;
    }
  };

  const handleNotification = (dataView: DataView, label: String) => {
    const bytes = new Uint8Array(dataView.buffer);
    console.log('handleNotification raw bytes:', Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join(' '));

    const timestamp = Date.now();
    const newEntry: any = {
      timestamp,
      label,
      payload: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''),
      accX: null, accY: null, accZ: null,
      ppg: null, ppg_max: null, ppg_min: null, ppg_diff: null,
      spo2: null, spo2_max: null, spo2_min: null, spo2_diff: null
    };

    if (bytes.length === 0) {
      console.warn('Empty notification bytes — ignoring');
      return;
    }

    if (bytes[0] === 0xA1) {
      const subtype = bytes[1];
      if (subtype === 0x01) { // SpO2
        newEntry.spo2 = (bytes[2] << 8) | bytes[3];
        newEntry.spo2_max = bytes[5];
        newEntry.spo2_min = bytes[7];
        newEntry.spo2_diff = bytes[9];
      } else if (subtype === 0x02) { // PPG
        newEntry.ppg = (bytes[2] << 8) | bytes[3];
        newEntry.ppg_max = (bytes[4] << 8) | bytes[5];
        newEntry.ppg_min = (bytes[6] << 8) | bytes[7];
        newEntry.ppg_diff = (bytes[8] << 8) | bytes[9];
      } else if (subtype === 0x03) { // Accel
        let valX = ((bytes[6] << 4) | (bytes[7] & 0x0f));
        if (valX & 0x0800) valX -= 0x1000;
        newEntry.accX = valX;

        let valY = ((bytes[2] << 4) | (bytes[3] & 0x0f));
        if (valY & 0x0800) valY -= 0x1000;
        newEntry.accY = valY;

        let valZ = ((bytes[4] << 4) | (bytes[5] & 0x0f));
        if (valZ & 0x0800) valZ -= 0x1000;
        newEntry.accZ = valZ;
      } else {
        console.log('Unknown subtype', subtype);
      }

      console.log('Parsed entry (pre-skip):', newEntry);

      // temporarily comment out skip to see everything for debugging
      // if (newEntry.ppg === 0 || newEntry.spo2 === 0) { console.log('Skipping zero values'); return; }

      setData(prev => {
        const next = [...prev, newEntry];
        console.log('Appending entry -> new length:', next.length);
        enqueueRecord(newEntry);         
        flushIfNeeded().catch(console.error);
        return next;
      });

      // Optionally show the last entry quickly in console
      // console.log('Latest entry:', newEntry);
    } else {
      console.warn('Unknown packet header:', bytes[0]);
    }
  };

  const startDataCollection = useCallback(
    async (durationSeconds: number = 60, label: string = 'default') => {
      if (!deviceId || isCollecting) return;

      if (!isDeviceConnectedRef.current) {
        setError('Device not connected');
        return;
      }

      // Start foreground service first (Android) so system keeps process alive
      await ensureForegroundServiceStarted({
        id: 1001,
        title: 'Ring collector',
        body: 'Collecting BLE data in background',
        smallIcon: 'ic_stat_icon_config_sample',
        notificationChannelId: 'ring-collector',
      });

      setIsCollecting(true);
      setError(null);
      setData([]);

      try {
        // small delay after connect to allow discovery to complete on some Android devices
        await new Promise((resolve) => setTimeout(resolve, 500));

        // dump services for debugging; inspect console if notifications fail
        await dumpServices(deviceId);

        // Set up notification listeners BEFORE starting notifications
        const rxtxListenerKey = `notification|${deviceId}|${RXTX_SERVICE_UUID}|${RXTX_NOTIFY_UUID}`;

        console.log('Adding listeners? alreadyAdded =', listenersAddedRef.current);

        if(!listenersAddedRef.current){
          listenersAddedRef.current = true;

          rxtxListenerRef.current = await BluetoothLe.addListener(rxtxListenerKey, (result: any) => {
            if (!result?.value) {
              console.info('Received notification with undefined value (RXTX)');
              return;
            }

            // inside the addListener callback (both RXTX and MAIN)
            console.info('RAW notification result.value:', result.value, 'typeof:', typeof result.value);

            const dataView = normalizeResultValueToDataView(result.value);
            console.info('Normalized DataView byteLength=', dataView.byteLength);
            handleNotification(dataView, label);
          });

          const mainListenerKey = `notification|${deviceId}|${MAIN_SERVICE_UUID}|${MAIN_NOTIFY_UUID}`;
          mainListenerRef.current = await BluetoothLe.addListener(mainListenerKey, (result: any) => {
            if (!result?.value) {
              console.info('Received notification with undefined value (MAIN)');
              return;
            }
            const dataView = normalizeResultValueToDataView(result.value);
            handleNotification(dataView, label);
          });
        }else{
          console.log('Listeners alrerady added.');
        }

        

        // Start notifications (only after listeners registered
        console.info('Starting notifications...');
        try {
          await BluetoothLe.startNotifications({ deviceId, service: RXTX_SERVICE_UUID, characteristic: RXTX_NOTIFY_UUID });
          await BluetoothLe.startNotifications({ deviceId, service: MAIN_SERVICE_UUID, characteristic: MAIN_NOTIFY_UUID });
          console.info('Notifications started');
        } catch (e) {
          console.error('startNotifications error:', e);
          throw e;
        }

        // Send commands to RXTX service using helper that tries BleClient then hex then base64
        console.info('Sending commands...');
        await writeCommand(deviceId, RXTX_SERVICE_UUID, RXTX_WRITE_UUID, BATTERY_CMD);
        await writeCommand(deviceId, RXTX_SERVICE_UUID, RXTX_WRITE_UUID, SET_UNITS_METRICS);
        await writeCommand(deviceId, RXTX_SERVICE_UUID, RXTX_WRITE_UUID, ENABLE_RAW_SENSOR_CMD);
        console.info('Commands sent');

        // Auto-stop after duration (store timer so we can cancel if needed)
        if (collectionTimeoutRef.current) {
          clearTimeout(collectionTimeoutRef.current);
          collectionTimeoutRef.current = null;
        }

        collectionTimeoutRef.current = window.setTimeout(() => {
          // clear ref immediately to avoid double-clear races
          collectionTimeoutRef.current = null;
          stopDataCollection().catch((err) => {
            console.error('Error stopping collection from timeout', err);
          });
        }, Math.max(0, durationSeconds) * 1000);
      } catch (err) {
        setError(`Start error: ${String(err)}`);
        setIsCollecting(false);
        console.error('Full error:', err);
        // Stop the foreground service if BLE setup failed
        await ensureForegroundServiceStopped();
      }
    },
    [deviceId, isCollecting]
  );

  const stopDataCollection = useCallback(async () => {
    console.trace('stopRingDataCollection() called');

    // prevent duplicate calls from racing
    // clear any scheduled auto-stop (we're handling stop now)
    if (collectionTimeoutRef.current) {
      clearTimeout(collectionTimeoutRef.current);
      collectionTimeoutRef.current = null;
    }

    try {
      // Send disable command only if there is an active deviceId
      if (deviceId && isDeviceConnectedRef.current) {
        try {
          await writeCommand(deviceId, RXTX_SERVICE_UUID, RXTX_WRITE_UUID, DISABLE_RAW_SENSOR_CMD);
        } catch (e) {
          console.warn('Failed to write disable command (device may be disconnected):', e);
        }
      } else {
        console.info('No deviceId when stopping or the device is not connected — skipping disable command.');
      }

      if (uploadBufferRef.current.length > 0) {
        console.log('Flushing remaining', uploadBufferRef.current.length, 'records before stop');
        while (uploadBufferRef.current.length > 0) {
          const chunk = uploadBufferRef.current.splice(0, UPLOAD_BATCH_SIZE);
          const ok = await sendBatchToServer(deviceId ?? null, chunk[0]?.label ?? null, chunk);
          if (!ok) {
            // push the chunk back and break; we don't want infinite loop
            uploadBufferRef.current.unshift(...chunk);
            console.warn('Upload chunk failed while stopping; requeued chunk');
            break;
          }
        }
      }

      await saveToCsv();

      // Attempt to disconnect
      if (deviceId && isDeviceConnectedRef.current) {
        try {
          await BluetoothLe.disconnect({ deviceId });
          isDeviceConnectedRef.current = false;
        } catch (e) {
          console.warn('Disconnect failed:', e);
        }
      }

      // Clear internal state
      setDeviceId(null);
      setIsCollecting(false);
      console.info('Stopped and disconnected');
    } catch (err) {
      setError(`Stop error: ${String(err)}`);
      setIsCollecting(false);
      console.error('Stop error full:', err);
    } finally {
      // always stop the native foreground service as well
      try {
        await ensureForegroundServiceStopped();
      } catch (e) {
        console.warn('ensureForegroundServiceStopped failed in finally:', e);
      }
    }
  }, [deviceId, data]);

  const saveToCsv = async () => {
    const csv = Papa.unparse(data);
    const fileName = `ring_data_${Date.now()}.csv`;

    try {
      // Write plain UTF-8 CSV (not base64)
      await Filesystem.writeFile({
        path: fileName,
        data: csv,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
      });
      console.info('Saved CSV to Documents directory as', fileName);
      console.info('On Android you can find it at /sdcard/Documents/' + fileName + ' (or check the Files app -> Documents).');
    } catch (err) {
      setError(`CSV save error: ${String(err)}`);
    }
  };

  const startPeriodicCollection = useCallback(
    async (periodMinutes: number = 5, sampleSeconds: number = 10, label: string = 'periodic', autoConnect: boolean = false) => {
      if (periodicRunningRef.current) {
        console.info('Periodic collection already running');
        return;
      }
      periodicRunningRef.current = true;

      // optionally ensure we are connected before starting the first sample
      if (!deviceId && autoConnect) {
        try {
          await scanAndConnect();
          // small delay to let connection settle
          await new Promise((r) => setTimeout(r, 500));
        } catch (e) {
          console.warn('Auto connect failed; periodic samples may be skipped until a device is connected.', e);
        }
      }

      const startSample = async () => {
        if (!deviceId) {
          console.warn('No device connected — skipping periodic sample');
          return;
        }
        if (isCollecting) {
          console.warn('Collection already in progress — skipping this periodic tick');
          return;
        }
        try {
          console.info(`Periodic: starting sample for ${sampleSeconds}s (label=${label})`);
          await startDataCollection(sampleSeconds, label);
        } catch (e) {
          console.error('Periodic: failed to start sample:', e);
        }
      };

      // start an immediate sample, then schedule the interval
      startSample().catch(console.error);

      const periodMs = Math.max(1000, Math.floor(periodMinutes * 60 * 1000));
      periodicTimerRef.current = window.setInterval(() => {
        startSample().catch(console.error);
      }, periodMs) as unknown as number;

      console.info('Periodic collection started. periodMinutes=', periodMinutes, 'sampleSeconds=', sampleSeconds);
    },
    // dependencies: functions/values referenced
    [deviceId, isCollecting, scanAndConnect, startDataCollection]
  );

  const stopPeriodicCollection = useCallback(async () => {
    if (!periodicRunningRef.current && !periodicTimerRef.current) {
      console.info('Periodic collection not running');
      return;
    }
    periodicRunningRef.current = false;
    if (periodicTimerRef.current !== null) {
      clearInterval(periodicTimerRef.current);
      periodicTimerRef.current = null;
    }
    console.info('Periodic collection stopped');
  }, []);

  useEffect(() => {
    // Only cleanup on actual unmount, not on state changes
    return () => {
      console.log('Component unmounting - cleaning up');
      
      // Stop periodic collection synchronously
      if (periodicTimerRef.current !== null) {
        clearInterval(periodicTimerRef.current);
        periodicTimerRef.current = null;
      }
      periodicRunningRef.current = false;

      // Stop collection timeout
      if (collectionTimeoutRef.current) {
        clearTimeout(collectionTimeoutRef.current);
        collectionTimeoutRef.current = null;
      }

      // Disconnect device if still connected (async but don't await)
      if (deviceIdRef.current && isDeviceConnectedRef.current) {
        (async () => {
          try {
            await BluetoothLe.disconnect({ deviceId: deviceIdRef.current! });
            await ensureForegroundServiceStopped();
            console.log('Cleanup: disconnected device');
          } catch (e) {
            console.warn('Cleanup disconnect failed:', e);
          }
        })();
      }
    };
  }, []);

  return {
    initialize,
    scanAndConnect,
    startDataCollection,
    stopDataCollection,
    startPeriodicCollection,
    stopPeriodicCollection,
    isCollecting,
    data,
    error,
    deviceId,
  };
};
