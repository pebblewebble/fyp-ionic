import { useState, useCallback, useEffect, useRef } from 'react';
import { BluetoothLe, BleClient } from '@capacitor-community/bluetooth-le';
import Papa from 'papaparse';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

// RXTX Service (used for commands)
const RXTX_SERVICE_UUID = '6e40fff0-b5a3-f393-e0a9-e50e24dcca9e';
const RXTX_WRITE_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const RXTX_NOTIFY_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// MAIN Service (also receives notifications)
const MAIN_SERVICE_UUID = 'de5bf728-d711-4e47-af26-65e3012a5dc7';
const MAIN_NOTIFY_UUID = 'de5bf729-d711-4e47-af26-65e3012a5dc7';

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
      console.log('BleClient.getServices result:', svc);
      return svc;
    } else if ((BluetoothLe as any)?.getServices) {
      // Some versions expose getServices on BluetoothLe
      const svc = await (BluetoothLe as any).getServices({ deviceId });
      console.log('BluetoothLe.getServices result:', svc);
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

export const useRingDataCollector = () => {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [data, setData] = useState<any[]>([]);
  const [isCollecting, setIsCollecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep listener handles so we can remove them on stop/unmount
  const rxtxListenerRef = useRef<any>(null);
  const mainListenerRef = useRef<any>(null);

  const initialize = useCallback(async () => {
    try {
      await BluetoothLe.initialize({ androidNeverForLocation: true });
    } catch (err) {
      setError(`Initialization error: ${String(err)}`);
    }
  }, []);

  const scanAndConnect = useCallback(async () => {
    try {
      console.log('Starting manual scan...');
      setError(null);

      const isEnabled = await BluetoothLe.isEnabled();
      console.log('Bluetooth enabled:', isEnabled);
      if (!isEnabled) {
        await BluetoothLe.enable();
      }

      const scanResults: any[] = [];
      await BluetoothLe.addListener('onScanResult', (result: any) => {
        console.log('Found device:', result.device);
        scanResults.push(result.device);
      });

      await BluetoothLe.requestLEScan({ allowDuplicates: false, scanMode: 2 });
      console.log('Scanning for 10 seconds...');
      await new Promise((resolve) => setTimeout(resolve, 10000));
      await BluetoothLe.stopLEScan();
      console.log('Scan stopped. Found devices:', scanResults);

      const ring = scanResults.find((d) => d.name?.includes('R06'));
      if (!ring) throw new Error(`No R06 ring found. Found ${scanResults.length} devices total`);

      console.log('Connecting to:', ring.name, ring.deviceId);
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
          console.log('Device disconnected:', info.deviceId);
          setIsCollecting(false);
          setDeviceId(null);
        }
      });

      // only now mark device as connected in state
      setDeviceId(ring.deviceId);
      console.log('Connected successfully!');
    } catch (err: any) {
      const errorMsg = `Error: ${err?.message || String(err)}`;
      setError(errorMsg);
      console.error('Full error:', err);
    }
  }, []);

  const handleNotification = (value: DataView, label: string) => {
    const bytes = new Uint8Array(value.buffer);
    const timestamp = Date.now();
    const newEntry: any = {
      timestamp,
      label,
      payload: Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
      accX: '',
      accY: '',
      accZ: '',
      ppg: '',
      ppg_max: '',
      ppg_min: '',
      ppg_diff: '',
      spo2: '',
      spo2_max: '',
      spo2_min: '',
      spo2_diff: '',
    };

    if (bytes[0] === 0xa1) {
      const subtype = bytes[1];
      if (subtype === 0x01) {
        newEntry.spo2 = (bytes[2] << 8) | bytes[3];
        newEntry.spo2_max = bytes[5];
        newEntry.spo2_min = bytes[7];
        newEntry.spo2_diff = bytes[9];
      } else if (subtype === 0x02) {
        newEntry.ppg = (bytes[2] << 8) | bytes[3];
        newEntry.ppg_max = (bytes[4] << 8) | bytes[5];
        newEntry.ppg_min = (bytes[6] << 8) | bytes[7];
        newEntry.ppg_diff = (bytes[8] << 8) | bytes[9];
      } else if (subtype === 0x03) {
        let valX = ((bytes[6] << 4) | (bytes[7] & 0x0f));
        if (valX & 0x0800) valX -= 0x1000;
        newEntry.accX = valX;

        let valY = ((bytes[2] << 4) | (bytes[3] & 0x0f));
        if (valY & 0x0800) valY -= 0x1000;
        newEntry.accY = valY;

        let valZ = ((bytes[4] << 4) | (bytes[5] & 0x0f));
        if (valZ & 0x0800) valZ -= 0x1000;
        newEntry.accZ = valZ;
      }

      if (newEntry.ppg === 0 || newEntry.spo2 === 0) {
        console.log('Skipping data with zero ppg or spo2 values');
        return;
      }

      setData((prev) => [...prev, newEntry]);
      console.log('Received data:', newEntry);
    }
  };

  const startDataCollection = useCallback(
    async (durationSeconds: number = 60, label: string = 'default') => {
      if (!deviceId || isCollecting) return;

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
        rxtxListenerRef.current = await BluetoothLe.addListener(rxtxListenerKey, (result: any) => {
          if (!result?.value) {
            console.log('Received notification with undefined value (RXTX)');
            return;
          }
          let dataView: DataView;
          if (typeof result.value === 'string') {
            // plugin might return base64 string or binary string
            try {
              const binaryString = atob(result.value);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
              dataView = new DataView(bytes.buffer);
            } catch (e) {
              // if atob fails, try hex string
              const hex = result.value as string;
              const arr = new Uint8Array(hex.length / 2);
              for (let i = 0; i < hex.length; i += 2) arr[i / 2] = parseInt(hex.substr(i, 2), 16);
              dataView = new DataView(arr.buffer);
            }
          } else {
            dataView = result.value as DataView;
          }
          handleNotification(dataView, label);
        });

        const mainListenerKey = `notification|${deviceId}|${MAIN_SERVICE_UUID}|${MAIN_NOTIFY_UUID}`;
        mainListenerRef.current = await BluetoothLe.addListener(mainListenerKey, (result: any) => {
          if (!result?.value) {
            console.log('Received notification with undefined value (MAIN)');
            return;
          }
          let dataView: DataView;
          if (typeof result.value === 'string') {
            try {
              const binaryString = atob(result.value);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
              dataView = new DataView(bytes.buffer);
            } catch (e) {
              const hex = result.value as string;
              const arr = new Uint8Array(hex.length / 2);
              for (let i = 0; i < hex.length; i += 2) arr[i / 2] = parseInt(hex.substr(i, 2), 16);
              dataView = new DataView(arr.buffer);
            }
          } else {
            dataView = result.value as DataView;
          }
          handleNotification(dataView, label);
        });

        // Start notifications (only after listeners registered)
        console.log('Starting notifications...');
        try {
          await BluetoothLe.startNotifications({ deviceId, service: RXTX_SERVICE_UUID, characteristic: RXTX_NOTIFY_UUID });
          await BluetoothLe.startNotifications({ deviceId, service: MAIN_SERVICE_UUID, characteristic: MAIN_NOTIFY_UUID });
          console.log('Notifications started');
        } catch (e) {
          console.error('startNotifications error:', e);
          throw e;
        }

        // Send commands to RXTX service using helper that tries BleClient then hex then base64
        console.log('Sending commands...');
        await writeCommand(deviceId, RXTX_SERVICE_UUID, RXTX_WRITE_UUID, BATTERY_CMD);
        await writeCommand(deviceId, RXTX_SERVICE_UUID, RXTX_WRITE_UUID, SET_UNITS_METRICS);
        await writeCommand(deviceId, RXTX_SERVICE_UUID, RXTX_WRITE_UUID, ENABLE_RAW_SENSOR_CMD);
        console.log('Commands sent');

        // Auto-stop after duration
        setTimeout(() => stopDataCollection(), durationSeconds * 1000);
      } catch (err) {
        setError(`Start error: ${String(err)}`);
        setIsCollecting(false);
        console.error('Full error:', err);
      }
    },
    [deviceId, isCollecting]
  );

  const stopDataCollection = useCallback(async () => {
    if (!deviceId || !isCollecting) return;

    try {
      // Send disable command
      await writeCommand(deviceId, RXTX_SERVICE_UUID, RXTX_WRITE_UUID, DISABLE_RAW_SENSOR_CMD);

      // Stop notifications
      try {
        await BluetoothLe.stopNotifications({ deviceId, service: RXTX_SERVICE_UUID, characteristic: RXTX_NOTIFY_UUID });
      } catch (e) {
        console.warn('stopNotifications RXTX failed:', e);
      }
      try {
        await BluetoothLe.stopNotifications({ deviceId, service: MAIN_SERVICE_UUID, characteristic: MAIN_NOTIFY_UUID });
      } catch (e) {
        console.warn('stopNotifications MAIN failed:', e);
      }

      // Remove listeners if present
      try {
        if (rxtxListenerRef.current?.remove) await rxtxListenerRef.current.remove();
      } catch (e) {
        console.warn('Failed to remove rxtx listener:', e);
      }
      try {
        if (mainListenerRef.current?.remove) await mainListenerRef.current.remove();
      } catch (e) {
        console.warn('Failed to remove main listener:', e);
      }

      await saveToCsv();
      try {
        await BluetoothLe.disconnect({ deviceId });
      } catch (e) {
        console.warn('Disconnect failed or already disconnected:', e);
      }

      setDeviceId(null);
      setIsCollecting(false);
      console.log('Stopped and disconnected');
    } catch (err) {
      setError(`Stop error: ${String(err)}`);
      setIsCollecting(false);
      console.error('Stop error full:', err);
    }
  }, [deviceId, isCollecting, data]);

  const saveToCsv = async () => {
    const csv = Papa.unparse(data);
    const fileName = `ring_data_${Date.now()}.csv`;

    try {
      await Filesystem.writeFile({ path: fileName, data: typeof btoa !== 'undefined' ? btoa(csv) : Buffer.from(csv).toString('base64'), directory: Directory.Documents, encoding: Encoding.UTF8 });
      console.log('Saved to', fileName);
    } catch (err) {
      setError(`CSV save error: ${String(err)}`);
    }
  };

  useEffect(() => {
    return () => {
      if (deviceId && isCollecting) {
        stopDataCollection();
      }
    };
  }, [deviceId, isCollecting, stopDataCollection]);

  return {
    initialize,
    scanAndConnect,
    startDataCollection,
    stopDataCollection,
    isCollecting,
    data,
    error,
    deviceId,
  };
};
