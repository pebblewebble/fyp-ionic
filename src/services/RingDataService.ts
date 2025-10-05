import { useState, useCallback, useEffect } from 'react';
import { BluetoothLe } from '@capacitor-community/bluetooth-le';
import Papa from 'papaparse';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

const SERVICE_UUID = '6e40fff0-b5a3-f393-e0a9-e50e24dcca9e';
const WRITE_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NOTIFY_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

export const useRingDataCollector = () => {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [data, setData] = useState<any[]>([]); // { timestamp, accX, accY, accZ, ppg, spo2, hr, label, ... }
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
      await BluetoothLe.requestLEScan({ namePrefix: 'R02' });

      const device = await BluetoothLe.requestDevice({ services: [SERVICE_UUID] });
      setDeviceId(device.deviceId);
      await BluetoothLe.connect({ deviceId: device.deviceId });
      console.log('Connected to ring');
    } catch (err) {
      setError(`Scan/Connect error: ${err}`);
    }
  }, []);

  const handleNotification = (value: DataView, label: string) => {
    const bytes = new Uint8Array(value.buffer);
    const timestamp = Date.now();
    let newEntry: any = { timestamp, label };

    // Port parsing from ring.py's on_notification callback
    // Adjust based on command ID (bytes[0]) and struct.unpack patterns
    if (bytes[0] === 30) { // Example: HR/PPG response
      newEntry.hr = bytes[1]; // Simple uint8 for HR
      // Add PPG if present, e.g., newEntry.ppg = value.getUint32(2, false);
    } else if (bytes[0] === 115) { // Example: Accel + PPG + SpO2 (adjust offsets and formats)
      newEntry.accX = value.getFloat32(1, false); // Big-endian
      newEntry.accY = value.getFloat32(5, false);
      newEntry.accZ = value.getFloat32(9, false);
      newEntry.ppg = value.getUint32(13, false);
      newEntry.spo2 = bytes[17]; // Assume uint8 percentage
    } // Add more cases for other IDs as per the Python script

    setData((prev) => [...prev, newEntry]);
    console.log('Received data:', newEntry);
  };

  const stopDataCollection = useCallback(async () => {
    if (!deviceId || !isCollecting) return;

    try {
      // Send stop command (port from Python, e.g., ID 105, DataType 6, action 4)
      const stopCommand = new Uint8Array([105, 6, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (105 + 6 + 4) & 0xFF]);
      await BluetoothLe.write({
        deviceId,
        service: SERVICE_UUID,
        characteristic: WRITE_UUID,
        value: new DataView(stopCommand.buffer),
      });

      await BluetoothLe.stopNotifications({
        deviceId,
        service: SERVICE_UUID,
        characteristic: NOTIFY_UUID,
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
  }, [deviceId, isCollecting]);

  const startDataCollection = useCallback(async (durationSeconds: number = 60, label: string = 'default') => {
    if (!deviceId || isCollecting) return;

    setIsCollecting(true);
    setError(null);
    setData([]); // Reset data

    try {
        // Set up notification listener BEFORE starting notifications
        await BluetoothLe.addListener(
        `notification|${deviceId}|${SERVICE_UUID}|${NOTIFY_UUID}`,
        (result) => {
            if (result.value) {
            // Convert to DataView if it's a string (base64)
            let dataView: DataView;
            if (typeof result.value === 'string') {
                // Decode base64 string to ArrayBuffer
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
        }
        );

        // Enable notifications (no callback parameter)
        await BluetoothLe.startNotifications({
        deviceId,
        service: SERVICE_UUID,
        characteristic: NOTIFY_UUID,
        });

        // Send command to enable streaming
        const enableCommand = new Uint8Array([30, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (30 + 3) & 0xFF]);
        await BluetoothLe.write({
        deviceId,
        service: SERVICE_UUID,
        characteristic: WRITE_UUID,
        value: new DataView(enableCommand.buffer),
        });
        console.log('Streaming enabled');

        // Auto-stop after duration
        setTimeout(() => stopDataCollection(), durationSeconds * 1000);
    } catch (err) {
        setError(`Start error: ${err}`);
        setIsCollecting(false);
    }
    }, [deviceId, isCollecting, stopDataCollection]);

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