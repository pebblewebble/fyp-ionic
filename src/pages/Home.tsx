import React, { useEffect, useState } from 'react';
import { 
  IonContent, IonPage, IonCard, IonGrid, IonRow, IonCol, 
  IonIcon, IonText, IonHeader, IonToolbar, IonTitle, 
  IonToggle, IonItem, IonLabel, IonButton, IonButtons 
} from '@ionic/react';
import { 
  heart, pulse, speedometer, bluetooth, 
  analytics, listOutline, stopCircleOutline, playCircleOutline 
} from 'ionicons/icons';
import './Home.css'; 
import { useRingData } from '../services/RingDataProvider';


const Home: React.FC = () => {
  console.trace('Component Home mounted; calling useRingDataData');
  
  // 1. Destructure your existing logic
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
    deviceId
  } = useRingData();

  // 2. New State for UI Mode (Wellness vs Science)
  const [isScientific, setIsScientific] = useState(false);

  // Initialize on mount
  useEffect(() => {
    initialize();
  }, [initialize]);

  return (
    <IonPage>
      {/* HEADER: Dark with Teal Toggle */}
      <IonHeader className="ion-no-border">
        <IonToolbar style={{ '--background': '#121212', '--color': '#fff' }}>
          <IonTitle>Ring Data</IonTitle>
          <IonButtons slot="end">
            <IonItem lines="none" style={{ '--background': 'transparent', '--color': '#fff' }}>
              <IonLabel style={{ fontSize: '0.7rem', color: '#B3B3B3', marginRight: 10 }}>
                {isScientific ? 'DEV MODE' : 'WELLNESS'}
              </IonLabel>
              <IonToggle 
                checked={isScientific} 
                onIonChange={e => setIsScientific(e.detail.checked)}
                style={{ '--handle-background-checked': '#1DB954' }}
              />
            </IonItem>
          </IonButtons>
        </IonToolbar>
      </IonHeader>

      <IonContent fullscreen className="ion-padding">
        
        {/* === SECTION 1: STATUS & CONTROLS === */}
        <div className="control-panel">
            {/* Status Badges */}
            <div style={{ marginBottom: 16 }}>
                <span className={`status-badge ${deviceId ? 'active' : ''}`}>
                    <IonIcon icon={bluetooth} style={{verticalAlign: 'middle', marginRight: 4}}/>
                    {deviceId ? 'Connected' : 'Disconnected'}
                </span>
                <span className={`status-badge ${isCollecting ? 'active' : ''}`}>
                    {isCollecting ? 'Collecting Data' : 'Idle'}
                </span>
                <span className="status-badge">
                    Points: {data.length}
                </span>
            </div>

            {/* Error Message Display */}
            {error && (
               <div style={{ color: '#ff4d4d', fontSize: '12px', marginBottom: 10, background: 'rgba(255,0,0,0.1)', padding: 8, borderRadius: 8 }}>
                  Error: {error}
               </div>
            )}

            {/* Connection Button */}
            <IonButton 
                onClick={scanAndConnect} 
                disabled={!!deviceId}
                expand="block"
                color={deviceId ? "medium" : "success"}
                className="ion-margin-bottom"
            >
                {deviceId ? 'Device Linked' : 'Scan & Connect'}
            </IonButton>
            
            {/* Action Grid */}
            <IonGrid style={{ padding: 0 }}>
                <IonRow>
                    <IonCol>
                        <IonButton 
                            onClick={() => startDataCollection(60, 'walking')} 
                            disabled={!deviceId || isCollecting}
                            expand="block" size="small" fill="outline" 
                        >
                            <IonIcon icon={playCircleOutline} slot="start" />
                            60s Test
                        </IonButton>
                    </IonCol>
                    <IonCol>
                         <IonButton 
                            onClick={() => startPeriodicCollection(1,10, 'walking',false)} 
                            disabled={!deviceId || isCollecting}
                            expand="block" size="small" fill="outline" 
                        >
                            <IonIcon icon={listOutline} slot="start" />
                            Periodic
                        </IonButton>
                    </IonCol>
                </IonRow>
                <IonRow>
                    <IonCol>
                         <IonButton 
                            onClick={stopDataCollection} 
                            disabled={!isCollecting}
                            expand="block" size="small" color="danger"
                        >
                            <IonIcon icon={stopCircleOutline} slot="start" />
                            Stop All
                        </IonButton>
                    </IonCol>
                </IonRow>
            </IonGrid>
        </div>

        {/* === SECTION 2: THE DATA FEED === */}
        <IonText color="medium" style={{ marginLeft: 16, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Live Feed
        </IonText>

        {data.slice(-10).reverse().map((entry: { hr: any; timestamp:  string; spo2: any; accX: number; accY: number; accZ: number; }, index: React.Key | null | undefined) => (
          <IonCard key={entry.timestamp} className="biometric-card">
            
            {/* --- MODE A: WELLNESS COMPANION --- */}
            {!isScientific && (
              <>
                <div className="hero-section">
                  <div className="hero-icon">
                    <IonIcon icon={heart} />
                  </div>
                  <div>
                    <div className="hero-label">Heart Rate</div>
                    <div className="hero-value">
                      {entry.hr || '--'} <span style={{fontSize: '16px', color:'#555'}}>BPM</span>
                    </div>
                  </div>
                  <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                     <IonText color="medium" style={{ fontSize: '12px' }}>
                       {new Date(entry.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}
                     </IonText>
                  </div>
                </div>

                <IonGrid className="secondary-grid">
                  <IonRow>
                    <IonCol size="6">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <IonIcon icon={pulse} style={{ color: '#B3B3B3' }} />
                        <div>
                          <div style={{ fontSize: '11px', color: '#B3B3B3' }}>SpO2</div>
                          <div style={{ fontWeight: '600', color: '#fff' }}>{entry.spo2 || '--'}%</div>
                        </div>
                      </div>
                    </IonCol>
                    <IonCol size="6">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <IonIcon icon={speedometer} style={{ color: '#B3B3B3' }} />
                        <div>
                          <div style={{ fontSize: '11px', color: '#B3B3B3' }}>Motion</div>
                          <div style={{ fontWeight: '600', color: '#fff' }}>
                             {/* Simple logic: if AccX/Y is high, assume active */}
                             {(Math.abs(entry.accX || 0) > 1.2 || Math.abs(entry.accY || 0) > 1.2) ? 'Active' : 'Steady'}
                          </div>
                        </div>
                      </div>
                    </IonCol>
                  </IonRow>
                </IonGrid>
              </>
            )}

            {/* --- MODE B: SCIENTIFIC INSTRUMENT --- */}
            {isScientific && (
              <>
                <div className="science-header">
                    <div>
                        <IonIcon icon={analytics} style={{ marginRight: '8px', color: 'var(--accent-teal)' }} />
                        <span style={{ fontFamily: 'monospace', fontWeight: 'bold', color: '#fff' }}>DATA_POINT</span>
                    </div>
                    <span style={{ fontFamily: 'monospace', color: '#666', fontSize: '12px' }}>
                        {new Date(entry.timestamp).toISOString().split('T')[1].split('.')[0]}
                    </span>
                </div>

                <div className="science-row">
                    <span className="science-label">HR_RAW</span>
                    <span>{entry.hr || 'NULL'}</span>
                </div>
                <div className="science-row">
                    <span className="science-label">OXYGEN</span>
                    <span>{entry.spo2 || 'NULL'} %</span>
                </div>
                <div className="science-row">
                    <span className="science-label">ACCEL_X</span>
                    <span>{entry.accX?.toFixed(4) || '0.0000'}</span>
                </div>
                <div className="science-row">
                    <span className="science-label">ACCEL_Y</span>
                    <span>{entry.accY?.toFixed(4) || '0.0000'}</span>
                </div>
                <div className="science-row">
                    <span className="science-label">ACCEL_Z</span>
                    <span>{entry.accZ?.toFixed(4) || '0.0000'}</span>
                </div>
                
                {/* Note: In scientific mode, we show the raw entry JSON properly formatted */}
                <div style={{ background: '#000', padding: '10px', marginTop: '5px', overflowX: 'auto' }}>
                    <pre style={{ color: '#00ff00', fontSize: '10px', margin: 0 }}>
                        {JSON.stringify(entry, null, 2)}
                    </pre>
                </div>
              </>
            )}

          </IonCard>
        ))}
        
        {data.length === 0 && (
            <div style={{ textAlign: 'center', marginTop: '50px', color: '#333' }}>
                <IonIcon icon={listOutline} style={{ fontSize: '48px', opacity: 0.2 }} />
                <p>No data collected yet</p>
            </div>
        )}

      </IonContent>
    </IonPage>
  );
};

export default Home;