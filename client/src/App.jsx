import React, { useState, useEffect } from 'react';
import { LayoutDashboard, Network, Database, Settings, Activity, Bot } from 'lucide-react';
import Dashboard from './components/Dashboard';
import Clusters from './components/Clusters';
import DataExplorer from './components/DataExplorer';

import Chat from './components/Chat';

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [status, setStatus] = useState(null);
  const [clustersData, setClustersData] = useState(null);

  useEffect(() => {
    // Fetch initial status and cluster data
    fetch('http://localhost:3001/api/status')
      .then(res => res.json())
      .then(data => setStatus(data))
      .catch(err => console.error("Error fetching status:", err));

    fetch('http://localhost:3001/api/clusters')
      .then(res => res.json())
      .then(data => setClustersData(data))
      .catch(err => console.error("Error fetching clusters:", err));
  }, []);

  const renderContent = () => {
    if (activeTab === 'dashboard') return <Dashboard status={status} clustersData={clustersData} />;
    if (activeTab === 'clusters') return <Clusters clustersData={clustersData} />;
    if (activeTab === 'explorer') return <DataExplorer />;
    if (activeTab === 'chat') return <Chat />;
    return null;
  };

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div style={{ padding: '1rem', marginBottom: '1.5rem' }}>
          <h2 className="text-gradient" style={{ fontSize: '1.2rem', marginBottom: '0.2rem' }}>
            Retrieval Discovery
          </h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Google Photos Analysis
          </p>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button 
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutDashboard size={18} />
            Executive Summary
          </button>
          
          <button 
            className={`nav-item ${activeTab === 'clusters' ? 'active' : ''}`}
            onClick={() => setActiveTab('clusters')}
          >
            <Network size={18} />
            Opportunity Clusters
          </button>
          
          <button 
            className={`nav-item ${activeTab === 'explorer' ? 'active' : ''}`}
            onClick={() => setActiveTab('explorer')}
          >
            <Database size={18} />
            Data Explorer
          </button>
          
          <button 
            className={`nav-item ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            <Bot size={18} />
            Ask AI
          </button>
        </nav>

        <div style={{ marginTop: 'auto', padding: '1rem' }}>
          <div className="glass-panel" style={{ padding: '1rem', fontSize: '0.85rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <Activity size={16} color="var(--brand-tertiary)" />
              <strong style={{ color: 'var(--text-secondary)' }}>Pipeline Status</strong>
            </div>
            {status ? (
              <>
                <p>Status: <span style={{ color: status.status === 'success' ? '#14b8a6' : '#ec4899' }}>{status.status}</span></p>
                <p>Records: {status.extracted_records}</p>
                <p style={{ fontSize: '0.75rem', marginTop: '0.5rem', color: 'var(--text-muted)' }}>
                  Last run: {new Date(status.last_run).toLocaleDateString()}
                </p>
              </>
            ) : (
              <p>Loading...</p>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        {renderContent()}
      </main>
    </div>
  );
}

export default App;
