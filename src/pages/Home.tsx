import { IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonList, IonItem, IonLabel } from '@ionic/react';
import { useRingDataCollector } from '../services/RingDataService';
import './Home.css';
import { useEffect } from 'react';
import { useRingData } from '../services/RingDataProvider';

const Home: React.FC = () => {
  console.trace('Component Home mounted; calling useRingDataData');
  const { 
    initialize, 
    scanAndConnect, 
    startDataCollection, 
    stopDataCollection, 
    disconnectDevice,
    startPeriodicCollection,
    stopPeriodicCollection,
    isCollecting, 
    data, 
    error,
    deviceId  // Add this to destructuring
  } = useRingData();

  // Initialize on mount
  useEffect(() => {
    initialize();
  }, [initialize]);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Ring Data Collector</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <IonButton 
          onClick={scanAndConnect} 
          disabled={!!deviceId}
          expand="block"
        >
          {deviceId ? 'Connected' : 'Scan and Connect'}
        </IonButton>
        
        <IonButton 
          onClick={() => startDataCollection(60, 'walking')} 
          disabled={!deviceId || isCollecting}
          expand="block"
        >
          Start Collection (60s)
        </IonButton>

        <IonButton 
          onClick={() => startPeriodicCollection(1,10, 'walking',false)} 
          disabled={!deviceId || isCollecting}
          expand="block"
        >
          Start Periodic Collection 
        </IonButton>

        <IonButton 
          onClick={stopPeriodicCollection} 
          disabled={!isCollecting}
          expand="block"
          color="danger"
        >
          Stop Collection
        </IonButton>
        
        <IonButton 
          onClick={stopDataCollection} 
          disabled={!isCollecting}
          expand="block"
          color="danger"
        >
          Stop Collection
        </IonButton>

        {error && (
          <IonItem color="danger">
            <IonLabel>Error: {error}</IonLabel>
          </IonItem>
        )}

        <IonItem>
          <IonLabel>
            <h2>Status</h2>
            <p>Device: {deviceId || 'Not connected'}</p>
            <p>Collecting: {isCollecting ? 'Yes' : 'No'}</p>
            <p>Data points: {data.length}</p>
          </IonLabel>
        </IonItem>

        <IonList>
          <IonItem>
            <IonLabel><h2>Collected Data</h2></IonLabel>
          </IonItem>
          {data.slice(-10).reverse().map((entry, index) => (
            <IonItem key={index}>
              <IonLabel>
                <h3>Label: {entry.label}</h3>
                <p>Time: {new Date(entry.timestamp).toLocaleTimeString()}</p>
                <p>HR: {entry.hr || 'N/A'} | AccX: {entry.accX?.toFixed(2) || 'N/A'} | AccY: {entry.accY?.toFixed(2) || 'N/A'} | AccZ: {entry.accZ?.toFixed(2) || 'N/A'}</p>
                <p>PPG: {entry.ppg || 'N/A'} | SpO2: {entry.spo2 || 'N/A'}%</p>
                <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', background:'#111', color:'#fff', padding:8 }}>
                  {JSON.stringify(data?.slice(-10) ?? [], null, 2)}
                </pre>
              </IonLabel>
            </IonItem>
          ))}
        </IonList>
      </IonContent>
    </IonPage>
  );
};

export default Home;