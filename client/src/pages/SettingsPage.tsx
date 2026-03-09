import { useEffect, useState } from 'react';
import { Check, X, Loader } from 'lucide-react';
import api from '../services/api';

interface ServiceTest {
  status: 'idle' | 'testing' | 'ok' | 'error';
  message?: string;
}

export default function SettingsPage() {
  const [tests, setTests] = useState<Record<string, ServiceTest>>({
    sonarr: { status: 'idle' },
    radarr: { status: 'idle' },
    sabnzbd: { status: 'idle' },
  });

  const testService = async (service: string) => {
    setTests((prev) => ({
      ...prev,
      [service]: { status: 'testing' },
    }));

    try {
      const res = await api.get('/system/status');
      const serviceStatus = res.data.services?.[service];
      setTests((prev) => ({
        ...prev,
        [service]: {
          status: serviceStatus?.status === 'online' ? 'ok' : 'error',
          message:
            serviceStatus?.status === 'online'
              ? 'Connected successfully'
              : `Service returned: ${serviceStatus?.status}`,
        },
      }));
    } catch {
      setTests((prev) => ({
        ...prev,
        [service]: { status: 'error', message: 'Connection failed' },
      }));
    }
  };

  const testAll = () => {
    testService('sonarr');
    testService('radarr');
    testService('sabnzbd');
  };

  useEffect(() => {
    testAll();
  }, []);

  const statusIcon = (test: ServiceTest) => {
    if (test.status === 'testing') return <Loader size={16} className="spinning" />;
    if (test.status === 'ok') return <Check size={16} className="text-success" />;
    if (test.status === 'error') return <X size={16} className="text-danger" />;
    return null;
  };

  return (
    <div className="page">
      <h2>Settings</h2>

      <div className="settings-section">
        <div className="card">
          <h3>Service Connections</h3>
          <p className="placeholder" style={{ marginBottom: '16px' }}>
            Service URLs and API keys are configured in the server's{' '}
            <code>.env</code> file or <code>config.json</code>. Use the test
            buttons below to verify connectivity.
          </p>

          <div className="service-test-list">
            {(['sonarr', 'radarr', 'sabnzbd'] as const).map((service) => (
              <div key={service} className="service-test-row">
                <span className="service-test-name">
                  {service.charAt(0).toUpperCase() + service.slice(1)}
                </span>
                <span className="service-test-status">
                  {statusIcon(tests[service])}
                  <span>{tests[service].message || tests[service].status}</span>
                </span>
                <button
                  className="btn-sm"
                  onClick={() => testService(service)}
                  disabled={tests[service].status === 'testing'}
                >
                  Test
                </button>
              </div>
            ))}
          </div>

          <button
            style={{ marginTop: '16px' }}
            onClick={testAll}
          >
            Test All Connections
          </button>
        </div>

        <div className="card">
          <h3>Configuration Guide</h3>
          <p className="placeholder">
            To configure NGConnect, create a <code>.env</code> file in the
            project root with your service URLs and API keys:
          </p>
          <pre className="config-example">
{`SONARR_URL=http://localhost:8989
SONARR_API_KEY=your_key_here

RADARR_URL=http://localhost:7878
RADARR_API_KEY=your_key_here

SABNZBD_URL=http://localhost:8080
SABNZBD_API_KEY=your_key_here

NZBGEEK_API_KEY=your_key_here`}
          </pre>
          <p className="placeholder" style={{ marginTop: '12px' }}>
            You can find API keys in each service's Settings page.
          </p>
        </div>

        <div className="card">
          <h3>About</h3>
          <div className="detail-list">
            <div className="detail-row">
              <span className="detail-label">NGConnect</span>
              <span className="detail-value">v1.0.0</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Frontend</span>
              <span className="detail-value">React + TypeScript + Vite</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Backend</span>
              <span className="detail-value">Express + TypeScript</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
