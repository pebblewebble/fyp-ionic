import { useState, useCallback, useEffect } from 'react';
import { BluetoothLe } from '@capacitor-community/bluetooth-le';
import Papa from 'papaparse';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

// RXTX Service (used for commands)
const RXTX_SERVICE_UUID = '6e40fff0-b5a3-f393-e0a9-e50e24dcca9e';
const RXTX_WRITE_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const RXTX_NOTIFY_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// MAIN Service (also receives notifications)
const MAIN_SERVICE_UUID = 'de5bf728-d711-4e47-af26-65e3012a5dc7';
const MAIN_NOTIFY_UUID = 'de5bf729-d711-4e47-af26-65e3012a5dc7';

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
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
  const checksum = bytesArray.reduce((sum, byte) => sum + byte, 0) & 0xFF;
  bytesArray.push(checksum);
  return new Uint8Array(bytesArray);
};

// Commands from ring.py
const BATTERY_CMD = createCommand('03');
const SET_UNITS_METRICS = createCommand('0a0200');
const ENABLE_RAW_SENSOR_CMD = createCommand('a104');
const DISABLE_RAW_SENSOR_CMD = createCommand('a102');

export const useRingDataCollector = () => {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [data, setData] = useState<any[]>([]); // { timestamp, payload, accX, accY, accZ, ppg, ppg_max, ppg_min, ppg_diff, spo2, spo2_max, spo2_min, spo2_diff, label }
  const [isCollecting, setIsCollecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialize = useCallback(async () => {
    try {
      await BluetoothLe.initialize({ androidNeverForLocation: true });
    } catch (err) {
      setError(`Initialization error: ${err}`);
    }
  }, []);

  const scanAndConnect = useCallback(async () => {
    try {
      console.log('Starting manual scan...');
      setError(null);
      
      // Step 1: Check Bluetooth is enabled
      const isEnabled = await BluetoothLe.isEnabled();
      console.log('Bluetooth enabled:', isEnabled);
      
      if (!isEnabled) {
        await BluetoothLe.enable();
      }
      
      // Step 2: Set up scan listener BEFORE starting scan
      const scanResults: any[] = [];
      
      await BluetoothLe.addListener('onScanResult', (result) => {
        console.log('Found device:', result.device);
        scanResults.push(result.device);
        
        // If we find the ring, we can stop scanning immediately
        if (result.device.name?.includes('R06')) {
          console.log('Found R06 ring!');
        }
      });
      
      // Step 3: Start scanning manually
      await BluetoothLe.requestLEScan({
        allowDuplicates: false,
        scanMode: 2, // Low latency
      });
      
      console.log('Scanning for 10 seconds...');
      
      // Step 4: Wait for scan results
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      // Step 5: Stop scan
      await BluetoothLe.stopLEScan();
      console.log('Scan stopped. Found devices:', scanResults);
      
      // Step 6: Find and connect to ring
      const ring = scanResults.find(d => d.name?.includes('R06'));
      
      if (!ring) {
        throw new Error(`No R06 ring found. Found ${scanResults.length} devices total`);
      }
      
      console.log('Connecting to:', ring.name, ring.deviceId);
      setDeviceId(ring.deviceId);
      
      await BluetoothLe.connect({ 
        deviceId: ring.deviceId,
        timeout: 10000
      });
      
      console.log('Connected successfully!');
      
    } catch (err: any) {
      const errorMsg = `Error: ${err?.message || err}`;
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
      payload: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''),
      accX: '', accY: '', accZ: '',
      ppg: '', ppg_max: '', ppg_min: '', ppg_diff: '',
      spo2: '', spo2_max: '', spo2_min: '', spo2_diff: ''
    };

    // Port parsing from ring.py's handle_notification
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
        let valX = ((bytes[6] << 4) | (bytes[7] & 0x0F));
        if (valX & 0x0800) valX -= 0x1000;
        newEntry.accX = valX;

        let valY = ((bytes[2] << 4) | (bytes[3] & 0x0F));
        if (valY & 0x0800) valY -= 0x1000;
        newEntry.accY = valY;

        let valZ = ((bytes[4] << 4) | (bytes[5] & 0x0F));
        if (valZ & 0x0800) valZ -= 0x1000;
        newEntry.accZ = valZ;
      }

      // Optional: Skip if ppg or spo2 is 0 (as in Python, but adjusted for types)
      if (newEntry.ppg === 0 || newEntry.spo2 === 0) {
        console.log('Skipping data with zero ppg or spo2 values');
        return;
      }

      setData((prev) => [...prev, newEntry]);
      console.log('Received data:', newEntry);
    }
  };

  const startDataCollection = useCallback(async (durationSeconds: number = 60, label: string = 'default') => {
    if (!deviceId || isCollecting) return;

    setIsCollecting(true);
    setError(null);
    setData([]); // Reset data

    try {
      // Note: Removed discoverServices as it was timing out. 
      // Assuming the plugin can access characteristics without explicit discovery after connect.
      // If issues persist, consider debugging the plugin or device compatibility.

      // Small delay after connect
      await new Promise(resolve => setTimeout(resolve, 500));

      // Set up notification listeners BEFORE starting notifications
      const rxtxListenerKey = `notification|${deviceId}|${RXTX_SERVICE_UUID}|${RXTX_NOTIFY_UUID}`;
      await BluetoothLe.addListener(
        rxtxListenerKey,
        (result) => {
          if (!result.value) {
            console.log('Received notification with undefined value');
            return;
          }
          let dataView: DataView;
          if (typeof result.value === 'string') {
            const binaryString = atob(result.value);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            dataView = new DataView(bytes.buffer);
          } else {
            dataView = result.value;
          }
          handleNotification(dataView, label);
        }
      );

      const mainListenerKey = `notification|${deviceId}|${MAIN_SERVICE_UUID}|${MAIN_NOTIFY_UUID}`;
      await BluetoothLe.addListener(
        mainListenerKey,
        (result) => {
          if (!result.value) {
            console.log('Received notification with undefined value');
            return;
          }
          let dataView: DataView;
          if (typeof result.value === 'string') {
            const binaryString = atob(result.value);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            dataView = new DataView(bytes.buffer);
          } else {
            dataView = result.value;
          }
          handleNotification(dataView, label);
        }
      );

      // Enable notifications on both services
      console.log('Starting notifications...');
      await BluetoothLe.startNotifications({
        deviceId,
        service: RXTX_SERVICE_UUID,
        characteristic: RXTX_NOTIFY_UUID,
      });
      await BluetoothLe.startNotifications({
        deviceId,
        service: MAIN_SERVICE_UUID,
        characteristic: MAIN_NOTIFY_UUID,
      });
      console.log('Notifications started');

      // Send commands to RXTX service
      console.log('Sending commands...');
      await BluetoothLe.write({
        deviceId,
        service: RXTX_SERVICE_UUID,
        characteristic: RXTX_WRITE_UUID,
        value: new DataView(BATTERY_CMD.buffer),
      });
      await BluetoothLe.write({
        deviceId,
        service: RXTX_SERVICE_UUID,
        characteristic: RXTX_WRITE_UUID,
        value: new DataView(SET_UNITS_METRICS.buffer),
      });
      await BluetoothLe.write({
        deviceId,
        service: RXTX_SERVICE_UUID,
        characteristic: RXTX_WRITE_UUID,
        value: new DataView(ENABLE_RAW_SENSOR_CMD.buffer),
      });
      console.log('Commands sent');

      // Auto-stop after duration
      setTimeout(() => stopDataCollection(), durationSeconds * 1000);
    } catch (err) {
      setError(`Start error: ${err}`);
      setIsCollecting(false);
      console.error('Full error:', err);
    }
  }, [deviceId, isCollecting]);

  const stopDataCollection = useCallback(async () => {
    if (!deviceId || !isCollecting) return;

    try {
      // Send disable command
      await BluetoothLe.write({
        deviceId,
        service: RXTX_SERVICE_UUID,
        characteristic: RXTX_WRITE_UUID,
        value: new DataView(DISABLE_RAW_SENSOR_CMD.buffer),
      });

      // Stop notifications
      await BluetoothLe.stopNotifications({
        deviceId,
        service: RXTX_SERVICE_UUID,
        characteristic: RXTX_NOTIFY_UUID,
      });
      await BluetoothLe.stopNotifications({
        deviceId,
        service: MAIN_SERVICE_UUID,
        characteristic: MAIN_NOTIFY_UUID,
      });

      await saveToCsv();
      await BluetoothLe.disconnect({ deviceId });
      setDeviceId(null);
      setIsCollecting(false);
      console.log('Stopped and disconnected');
    } catch (err) {
      setError(`Stop error: ${err}`);
      setIsCollecting(false);
    }
  }, [deviceId, isCollecting, data]);

  const saveToCsv = async () => {
    const csv = Papa.unparse(data);
    const fileName = `ring_data_${Date.now()}.csv`;

    try {
      await Filesystem.writeFile({
        path: fileName,
        data: btoa(csv), // Base64 encode for safety
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
      });
      console.log('Saved to', fileName);
    } catch (err) {
      setError(`CSV save error: ${err}`);
    }
  };

  // Cleanup on unmount
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
    deviceId
  };
};